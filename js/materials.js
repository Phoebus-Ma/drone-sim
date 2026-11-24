/**
 * materials.js —— 材质 / 天空 / 环境光外观工厂
 *
 * “look”是一张地图的全部外观参数（天空顶色、地平线色、雾色、阳光色、强调色……），
 * 全部由地图的 meta.palette 派生；engine 在每次 buildMap 时重新生成并应用到
 * 天空球、雾、灯光上。本文件不包含任何地图元素的位置、颜色、数量。
 */

import * as THREE from "three";

/** 旧地图（无 meta.palette）使用的默认色板 */
export const DEFAULT_PALETTE = {
    sky: "#7bb0dc",
    horizon: "#f5ddb0",
    grass: "#8cb372",
    rock: "#a9846a",
    accent: "#e2725b",
};

/**
 * 由色板生成 look。
 * @param {{sky:string, horizon:string, grass?:string, sand?:string, rock?:string, accent?:string}|null} palette
 */
export function createLook(palette) {
    const p = palette || {};
    const sky = p.sky || DEFAULT_PALETTE.sky;
    const horizon = p.horizon || DEFAULT_PALETTE.horizon;
    const grass = p.grass || DEFAULT_PALETTE.grass;
    const rock = p.rock || p.accent || DEFAULT_PALETTE.rock;
    const accent = p.accent || p.rock || DEFAULT_PALETTE.accent;
    const sand = p.sand || horizon;

    return {
        palette: { sky, horizon, grass, sand, rock, accent },
        colors: {
            skyTop: new THREE.Color(sky),
            skyHorizon: new THREE.Color(horizon),
            fog: new THREE.Color(horizon),
            sun: new THREE.Color(horizon),
            hemiSky: new THREE.Color(sky),
            hemiGround: new THREE.Color(grass),
            accent: new THREE.Color(accent),
            checkpoint: new THREE.Color(sky),
        },
    };
}

/* ------------------------------------------------------------------ */
/* 材质工厂                                                             */
/* ------------------------------------------------------------------ */

/**
 * 低多边形风格的通用 PBR 材质：默认 flatShading + 低金属度，
 * envMapIntensity 压低以免环境贴图冲淡色板颜色。
 */
export function createStandardMaterial(
    color,
    {
        roughness = 0.85,
        metalness = 0,
        emissive = null,
        emissiveIntensity = 1,
        flatShading = true,
        envMapIntensity = 0.35,
        map = null,
        transparent = false,
        opacity = 1,
    } = {},
) {
    const material = new THREE.MeshStandardMaterial({
        color,
        roughness,
        metalness,
        flatShading,
        envMapIntensity,
        emissive: emissive || "#000000",
        emissiveIntensity,
        transparent,
        opacity,
    });

    if (map)
        material.map = map;

    return material;
}

/** 水面：低粗糙度 + 天空环境反射，半透明露出下面画好的水色 */
export function createWaterMaterial(color) {
    return new THREE.MeshStandardMaterial({
        color,
        roughness: 0.12,
        metalness: 0.05,
        transparent: true,
        opacity: 0.78,
        envMapIntensity: 1.1,
    });
}

/* ------------------------------------------------------------------ */
/* 渐变天空球                                                           */
/* ------------------------------------------------------------------ */

const SKY_VERTEX = /* glsl */ `
    varying vec3 vDir;
    void main() {
        vDir = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`;

const SKY_FRAGMENT = /* glsl */ `
    uniform vec3 topColor;
    uniform vec3 horizonColor;
    uniform vec3 sunColor;
    uniform vec3 sunDir;
    varying vec3 vDir;

    void main() {
        vec3 d = normalize(vDir);
        float t = pow(smoothstep(-0.02, 0.42, d.y), 0.8);
        vec3 col = mix(horizonColor, topColor, t);
        col = mix(col, horizonColor * 0.9, smoothstep(0.0, 0.25, -d.y));
        float s = max(dot(d, sunDir), 0.0);
        col += sunColor * (pow(s, 500.0) * 1.5 + pow(s, 10.0) * 0.15);
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
    }
`;

/** 渐变天空球（内面渲染，跟随相机），带太阳光斑 */
export function createSky() {
    const material = new THREE.ShaderMaterial({
        uniforms: {
            topColor: { value: new THREE.Color() },
            horizonColor: { value: new THREE.Color() },
            sunColor: { value: new THREE.Color() },
            sunDir: { value: new THREE.Vector3(0, 1, 0) },
        },
        vertexShader: SKY_VERTEX,
        fragmentShader: SKY_FRAGMENT,
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
    });
    const sky = new THREE.Mesh(new THREE.SphereGeometry(1000, 32, 16), material);
    sky.frustumCulled = false;
    sky.renderOrder = -1;
    return sky;
}

/** 把 look 应用到天空球材质 */
export function applySkyLook(sky, look, sunDirection) {
    const u = sky.material.uniforms;
    u.topColor.value.copy(look.colors.skyTop);
    u.horizonColor.value.copy(look.colors.skyHorizon);
    u.sunColor.value.copy(look.colors.sun);
    u.sunDir.value.copy(sunDirection).normalize();
}

/**
 * 用天空球烘焙一张 PMREM 环境贴图，赋给 scene.environment 后
 * 所有 MeshStandardMaterial 都能获得柔和的天空反射（水面、金属、岩石高光）。
 */
export function renderEnvironment(renderer, sky) {
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envScene = new THREE.Scene();
    const probe = new THREE.Mesh(new THREE.SphereGeometry(1000, 24, 12), sky.material);
    envScene.add(probe);
    const target = pmrem.fromScene(envScene, 0.02, 1, 2000);
    probe.geometry.dispose();
    pmrem.dispose();
    return target;
}
