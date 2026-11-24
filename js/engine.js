/**
 * engine.js —— Three.js 场景 / 相机 / 灯光 / 渲染循环
 *
 * 职责：把 MapData “解析数据 → 生成对象”，并把物理状态（纯数据）同步到可视对象。
 * 本文件不包含任何地图元素的位置、颜色、数量；下面的 RENDER_CONFIG 只是通用渲染风格参数。
 *
 * 视觉管线：
 *   - 渐变天空球（materials.js）+ FogExp2，雾色 = 地平线色，远处自然融入天空
 *   - 半球光 + 带柔和阴影（PCFSoft）的主方向光，阴影相机跟随无人机并对齐纹素网格
 *   - 全部 PBR（MeshStandardMaterial / flatShading），天空烘焙成 PMREM 环境贴图提供反射
 *   - ACES 色调映射；地图色板（meta.palette）决定天空 / 雾 / 灯光颜色
 */

import * as THREE from "three";
import {
    createLook,
    createStandardMaterial,
    createSky,
    applySkyLook,
    renderEnvironment,
} from "./materials.js";
import { buildFlatTerrain, createLayout } from "./terrain.js";
import { buildDecorations } from "./decorations.js";

/** 触屏设备（手机 / 平板）：降低像素比、阴影贴图与地面纹理尺寸以保证 30fps+ */
const IS_MOBILE = window.matchMedia("(pointer: coarse)").matches;

const RENDER_CONFIG = {
    maxPixelRatio: IS_MOBILE ? 1.5 : 2,
    exposure: 1.0, // ACES 曝光
    fog: { density: 0.0026 }, // FogExp2 默认密度，地图可用 meta.fogDensity 覆盖
    camera: {
        fov: 65,
        near: 0.1,
        far: 1500,
        distance: 6.5, // 跟随距离（m）
        height: 2.2, // 相机相对无人机高度（m）
        lookHeight: 0.4,
        lookAhead: 2.5,
        minHeightAboveGround: 0.4,
        positionSharpness: 4.0, // 位置指数平滑速率（1/s）
        yawSharpness: 2.2, // 朝向指数平滑速率（1/s），越小转向摆动感越强
        lookSharpness: 9.0,
    },
    shake: { maxOffset: 0.35, decay: 6 },
    lights: {
        hemiIntensity: 0.85,
        sunIntensity: 2.4,
    },
    sun: {
        offset: [40, 55, -60], // 相对无人机的主光位置（决定太阳方向与阴影长度）
        shadowRange: IS_MOBILE ? 100 : 140, // 阴影相机半宽（m）
        mapSize: IS_MOBILE ? 1024 : 2048,
        shadowFar: 320,
    },
    rotor: {
        idleSpeed: 25,
        maxSpeed: 160,
        spinUp: 6,
        blurStart: 30,
        blurFull: 90,
    },
    checkpoint: { tube: 0.4, emissiveIntensity: 1.2 },
    emissive: { pulse: 0.15, speed: 2.4 }, // 自发光物体的呼吸幅度 / 速度
    droneModelLift: -0.2, // 模型相对物理中心下移，使静止时起落架贴地（包围球半径 0.5）
};

/* ------------------------------------------------------------------ */
/* 地图对象构建器（按 MapData 数据生成）                                */
/* ------------------------------------------------------------------ */

const GEOMETRY_BUILDERS = {
    box: ([w, h, d]) => new THREE.BoxGeometry(w, h, d),
    cylinder: ([r, h]) => new THREE.CylinderGeometry(r, r, h, 14), // 低分段 + flatShading = 低多边形柱体
    torus: ([R, t]) => new THREE.TorusGeometry(R, t, 16, 64), // 默认位于 XY 平面：竖立、面向 +Z
};

const TERRAIN_BUILDERS = {
    flat: buildFlatTerrain,
    // 未来：heightmap: buildHeightmapTerrain,
};

function createBoundsOutline(bounds, getGroundHeight, look) {
    const [x0, x1] = bounds.x;
    const [z0, z1] = bounds.z;
    const pts = [
        [x0, z0],
        [x1, z0],
        [x1, z1],
        [x0, z1],
    ].map(([x, z]) => new THREE.Vector3(x, getGroundHeight(x, z) + 0.05, z));

    return new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({
            color: look.colors.accent,
            transparent: true,
            opacity: 0.55,
        }),
    );
}

function buildMapObject(obj, emissives) {
    const builder = GEOMETRY_BUILDERS[obj.type];
    if (!builder)
        throw new Error(`渲染器不支持的物体类型：${obj.type}`);

    const material = createStandardMaterial(obj.color, {
        roughness: obj.roughness ?? 0.85,
        metalness: obj.metalness ?? 0,
        emissive: obj.emissive,
        emissiveIntensity: obj.emissiveIntensity,
    });

    if (obj.emissive)
        emissives.push({ material, base: obj.emissiveIntensity });

    const mesh = new THREE.Mesh(builder(obj.size), material);

    mesh.position.set(obj.position.x, obj.position.y, obj.position.z);
    mesh.rotation.set(obj.rotation.x, obj.rotation.y, obj.rotation.z); // XYZ 顺序，与解析器 AABB 计算一致
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    return mesh;
}

function buildCheckpoint(cp, look) {
    const C = RENDER_CONFIG.checkpoint;
    const color = look.colors.checkpoint;
    const mesh = new THREE.Mesh(
        new THREE.TorusGeometry(cp.radius, C.tube, 16, 72),
        createStandardMaterial(color, {
            roughness: 0.3,
            metalness: 0.1,
            emissive: color,
            emissiveIntensity: C.emissiveIntensity,
            flatShading: false,
            envMapIntensity: 0.6,
        }),
    );
    mesh.position.set(cp.position.x, cp.position.y, cp.position.z);
    return mesh;
}

/* ------------------------------------------------------------------ */
/* 无人机模型（全部由基本几何体生成）                                    */
/* ------------------------------------------------------------------ */

function createDroneModel() {
    const root = new THREE.Group();
    root.rotation.order = "YXZ"; // 与物理模块欧拉顺序一致
    const model = new THREE.Group();
    model.position.y = RENDER_CONFIG.droneModelLift;
    root.add(model);

    const mat = (color, extra = {}) =>
        new THREE.MeshStandardMaterial({
            color,
            roughness: 0.5,
            metalness: 0.35,
            envMapIntensity: 0.6,
            ...extra,
        });
    const add = (geometry, material, x, y, z, parent = model) => {
        const m = new THREE.Mesh(geometry, material);
        m.position.set(x, y, z);
        m.castShadow = true;
        parent.add(m);
        return m;
    };

    // 机身
    add(new THREE.BoxGeometry(0.36, 0.13, 0.5), mat("#2b2f36"), 0, 0, 0);
    add(new THREE.BoxGeometry(0.24, 0.07, 0.32), mat("#3f4652"), 0, 0.1, -0.02);
    // 机头标识：红色方块（机头朝 +Z）
    add(
        new THREE.BoxGeometry(0.16, 0.09, 0.1),
        mat("#ff2a2a", { emissive: "#ff0000", emissiveIntensity: 0.6 }),
        0,
        0.02,
        0.29,
    );
    // 尾灯
    add(
        new THREE.BoxGeometry(0.08, 0.05, 0.04),
        mat("#33ff77", { emissive: "#00ff55", emissiveIntensity: 0.6 }),
        0,
        0.02,
        -0.27,
    );

    // 起落架
    const legMat = mat("#1c1f24");
    for (const [lx, lz] of [
        [0.14, 0.17],
        [-0.14, 0.17],
        [0.14, -0.17],
        [-0.14, -0.17],
    ]) {
        add(new THREE.BoxGeometry(0.03, 0.24, 0.03), legMat, lx, -0.18, lz);
    }
    add(new THREE.BoxGeometry(0.03, 0.02, 0.44), legMat, 0.14, -0.29, 0);
    add(new THREE.BoxGeometry(0.03, 0.02, 0.44), legMat, -0.14, -0.29, 0);

    // 悬臂 + 电机 + 螺旋桨（X 型布局）
    const armReach    = 0.42;
    const frontArmMat = mat("#d84a3a");
    const rearArmMat  = mat("#8a919c");
    const motorMat    = mat("#555c66", { metalness: 0.7 });
    const bladeMat    = new THREE.MeshStandardMaterial({
        color: "#e8e8e8",
        roughness: 0.6,
        transparent: true,
    });
    const rotors = [];

    for (const [mx, mz, dir] of [
        [armReach, armReach,   1],
        [-armReach, armReach, -1],
        [armReach, -armReach, -1],
        [-armReach, -armReach, 1],
    ]) {
        const len = Math.hypot(mx, mz);
        const arm = add(
            new THREE.BoxGeometry(0.05, 0.035, len),
            mz > 0 ? frontArmMat : rearArmMat,
            mx / 2,
            0.01,
            mz / 2,
        );

        arm.rotation.y = Math.atan2(mx, mz);
        add(
            new THREE.CylinderGeometry(0.05, 0.055, 0.08, 16),
            motorMat,
            mx,
            0.05,
            mz,
        );

        const rotor = new THREE.Group();
        rotor.position.set(mx, 0.1, mz);
        model.add(rotor);
        const blade = add(
            new THREE.BoxGeometry(0.42, 0.008, 0.045),
            bladeMat,
            0,
            0,
            0,
            rotor,
        );

        blade.castShadow = false;
        add(
            new THREE.CylinderGeometry(0.02, 0.02, 0.025, 10),
            motorMat,
            0,
            0,
            0,
            rotor,
        );

        const disc = new THREE.Mesh(
            new THREE.CircleGeometry(0.21, 32),
            new THREE.MeshBasicMaterial({
                color: "#dfe6ee",
                transparent: true,
                opacity: 0,
                depthWrite: false,
                side: THREE.DoubleSide,
            }),
        );

        disc.rotation.x = -Math.PI / 2;
        disc.position.set(mx, 0.1, mz);
        model.add(disc);

        rotors.push({ rotor, disc, dir });
    }

    return { root, rotors, bladeMat, rotorSpeed: 0 };
}

/* ------------------------------------------------------------------ */
/* Engine                                                              */
/* ------------------------------------------------------------------ */

const lerp = (a, b, t) => a + (b - a) * t;
const smoothing = (sharpness, dt) => 1 - Math.exp(-sharpness * dt);

export class Engine {
    /**
     * @param {HTMLElement} container
     * @param {{getGroundHeight?: (x:number, z:number) => number}} [options]
     */
    constructor(container, { getGroundHeight = () => 0 } = {}) {
        this.container = container;
        this.getGroundHeight = getGroundHeight; // 物理地面高度（flat = 0）

        const renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setPixelRatio(
            Math.min(window.devicePixelRatio || 1, RENDER_CONFIG.maxPixelRatio),
        );
        renderer.setSize(container.clientWidth, container.clientHeight);
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = RENDER_CONFIG.exposure;
        container.appendChild(renderer.domElement);
        this.renderer = renderer;

        const scene = new THREE.Scene();
        scene.background = new THREE.Color();
        scene.fog = new THREE.FogExp2(0xffffff, RENDER_CONFIG.fog.density);
        this.scene = scene;

        const C = RENDER_CONFIG.camera;
        this.camera = new THREE.PerspectiveCamera(
            C.fov,
            container.clientWidth / container.clientHeight,
            C.near,
            C.far,
        );

        // 天空球：跟随相机，颜色由地图色板决定
        this.sky = createSky();
        scene.add(this.sky);

        // 光照：半球光（天空色 / 地面色）+ 主方向光（阴影）
        const L = RENDER_CONFIG.lights;
        this.hemi = new THREE.HemisphereLight("#ffffff", "#000000", L.hemiIntensity);
        scene.add(this.hemi);

        const S = RENDER_CONFIG.sun;
        const sun = new THREE.DirectionalLight("#ffffff", L.sunIntensity);
        sun.castShadow = true;
        sun.shadow.mapSize.set(S.mapSize, S.mapSize);
        Object.assign(sun.shadow.camera, {
            left: -S.shadowRange,
            right: S.shadowRange,
            top: S.shadowRange,
            bottom: -S.shadowRange,
            near: 1,
            far: S.shadowFar,
        });
        sun.shadow.bias = -0.0004;
        sun.shadow.normalBias = 0.03;
        scene.add(sun, sun.target);
        this.sun = sun;
        this._sunDirection = new THREE.Vector3(...S.offset).normalize();
        // 阴影相机的固定朝向（只取决于光的方向），用于把光源位置对齐到阴影纹素网格
        this._lightRotation = new THREE.Matrix4().lookAt(
            new THREE.Vector3(...S.offset),
            new THREE.Vector3(),
            new THREE.Vector3(0, 1, 0),
        );
        this._lightInverse = this._lightRotation.clone().invert();
        this._lightPos = new THREE.Vector3();
        this._lightLocal = new THREE.Vector3();

        this.mapRoot = new THREE.Group();
        scene.add(this.mapRoot);
        this.checkpoints = [];
        this.emissives = [];
        this.decorations = null;
        this.terrainHeight = null;
        this.look = createLook(null);
        this.envTarget = null;
        this._applyLook(this.look, null);

        this.drone = createDroneModel();
        scene.add(this.drone.root);

        this.view = {
            yaw: 0,
            position: new THREE.Vector3(),
            lookTarget: new THREE.Vector3(),
            shake: 0,
        };
        this._tmpDesired = new THREE.Vector3();
        this._tmpLook = new THREE.Vector3();
        this.elapsed = 0;

        this._onResize = () => this.resize();
        window.addEventListener("resize", this._onResize);
    }

    /** 视觉地面高度：物理地面与地形起伏取较大值（相机避让、边界线贴地用） */
    groundHeight(x, z) {
        const relief = this.terrainHeight ? this.terrainHeight(x, z) : 0;
        return Math.max(this.getGroundHeight(x, z), relief);
    }

    /** 由 MapData 生成整个场景（地图元素全部来自数据；切换地图时先释放旧场景资源） */
    buildMap(mapData) {
        const terrainBuilder = TERRAIN_BUILDERS[mapData.terrain.type];
        if (!terrainBuilder)
            throw new Error(`渲染器不支持的地形类型：${mapData.terrain.type}`);

        // 校验通过后再释放旧场景，避免新地图不可用时把旧场景也毁掉
        this._disposeMap();
        this.checkpoints = [];
        this.emissives = [];

        const ctx = {
            renderer: this.renderer,
            layout: createLayout(mapData),
            bounds: mapData.meta.bounds,
            look: createLook(mapData.meta.palette),
            isMobile: IS_MOBILE,
        };
        this._applyLook(ctx.look, mapData.meta.fogDensity);

        const terrain = terrainBuilder(mapData.terrain, mapData.meta.bounds, ctx);
        this.mapRoot.add(terrain.group);
        this.terrainHeight = terrain.heightAt;

        this.decorations = buildDecorations(mapData.decorations, {
            ...ctx,
            heightAt: terrain.heightAt,
        });
        this.mapRoot.add(this.decorations.group);

        this.mapRoot.add(
            createBoundsOutline(mapData.meta.bounds, (x, z) => this.groundHeight(x, z), ctx.look),
        );

        for (const obj of mapData.objects)
            this.mapRoot.add(buildMapObject(obj, this.emissives));

        for (const cp of mapData.checkpoints) {
            const ring = buildCheckpoint(cp, ctx.look);
            this.checkpoints.push(ring);
            this.mapRoot.add(ring);
        }
    }

    /** 释放上一张地图的 GPU 资源（几何体 / 材质 / 纹理），避免连续切换导致内存累积 */
    _disposeMap() {
        disposeObject3D(this.mapRoot);
        this.mapRoot.clear();
        this.decorations = null;
        this.terrainHeight = null;
    }

    /** 把色板 look 应用到天空 / 雾 / 灯光，并重新烘焙环境反射 */
    _applyLook(look, fogDensity) {
        this.look = look;
        const c = look.colors;

        this.scene.background.copy(c.skyHorizon);
        this.scene.fog.color.copy(c.fog);
        this.scene.fog.density = fogDensity ?? RENDER_CONFIG.fog.density;

        this.sun.color.copy(c.sun);
        this.hemi.color.copy(c.hemiSky);
        this.hemi.groundColor.copy(c.hemiGround);
        applySkyLook(this.sky, look, this._sunDirection);

        if (this.envTarget)
            this.envTarget.dispose();
        this.envTarget = renderEnvironment(this.renderer, this.sky);
        this.scene.environment = this.envTarget.texture;
    }

    /** 相机立即对齐到无人机后方（初始化 / R 重置） */
    resetView(state) {
        this.view.yaw = state.yaw;
        this.view.shake = 0;
        this._computeDesiredCamera(
            state.position,
            state.yaw,
            this._tmpDesired,
            this._tmpLook,
        );
        this.view.position.copy(this._tmpDesired);
        this.view.lookTarget.copy(this._tmpLook);
        this.drone.rotorSpeed = 0;
    }

    /** 碰撞时的相机震动反馈，intensity 0~1 */
    shake(intensity) {
        this.view.shake = Math.min(1, Math.max(this.view.shake, intensity));
    }

    /**
     * 每帧调用：按 alpha 在两个物理状态间插值后同步到画面并渲染
     * @param {object} prev 上一物理状态
     * @param {object} curr 当前物理状态
     * @param {number} alpha 0~1 插值因子（accumulator / fixedStep）
     * @param {number} dt 帧间隔（秒）
     */
    renderFrame(prev, curr, alpha, dt) {
        this.elapsed += dt;
        const pos = {
            x: lerp(prev.position.x, curr.position.x, alpha),
            y: lerp(prev.position.y, curr.position.y, alpha),
            z: lerp(prev.position.z, curr.position.z, alpha),
        };
        const pitch = lerp(prev.pitch, curr.pitch, alpha);
        const roll  = lerp(prev.roll, curr.roll, alpha);
        const yaw   = lerp(prev.yaw, curr.yaw, alpha); // 物理中 yaw 连续不回绕，可直接插值
        const root  = this.drone.root;

        root.position.set(pos.x, pos.y, pos.z);
        root.rotation.set(pitch, yaw, roll); // order YXZ

        this._updateRotors(curr.motorOutput, dt);
        this._updateCamera(pos, yaw, dt);
        this._updateSun(pos);
        this._updateCheckpoints();
        this._updateEmissives();
        this.decorations?.update(dt);

        this.sky.position.copy(this.camera.position);

        this.renderer.render(this.scene, this.camera);
    }

    /** 启动渲染循环：onFrame(dtSeconds, nowMs) */
    start(onFrame) {
        let last = performance.now();
        const loop = (now) => {
            const dt = Math.max(0, (now - last) / 1000);
            last = now;
            onFrame(dt, now);
            this._raf = requestAnimationFrame(loop);
        };

        this._raf = requestAnimationFrame((now) => {
            last = now;
            loop(now);
        });
    }

    resize() {
        const w = this.container.clientWidth;
        const h = this.container.clientHeight;

        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(w, h);
    }

    /* ---------------- 内部 ---------------- */

    _computeDesiredCamera(pos, yaw, outPos, outLook) {
        const C = RENDER_CONFIG.camera;
        const fx = Math.sin(yaw),
            fz = Math.cos(yaw);
        outPos.set(
            pos.x - fx * C.distance,
            pos.y + C.height,
            pos.z - fz * C.distance,
        );
        const minY = this.groundHeight(outPos.x, outPos.z) + C.minHeightAboveGround;

        if (outPos.y < minY)
            outPos.y = minY;

        outLook.set(
            pos.x + fx * C.lookAhead,
            pos.y + C.lookHeight,
            pos.z + fz * C.lookAhead,
        );
    }

    _updateCamera(pos, yaw, dt) {
        const C = RENDER_CONFIG.camera;
        const v = this.view;
        // 朝向滞后跟随：偏航时视角缓慢转向，不与机头刚性锁定
        v.yaw += (yaw - v.yaw) * smoothing(C.yawSharpness, dt);
        this._computeDesiredCamera(pos, v.yaw, this._tmpDesired, this._tmpLook);
        v.position.lerp(this._tmpDesired, smoothing(C.positionSharpness, dt));
        v.lookTarget.lerp(this._tmpLook, smoothing(C.lookSharpness, dt));

        this.camera.position.copy(v.position);

        if (v.shake > 0.001) {
            const amp = v.shake * v.shake * RENDER_CONFIG.shake.maxOffset;
            this.camera.position.x += (Math.random() * 2 - 1) * amp;
            this.camera.position.y += (Math.random() * 2 - 1) * amp;
            this.camera.position.z += (Math.random() * 2 - 1) * amp;
            v.shake *= Math.exp(-RENDER_CONFIG.shake.decay * dt);
        }

        this.camera.lookAt(v.lookTarget);
    }

    _updateRotors(motorOutput, dt) {
        const R = RENDER_CONFIG.rotor;
        const d = this.drone;
        const target =
            motorOutput > 0 ? R.idleSpeed + motorOutput * R.maxSpeed : 0;
        d.rotorSpeed += (target - d.rotorSpeed) * smoothing(R.spinUp, dt);
        const blur = Math.min(
            1,
            Math.max(
                0,
                (d.rotorSpeed - R.blurStart) / (R.blurFull - R.blurStart),
            ),
        );

        d.bladeMat.opacity = 1 - blur * 0.75;

        for (const r of d.rotors) {
            r.rotor.rotation.y =
                (r.rotor.rotation.y + r.dir * d.rotorSpeed * dt) %
                (Math.PI * 2);
            r.disc.material.opacity = blur * 0.32;
        }
    }

    /**
     * 主光跟随无人机。把光源位置在光照空间内对齐到阴影贴图的纹素网格，
     * 无人机移动时阴影边缘不会因为纹素错位而闪烁。
     */
    _updateSun(pos) {
        const S = RENDER_CONFIG.sun;
        const o = S.offset;
        const local = this._lightLocal;
        const lightPos = this._lightPos;

        lightPos.set(pos.x + o[0], pos.y + o[1], pos.z + o[2]);
        local.copy(lightPos).applyMatrix4(this._lightInverse);
        const texel = (S.shadowRange * 2) / S.mapSize;
        local.x = Math.round(local.x / texel) * texel;
        local.y = Math.round(local.y / texel) * texel;
        lightPos.copy(local).applyMatrix4(this._lightRotation);

        this.sun.position.copy(lightPos);
        this.sun.target.position.set(
            lightPos.x - o[0],
            lightPos.y - o[1],
            lightPos.z - o[2],
        );
        this.sun.target.updateMatrixWorld();
    }

    _updateCheckpoints() {
        const base = RENDER_CONFIG.checkpoint.emissiveIntensity;
        const pulse = base * (0.75 + 0.25 * Math.sin(this.elapsed * 3));
        for (const ring of this.checkpoints)
            ring.material.emissiveIntensity = pulse;
    }

    /** 地图中带 emissive 的标志物（发光环塔等）缓慢呼吸 */
    _updateEmissives() {
        const E = RENDER_CONFIG.emissive;
        for (let i = 0; i < this.emissives.length; i++) {
            const e = this.emissives[i];
            e.material.emissiveIntensity =
                e.base * (1 - E.pulse + E.pulse * 2 * (0.5 + 0.5 * Math.sin(this.elapsed * E.speed + i)));
        }
    }
}

/**
 * 递归释放 Object3D 子树持有的几何体、材质与纹理。
 * 只用于可丢弃的地图场景（mapRoot），不会触碰无人机等常驻资源。
 */
function disposeObject3D(root) {
    root.traverse((obj) => {
        if (obj.geometry)
            obj.geometry.dispose();

        const materials = Array.isArray(obj.material)
            ? obj.material
            : obj.material
              ? [obj.material]
              : [];

        for (const material of materials) {
            for (const value of Object.values(material)) {
                if (value && value.isTexture)
                    value.dispose();
            }
            material.dispose();
        }
    });
}
