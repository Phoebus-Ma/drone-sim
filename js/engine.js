/**
 * engine.js —— Three.js 场景 / 相机 / 灯光 / 渲染循环
 *
 * 职责：把 MapData “解析数据 → 生成对象”，并把物理状态（纯数据）同步到可视对象。
 * 本文件不包含任何地图元素的位置、颜色、数量；下面的 RENDER_CONFIG 只是通用渲染风格参数。
 */

import * as THREE from "three";

const RENDER_CONFIG = {
    maxPixelRatio: 2,
    sky: "#a9cfee",
    fog: { near: 140, far: 560 },
    groundMargin: 400, // 地面平面在 bounds 外额外延伸的距离（m）
    groundTileSize: 10, // 地面网格纹理每格尺寸（m）
    boundsLineColor: "#ffd54f",
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
    sun: { offset: [35, 80, -25], shadowRange: 55, mapSize: 2048 },
    rotor: {
        idleSpeed: 25,
        maxSpeed: 160,
        spinUp: 6,
        blurStart: 30,
        blurFull: 90,
    },
    checkpoint: {
        color: "#00e5ff",
        emissive: "#00bcd4",
        emissiveIntensity: 0.9,
        tube: 0.4,
    },
    droneModelLift: -0.2, // 模型相对物理中心下移，使静止时起落架贴地（包围球半径 0.5）
};

/* ------------------------------------------------------------------ */
/* 地图对象构建器（按 MapData 数据生成）                                */
/* ------------------------------------------------------------------ */

const GEOMETRY_BUILDERS = {
    box: ([w, h, d]) => new THREE.BoxGeometry(w, h, d),
    cylinder: ([r, h]) => new THREE.CylinderGeometry(r, r, h, 32),
    torus: ([R, t]) => new THREE.TorusGeometry(R, t, 16, 64), // 默认位于 XY 平面：竖立、面向 +Z
};

const TERRAIN_BUILDERS = {
    flat: buildFlatTerrain,
    // 未来：heightmap: buildHeightmapTerrain,
};

function buildFlatTerrain(terrain, bounds, renderer) {
    const margin = RENDER_CONFIG.groundMargin;
    const width = bounds.x[1] - bounds.x[0] + margin * 2;
    const depth = bounds.z[1] - bounds.z[0] + margin * 2;
    const texture = createGroundTexture(terrain.color);

    texture.repeat.set(
        width / RENDER_CONFIG.groundTileSize,
        depth / RENDER_CONFIG.groundTileSize,
    );
    texture.anisotropy = renderer.capabilities.getMaxAnisotropy();

    const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(width, depth),
        new THREE.MeshStandardMaterial({
            map: texture,
            roughness: 1,
            metalness: 0,
        }),
    );

    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(
        (bounds.x[0] + bounds.x[1]) / 2,
        0,
        (bounds.z[0] + bounds.z[1]) / 2,
    );
    mesh.receiveShadow = true;

    return mesh;
}

/** 以地形颜色为底生成带细微噪点和网格线的纹理，提供速度感参照 */
function createGroundTexture(baseColor) {
    const size    = 256;
    const canvas  = document.createElement("canvas");
    canvas.width  = canvas.height = size;
    const ctx     = canvas.getContext("2d");
    ctx.fillStyle = baseColor;
    ctx.fillRect(0, 0, size, size);

    for (let i = 0; i < 1400; i++) {
        const light = Math.random() < 0.5;
        ctx.fillStyle = light ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.06)";
        const s = 2 + Math.random() * 5;
        ctx.fillRect(Math.random() * size, Math.random() * size, s, s);
    }

    ctx.strokeStyle = "rgba(0,0,0,0.16)";
    ctx.lineWidth = 2;
    ctx.strokeRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;

    return tex;
}

function createBoundsOutline(bounds, getGroundHeight) {
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
            color: RENDER_CONFIG.boundsLineColor,
            transparent: true,
            opacity: 0.7,
        }),
    );
}

function buildMapObject(obj) {
    const builder = GEOMETRY_BUILDERS[obj.type];
    if (!builder)
        throw new Error(`渲染器不支持的物体类型：${obj.type}`);

    const mesh = new THREE.Mesh(
        builder(obj.size),
        new THREE.MeshStandardMaterial({
            color: obj.color,
            roughness: 0.85,
            metalness: 0.05,
        }),
    );

    mesh.position.set(obj.position.x, obj.position.y, obj.position.z);
    mesh.rotation.set(obj.rotation.x, obj.rotation.y, obj.rotation.z); // XYZ 顺序，与解析器 AABB 计算一致
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    return mesh;
}

function buildCheckpoint(cp) {
    const C = RENDER_CONFIG.checkpoint;
    const mesh = new THREE.Mesh(
        new THREE.TorusGeometry(cp.radius, C.tube, 16, 72),
        new THREE.MeshStandardMaterial({
            color: C.color,
            emissive: C.emissive,
            emissiveIntensity: C.emissiveIntensity,
            roughness: 0.35,
            metalness: 0.1,
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
        this.getGroundHeight = getGroundHeight;

        const renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setPixelRatio(
            Math.min(window.devicePixelRatio || 1, RENDER_CONFIG.maxPixelRatio),
        );
        renderer.setSize(container.clientWidth, container.clientHeight);
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        container.appendChild(renderer.domElement);
        this.renderer = renderer;

        const scene = new THREE.Scene();
        scene.background = new THREE.Color(RENDER_CONFIG.sky);
        scene.fog = new THREE.Fog(
            RENDER_CONFIG.sky,
            RENDER_CONFIG.fog.near,
            RENDER_CONFIG.fog.far,
        );

        this.scene = scene;

        const C = RENDER_CONFIG.camera;
        this.camera = new THREE.PerspectiveCamera(
            C.fov,
            container.clientWidth / container.clientHeight,
            C.near,
            C.far,
        );

        scene.add(new THREE.HemisphereLight("#dcefff", "#4b5a3c", 1.3));
        const sun = new THREE.DirectionalLight("#fff3df", 2.4);
        const S = RENDER_CONFIG.sun;
        sun.castShadow = true;
        sun.shadow.mapSize.set(S.mapSize, S.mapSize);
        Object.assign(sun.shadow.camera, {
            left: -S.shadowRange,
            right: S.shadowRange,
            top: S.shadowRange,
            bottom: -S.shadowRange,
            near: 1,
            far: 300,
        });
        sun.shadow.bias = -0.0004;
        sun.shadow.normalBias = 0.03;
        scene.add(sun, sun.target);
        this.sun = sun;

        this.mapRoot = new THREE.Group();
        scene.add(this.mapRoot);
        this.checkpoints = [];

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

    /** 由 MapData 生成整个场景（地图元素全部来自数据） */
    buildMap(mapData) {
        this.mapRoot.clear();
        this.checkpoints = [];

        const terrainBuilder = TERRAIN_BUILDERS[mapData.terrain.type];
        if (!terrainBuilder)
            throw new Error(`渲染器不支持的地形类型：${mapData.terrain.type}`);

        this.mapRoot.add(
            terrainBuilder(mapData.terrain, mapData.meta.bounds, this.renderer),
        );

        this.mapRoot.add(
            createBoundsOutline(mapData.meta.bounds, this.getGroundHeight),
        );

        for (const obj of mapData.objects)
            this.mapRoot.add(buildMapObject(obj));

        for (const cp of mapData.checkpoints) {
            const ring = buildCheckpoint(cp);
            this.checkpoints.push(ring);
            this.mapRoot.add(ring);
        }
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
        const minY =
            this.getGroundHeight(outPos.x, outPos.z) + C.minHeightAboveGround;

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

    _updateSun(pos) {
        const o = RENDER_CONFIG.sun.offset;
        this.sun.position.set(pos.x + o[0], pos.y + o[1], pos.z + o[2]);
        this.sun.target.position.set(pos.x, pos.y, pos.z);
    }

    _updateCheckpoints() {
        const base = RENDER_CONFIG.checkpoint.emissiveIntensity;
        const pulse = base * (0.75 + 0.25 * Math.sin(this.elapsed * 3));
        for (const ring of this.checkpoints)
            ring.material.emissiveIntensity = pulse;
    }
}
