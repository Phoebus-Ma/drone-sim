/**
 * procedural.js —— 确定性随机 / 噪声 / 距离场工具（纯函数，不依赖 Three.js）
 *
 * 地图内所有“随机”（装饰物散布、地面纹理、起伏）都必须由种子确定，
 * 保证同一份地图 JSON 每次加载得到完全一致的画面。
 */

/** mulberry32：32 位种子的确定性 PRNG，返回 0~1 */
export function mulberry32(seed) {
    let a = seed >>> 0;

    return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** 整数格点哈希，返回 0~1 */
export function hash2(ix, iy) {
    let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
}

/** 三维整数格点哈希（用于共享顶点的几何体变形） */
export function hash3(ix, iy, iz, seed = 0) {
    return hash2(ix + Math.imul(iy, 57) + Math.imul(iz, 131) + Math.imul(seed, 719), iz - iy * 17 + ix * 3);
}

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** 二维值噪声，返回 0~1 */
export function noise2(x, y) {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const a = hash2(ix, iy);
    const b = hash2(ix + 1, iy);
    const c = hash2(ix, iy + 1);
    const d = hash2(ix + 1, iy + 1);

    return lerp(lerp(a, b, sx), lerp(c, d, sx), sy);
}

/** 分形叠加噪声，返回 0~1 */
export function fbm2(x, y, octaves = 3) {
    let sum = 0;
    let amp = 0.5;
    let norm = 0;

    for (let i = 0; i < octaves; i++) {
        sum += noise2(x, y) * amp;
        norm += amp;
        x = x * 2.03 + 17.1;
        y = y * 2.03 + 9.7;
        amp *= 0.5;
    }

    return sum / norm;
}

export function smoothstep(edge0, edge1, x) {
    const t = clamp01((x - edge0) / (edge1 - edge0));
    return t * t * (3 - 2 * t);
}

/** 点到线段 (ax,az)-(bz) 的距离 */
export function distToSegment(px, pz, ax, az, bx, bz) {
    const dx = bx - ax;
    const dz = bz - az;
    const len2 = dx * dx + dz * dz;
    const t = len2 > 0 ? clamp01(((px - ax) * dx + (pz - az) * dz) / len2) : 0;

    return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
}

/** 轴对齐矩形的带符号距离（内部为负） */
export function sdfRect(x, z, cx, cz, halfW, halfD) {
    const dx = Math.abs(x - cx) - halfW;
    const dz = Math.abs(z - cz) - halfD;

    return (
        Math.hypot(Math.max(dx, 0), Math.max(dz, 0)) + Math.min(Math.max(dx, dz), 0)
    );
}

export const sdfDisc = (x, z, cx, cz, r) => Math.hypot(x - cx, z - cz) - r;

/** 地图 layer / area（rect | disc）的带符号距离 */
export function shapeSdf(shape, x, z) {
    const c = shape.center;
    return shape.shape === "disc"
        ? sdfDisc(x, z, c.x, c.z, shape.radius)
        : sdfRect(x, z, c.x, c.z, shape.size[0] / 2, shape.size[1] / 2);
}
