/**
 * decorations.js —— 装饰物（非碰撞）构建器
 *
 * 地图 JSON 的 decorations 每一项描述一种装饰物（低模树 / 岩石 / 远山 / 云）及其散布规则，
 * 这里按规则用种子随机在指定区域散布，并用 InstancedMesh 渲染（每种装饰物仅几个 draw call）。
 * 散布时自动避开航线走廊、碰撞体与水面（clearance 米）。
 *
 * 支持的类型：
 *   tree  低模树：柱状树干 + 两层锥形树冠
 *   rock  岩石：顶点随机变形的二十面体
 *   hill  远山：扁平化的变形二十面体，用于地图外围的背景山丘
 *   cloud 云：漂浮的变形二十面体，按 drift 缓慢移动
 *
 * 本文件不包含任何地图元素的位置、颜色、数量。
 */

import * as THREE from "three";
import { mulberry32, hash3 } from "./procedural.js";
import { createStandardMaterial } from "./materials.js";

/** 各类型的默认参数（JSON 中可覆盖） */
const TYPE_DEFAULTS = {
    tree: { scale: [0.8, 1.5], clearance: 8, shade: [0.72, 0.92], altitude: [0, 0] },
    rock: { scale: [0.6, 2.4], clearance: 6, shade: [0.9, 1.1], altitude: [0, 0] },
    hill: { scale: [60, 130], clearance: 0, shade: [0.95, 1.05], altitude: [0, 0] },
    cloud: { scale: [10, 22], clearance: 0, shade: [1, 1], altitude: [80, 130] },
};

/* ------------------------------------------------------------------ */
/* 几何体（单位尺寸，底部落在 y = 0）                                   */
/* ------------------------------------------------------------------ */

/** 二十面体按顶点位置哈希做放射状变形；共享位置的顶点得到相同偏移，面不会撕裂 */
function displacedIcosahedron(detail, amount, seed) {
    const geometry = new THREE.IcosahedronGeometry(1, detail);
    const pos = geometry.attributes.position;

    for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        const y = pos.getY(i);
        const z = pos.getZ(i);
        const h = hash3(Math.round(x * 1e4), Math.round(y * 1e4), Math.round(z * 1e4), seed);
        const f = 1 + (h - 0.5) * 2 * amount;
        pos.setXYZ(i, x * f, y * f, z * f);
    }

    pos.needsUpdate = true;
    geometry.computeVertexNormals();
    return geometry;
}

function translate(geometry, y) {
    geometry.translate(0, y, 0);
    return geometry;
}

/**
 * 某种装饰物由若干“部件”组成（每个部件一个 InstancedMesh，共享相同的实例矩阵）。
 * @returns {{parts: {geometry: THREE.BufferGeometry, material: THREE.Material, shaded: boolean}[], castShadow: boolean}}
 */
function createParts(spec, look) {
    const base = { roughness: 0.95, envMapIntensity: 0.25 };
    const color = spec.color;
    const secondary = spec.secondaryColor || look.palette.rock;

    switch (spec.type) {
        case "tree":
            return {
                castShadow: true,
                parts: [
                    {
                        geometry: translate(new THREE.CylinderGeometry(0.16, 0.26, 1.4, 6), 0.7),
                        material: createStandardMaterial(secondary, { ...base, roughness: 1 }),
                        shaded: false,
                    },
                    {
                        geometry: translate(new THREE.ConeGeometry(1.45, 2.8, 7), 2.4),
                        material: createStandardMaterial(color, base),
                        shaded: true,
                    },
                    {
                        geometry: translate(new THREE.ConeGeometry(0.95, 2.1, 7), 4.0),
                        material: createStandardMaterial(color, base),
                        shaded: true,
                    },
                ],
            };

        case "rock":
            return {
                castShadow: true,
                parts: [
                    {
                        geometry: translate(displacedIcosahedron(0, 0.28, 11), 0.45),
                        material: createStandardMaterial(color, base),
                        shaded: true,
                    },
                ],
            };

        case "hill":
            return {
                castShadow: false,
                parts: [
                    {
                        geometry: displacedIcosahedron(1, 0.22, 5),
                        material: createStandardMaterial(color, { ...base, envMapIntensity: 0.15 }),
                        shaded: true,
                    },
                ],
            };

        case "cloud":
            return {
                castShadow: false,
                parts: [
                    {
                        geometry: displacedIcosahedron(1, 0.3, 3),
                        material: createStandardMaterial(color, {
                            ...base,
                            emissive: color,
                            emissiveIntensity: 0.35,
                            envMapIntensity: 0.2,
                        }),
                        shaded: false,
                    },
                ],
            };

        default:
            throw new Error(`渲染器不支持的装饰物类型：${spec.type}`);
    }
}

/* ------------------------------------------------------------------ */
/* 散布                                                                 */
/* ------------------------------------------------------------------ */

const areaWeight = (a) =>
    a.shape === "disc" ? Math.PI * a.radius * a.radius : a.size[0] * a.size[1];

function sampleArea(area, rng) {
    if (area.shape === "disc") {
        const r = area.radius * Math.sqrt(rng());
        const t = rng() * Math.PI * 2;
        return [area.center.x + Math.cos(t) * r, area.center.z + Math.sin(t) * r];
    }
    return [
        area.center.x + (rng() - 0.5) * area.size[0],
        area.center.z + (rng() - 0.5) * area.size[1],
    ];
}

/**
 * 在 areas（或整张地图 bounds）内随机取 count 个点，要求满足 clearance。
 * 每个点附带 4 个 0~1 的随机数供缩放 / 旋转 / 明暗使用。
 */
function scatter(spec, options, ctx, rng) {
    const points = [];
    const bounds = ctx.bounds;
    const areas = spec.areas && spec.areas.length ? spec.areas : null;
    const totalWeight = areas ? areas.reduce((s, a) => s + areaWeight(a), 0) : 0;
    const skipChecks = spec.type === "cloud";
    const maxTries = options.count * 40;

    for (let tries = 0; tries < maxTries && points.length < options.count; tries++) {
        let x;
        let z;

        if (areas) {
            let pick = rng() * totalWeight;
            let area = areas[areas.length - 1];
            for (const a of areas) {
                pick -= areaWeight(a);
                if (pick <= 0) {
                    area = a;
                    break;
                }
            }
            [x, z] = sampleArea(area, rng);
        } else {
            const c = options.clearance;
            x = bounds.x[0] + c + rng() * (bounds.x[1] - bounds.x[0] - c * 2);
            z = bounds.z[0] + c + rng() * (bounds.z[1] - bounds.z[0] - c * 2);
        }

        if (!skipChecks && !ctx.layout.isFree(x, z, options.clearance))
            continue;

        points.push({ x, z, r1: rng(), r2: rng(), r3: rng(), r4: rng() });
    }

    return points;
}

/* ------------------------------------------------------------------ */
/* 构建                                                                 */
/* ------------------------------------------------------------------ */

/**
 * @param {object[]} list 解析后的 decorations
 * @param {{layout: object, bounds: object, look: object, heightAt: (x:number, z:number) => number}} ctx
 * @returns {{group: THREE.Group, update: (dt:number) => void}}
 */
export function buildDecorations(list, ctx) {
    const group = new THREE.Group();
    const clouds = [];
    const dummy = new THREE.Object3D();
    const tint = new THREE.Color();
    const wrapMin = ctx.bounds.x[0] - 350;
    const wrapMax = ctx.bounds.x[1] + 350;

    for (const spec of list || []) {
        const def = TYPE_DEFAULTS[spec.type];
        if (!def)
            throw new Error(`渲染器不支持的装饰物类型：${spec.type}`);

        const options = {
            count: spec.count,
            scale: spec.scale || def.scale,
            clearance: spec.clearance ?? def.clearance,
            shade: spec.shade || def.shade,
            altitude: spec.altitude || def.altitude,
        };

        const rng = mulberry32((Math.imul(spec.seed, 2654435761) >>> 0) || 1);
        const points = scatter(spec, options, ctx, rng);
        if (points.length === 0)
            continue;

        const { parts, castShadow } = createParts(spec, ctx.look);
        const meshes = parts.map((part) => {
            const mesh = new THREE.InstancedMesh(part.geometry, part.material, points.length);
            mesh.castShadow = castShadow;
            mesh.receiveShadow = true;
            return mesh;
        });

        points.forEach((p, i) => {
            const s = options.scale[0] + (options.scale[1] - options.scale[0]) * p.r1;
            // 非均匀缩放让岩石 / 山丘 / 云更像自然物
            const sx = 0.8 + p.r3 * 0.5;
            const sz = 0.8 + p.r4 * 0.5;
            const sy =
                spec.type === "hill" ? 0.42 + p.r3 * 0.16 : spec.type === "cloud" ? 0.55 : 1;
            const y =
                ctx.heightAt(p.x, p.z) +
                options.altitude[0] +
                (options.altitude[1] - options.altitude[0]) * p.r2;

            dummy.position.set(p.x, y, p.z);
            dummy.rotation.set(0, p.r4 * Math.PI * 2, 0);
            dummy.scale.set(s * (spec.type === "cloud" ? 1.6 * sx : sx), s * sy, s * sz);
            dummy.updateMatrix();

            const shade =
                options.shade[0] + (options.shade[1] - options.shade[0]) * p.r1;
            tint.setScalar(shade);

            meshes.forEach((mesh, j) => {
                mesh.setMatrixAt(i, dummy.matrix);
                if (parts[j].shaded)
                    mesh.setColorAt(i, tint);
            });

            if (spec.type === "cloud" && spec.drift > 0) {
                clouds.push({
                    mesh: meshes[0],
                    index: i,
                    x: p.x,
                    y,
                    z: p.z,
                    speed: spec.drift * (0.6 + 0.8 * p.r3),
                    rotation: dummy.rotation.y,
                    scale: dummy.scale.clone(),
                });
            }
        });

        for (const mesh of meshes) {
            mesh.instanceMatrix.needsUpdate = true;
            if (mesh.instanceColor)
                mesh.instanceColor.needsUpdate = true;
            // 包含所有实例的包围球，避免整体被错误剔除
            if (typeof mesh.computeBoundingSphere === "function")
                mesh.computeBoundingSphere();
            else
                mesh.frustumCulled = false;
            group.add(mesh);
        }
    }

    return {
        group,
        /** 每帧调用：云朵缓慢漂移，越过边界后从另一侧回来 */
        update(dt) {
            if (clouds.length === 0)
                return;

            for (const c of clouds) {
                c.x += c.speed * dt;
                if (c.x > wrapMax)
                    c.x = wrapMin;
                dummy.position.set(c.x, c.y, c.z);
                dummy.rotation.set(0, c.rotation, 0);
                dummy.scale.copy(c.scale);
                dummy.updateMatrix();
                c.mesh.setMatrixAt(c.index, dummy.matrix);
                c.mesh.instanceMatrix.needsUpdate = true;
            }
        },
    };
}
