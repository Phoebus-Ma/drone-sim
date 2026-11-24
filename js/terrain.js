/**
 * terrain.js —— 地形构建器（解析数据 → 地面网格 / 地面纹理 / 水面）
 *
 * 物理地面始终是 y = 0 的平面（physics.js 不变）。这里的视觉处理有：
 *   - 整张地图一张 Canvas 纹理：底色 + terrain.layers 分层（带噪声的有机边缘）
 *   - terrain.relief：远离航线 / 障碍物 / 水面的区域做低多边形起伏（只在视觉上，
 *     航线走廊与障碍物脚下保持完全平坦），heightAt(x, z) 供装饰物贴地使用
 *   - layers 中 water: true 的层额外生成一块反射天空的水面
 *
 * 本文件不包含任何地图元素的位置、颜色、数量。
 */

import * as THREE from "three";
import { fbm2, noise2, smoothstep, distToSegment, shapeSdf } from "./procedural.js";
import { createStandardMaterial, createWaterMaterial } from "./materials.js";

export const TERRAIN_STYLE = {
    margin: 400, // 地面在 bounds 外额外延伸的距离（m）
    reliefTile: 8, // 起伏网格每格尺寸（m）
    reliefTileMobile: 12,
    textureSize: 2048, // 桌面端地面纹理边长
    textureSizeMobile: 1024,
    waterLevel: 0.12, // 水面高度（m）
    corridor: [22, 48], // 航线走廊：内距内完全平坦，到外距恢复起伏
    objectFlat: [3, 16], // 障碍物脚下平坦范围
    waterFlat: [10, 26], // 水面及周边平坦范围
};

/* ------------------------------------------------------------------ */
/* 布局信息：航线 / 碰撞体 / 水面 的距离场，供地形与装饰物共用             */
/* ------------------------------------------------------------------ */

/**
 * @param {object} mapData 解析后的地图数据
 */
export function createLayout(mapData) {
    const route = [mapData.meta.spawn.position, ...mapData.checkpoints.map((c) => c.position)];
    const colliders = mapData.collision.colliders || [];
    const waters = (mapData.terrain.layers || []).filter((l) => l.water);

    const boxes = colliders.map((c) => ({
        cx: (c.min.x + c.max.x) / 2,
        cz: (c.min.z + c.max.z) / 2,
        hw: (c.max.x - c.min.x) / 2,
        hd: (c.max.z - c.min.z) / 2,
    }));

    return {
        route,
        /** 到航线折线（出生点 → 各检查点）的水平距离 */
        routeDistance(x, z) {
            if (route.length < 2)
                return Math.hypot(x - route[0].x, z - route[0].z);

            let d = Infinity;
            for (let i = 0; i < route.length - 1; i++) {
                const a = route[i];
                const b = route[i + 1];
                d = Math.min(d, distToSegment(x, z, a.x, a.z, b.x, b.z));
            }
            return d;
        },
        /** 到最近碰撞体 XZ 投影的距离 */
        colliderDistance(x, z) {
            let d = Infinity;
            for (const b of boxes) {
                const dx = Math.abs(x - b.cx) - b.hw;
                const dz = Math.abs(z - b.cz) - b.hd;
                const dist =
                    Math.hypot(Math.max(dx, 0), Math.max(dz, 0)) +
                    Math.min(Math.max(dx, dz), 0);
                if (dist < d)
                    d = dist;
            }
            return d;
        },
        /** 到最近水面的带符号距离 */
        waterDistance(x, z) {
            let d = Infinity;
            for (const w of waters)
                d = Math.min(d, shapeSdf(w, x, z));
            return d;
        },
        /** 某点周围 clearance 范围内是否没有航线 / 碰撞物 / 水面 */
        isFree(x, z, clearance) {
            return (
                this.routeDistance(x, z) >= clearance &&
                this.colliderDistance(x, z) >= clearance &&
                this.waterDistance(x, z) >= clearance
            );
        },
        /** 起伏遮罩 0~1：航线走廊、障碍物脚下、水面附近为 0 */
        reliefMask(x, z) {
            const C = TERRAIN_STYLE;
            return Math.min(
                smoothstep(C.corridor[0], C.corridor[1], this.routeDistance(x, z)),
                smoothstep(C.objectFlat[0], C.objectFlat[1], this.colliderDistance(x, z)),
                smoothstep(C.waterFlat[0], C.waterFlat[1], this.waterDistance(x, z)),
            );
        },
    };
}

/* ------------------------------------------------------------------ */
/* 平地构建器                                                           */
/* ------------------------------------------------------------------ */

/**
 * @param {object} terrain  { type, color, relief?, layers? }
 * @param {{x:number[], z:number[]}} bounds
 * @param {{renderer: THREE.WebGLRenderer, layout: object, isMobile: boolean}} ctx
 * @returns {{group: THREE.Group, heightAt: (x:number, z:number) => number}}
 */
export function buildFlatTerrain(terrain, bounds, ctx) {
    const S = TERRAIN_STYLE;
    const margin = S.margin;
    const width = bounds.x[1] - bounds.x[0] + margin * 2;
    const depth = bounds.z[1] - bounds.z[0] + margin * 2;
    const cx = (bounds.x[0] + bounds.x[1]) / 2;
    const cz = (bounds.z[0] + bounds.z[1]) / 2;
    const relief = terrain.relief || 0;

    // 视觉起伏高度（物理地面仍为 0）
    const heightAt = (x, z) =>
        relief > 0
            ? relief * ctx.layout.reliefMask(x, z) * Math.pow(fbm2(x * 0.012, z * 0.012), 1.5)
            : 0;

    const tile = (ctx.isMobile ? S.reliefTileMobile : S.reliefTile);
    const geometry = new THREE.PlaneGeometry(
        width,
        depth,
        Math.round(width / tile),
        Math.round(depth / tile),
    );

    if (relief > 0) {
        const pos = geometry.attributes.position;
        for (let i = 0; i < pos.count; i++)
            pos.setZ(i, heightAt(cx + pos.getX(i), cz - pos.getY(i)));
        pos.needsUpdate = true;
        geometry.computeVertexNormals();
    }

    const texture = createGroundTexture(terrain, width, depth, cx, cz, ctx);
    const material = createStandardMaterial("#ffffff", {
        map: texture,
        roughness: 1,
        flatShading: true,
        envMapIntensity: 0.25,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(cx, 0, cz);
    mesh.receiveShadow = true;

    const group = new THREE.Group();
    group.add(mesh);

    for (const layer of terrain.layers || []) {
        if (layer.water)
            group.add(createWaterMesh(layer));
    }

    return { group, heightAt };
}

/** 粗网格噪声场：每 step 像素采样一次，中间双线性插值，避免逐像素调用噪声 */
function createNoiseField(size, step, originX, originZ, scale, perPixelX, perPixelZ) {
    const gw = Math.ceil(size / step) + 2;
    const grid = new Float32Array(gw * gw);
    const ax = originX * scale;
    const az = originZ * scale;
    const kx = perPixelX * scale;
    const ky = perPixelZ * scale;

    for (let gy = 0; gy < gw; gy++) {
        for (let gx = 0; gx < gw; gx++)
            grid[gy * gw + gx] = noise2(ax + gx * step * kx, az + gy * step * ky);
    }

    return (px, py) => {
        const fx = px / step;
        const fy = py / step;
        const ix = Math.floor(fx);
        const iy = Math.floor(fy);
        const tx = fx - ix;
        const ty = fy - iy;
        const i = iy * gw + ix;
        const a = grid[i];
        const b = grid[i + 1];
        const c = grid[i + gw];
        const d = grid[i + gw + 1];

        return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
    };
}

/** #rgb / #rrggbb → [r, g, b]（0~255） */
function parseHex(hex) {
    let h = hex.slice(1);
    if (h.length === 3)
        h = h.split("").map((c) => c + c).join("");
    const n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * 整张地面一张纹理：底色 → 依次叠加各 layer（带符号距离 + 噪声抖动形成有机边缘），
 * 再叠加低频明暗变化打破纯色。纹理 v=1 对应 z 的最小值（与 PlaneGeometry 旋转后的 UV 一致）。
 */
function createGroundTexture(terrain, width, depth, cx, cz, ctx) {
    const S = TERRAIN_STYLE;
    const size = ctx.isMobile ? S.textureSizeMobile : S.textureSize;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const canvasCtx = canvas.getContext("2d");
    const image = canvasCtx.createImageData(size, size);
    const data = image.data;

    const x0 = cx - width / 2;
    const z0 = cz - depth / 2;
    const perPixelX = width / size;
    const perPixelZ = depth / size;

    const base = parseHex(terrain.color);
    const layers = (terrain.layers || []).map((layer, i) => ({
        sdf: layer,
        color: parseHex(layer.color),
        edge: layer.edge,
        feather: layer.feather,
        seed: i * 137.7,
    }));

    const shadeField = createNoiseField(size, 4, x0, z0, 0.015, perPixelX, perPixelZ);
    const edgeField = createNoiseField(size, 2, x0, z0, 0.08, perPixelX, perPixelZ);

    for (let py = 0; py < size; py++) {
        const z = z0 + (py + 0.5) * perPixelZ;
        for (let px = 0; px < size; px++) {
            const x = x0 + (px + 0.5) * perPixelX;
            let r = base[0];
            let g = base[1];
            let b = base[2];

            for (const l of layers) {
                let d = shapeSdf(l.sdf, x, z);
                if (d > l.feather + l.edge)
                    continue;

                d += (edgeField(px, py) - 0.5) * 2 * l.edge;
                const cov = 1 - smoothstep(-l.feather, 0, d);
                if (cov <= 0)
                    continue;

                r += (l.color[0] - r) * cov;
                g += (l.color[1] - g) * cov;
                b += (l.color[2] - b) * cov;
            }

            const shade = 0.9 + 0.2 * shadeField(px, py);
            const o = (py * size + px) * 4;
            data[o] = r * shade;
            data[o + 1] = g * shade;
            data[o + 2] = b * shade;
            data[o + 3] = 255;
        }
    }

    canvasCtx.putImageData(image, 0, 0);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = ctx.renderer.capabilities.getMaxAnisotropy();
    return texture;
}

/** 水面网格：rect → PlaneGeometry，disc → CircleGeometry */
function createWaterMesh(layer) {
    const geometry =
        layer.shape === "disc"
            ? new THREE.CircleGeometry(layer.radius, 48)
            : new THREE.PlaneGeometry(layer.size[0], layer.size[1]);
    const mesh = new THREE.Mesh(geometry, createWaterMaterial(layer.color));

    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(layer.center.x, TERRAIN_STYLE.waterLevel, layer.center.z);
    mesh.receiveShadow = true;
    return mesh;
}
