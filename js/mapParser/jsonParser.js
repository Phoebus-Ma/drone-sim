/**
 * mapParser/jsonParser.js —— JSON 地图解析器
 *
 * 统一解析器接口：parse(data) -> MapData
 *   - data：已反序列化的 JSON 对象
 *   - 校验失败时抛出 Error（name = 'MapValidationError'，details 为逐条错误），
 *     由 loader.js 统一包装为 MapParseError。
 *
 * MapData（所有解析器的统一输出，内部坐标统一为 {x, y, z} 对象）：
 * {
 *   format: 'json',
 *   meta: { name, version, bounds: { x: [min,max], z: [min,max] },
 *           spawn: { position: {x,y,z}, rotation }, wind: { direction, strength } },
 *   terrain: { type: 'flat', color },
 *   objects: [{ type, position: {x,y,z}, rotation: {x,y,z}, size: number[], color, collidable }],
 *   checkpoints: [{ position: {x,y,z}, radius }],
 *   collision: { terrain: { type }, bounds, wind, colliders: [{ min: {x,y,z}, max: {x,y,z}, objectIndex }] }
 * }
 *
 * 物体局部坐标约定（与渲染端几何体一致）：
 *   box：中心在原点；cylinder：轴沿局部 Y；torus：位于局部 XY 平面（法线沿 Z，即默认竖立、
 *   面向 +Z 飞行路线）。rotation 为欧拉角 (rx, ry, rz)，顺序 XYZ，弧度。
 */

const SIZE_SPEC = {
    box      : { count: 3, label: "[宽, 高, 深]" },
    cylinder : { count: 2, label: "[半径, 高度]" },
    torus    : { count: 2, label: "[主半径, 管半径]" },
};
const TERRAIN_TYPES = ["flat"];
const COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export function parse(data) {
    const v = new Validator();

    const root = v.object(data, "地图根节点");
    if (!root)
        v.throwIfErrors();

    const meta        = parseMeta(v, root.meta);
    const terrain     = parseTerrain(v, root.terrain);
    const objects     = parseObjects(v, root.objects);
    const checkpoints = parseCheckpoints(v, root.checkpoints);

    v.throwIfErrors();

    const colliders = [];
    objects.forEach((obj, index) => {
        if (!obj.collidable)
            return;

        colliders.push({ ...computeWorldAabb(obj), objectIndex: index });
    });

    return {
        format: "json",
        meta,
        terrain,
        objects,
        checkpoints,
        collision: {
            terrain: { type: terrain.type },
            bounds: meta.bounds,
            wind: meta.wind,
            colliders,
        },
    };
}

/* ------------------------------------------------------------------ */
/* 各段解析                                                            */
/* ------------------------------------------------------------------ */

function parseMeta(v, raw) {
    const meta = v.object(raw, "meta");
    if (!meta)
        return null;

    const bounds = v.object(meta.bounds, "meta.bounds");
    const spawn  = v.object(meta.spawn, "meta.spawn");
    const wind   = v.object(meta.wind, "meta.wind", { optional: true }); // 预留字段，可省略

    return {
        name    : v.string(meta.name, "meta.name"),
        version : v.number(meta.version, "meta.version"),
        bounds  : bounds && {
            x   : v.range(bounds.x, "meta.bounds.x"),
            z   : v.range(bounds.z, "meta.bounds.z"),
        },
        spawn   : spawn && {
            position: v.vec3(spawn.position, "meta.spawn.position"),
            rotation: v.number(spawn.rotation, "meta.spawn.rotation"),
        },
        wind    : {
            direction: wind
                ? v.number(wind.direction, "meta.wind.direction")
                : 0,
            strength: wind
                ? v.number(wind.strength, "meta.wind.strength", { min: 0 })
                : 0,
        },
    };
}

function parseTerrain(v, raw) {
    const terrain = v.object(raw, "terrain");
    if (!terrain)
        return null;

    return {
        type: v.oneOf(terrain.type, "terrain.type", TERRAIN_TYPES),
        color: v.color(terrain.color, "terrain.color"),
    };
}

function parseObjects(v, raw) {
    const list = v.array(raw, "objects");
    if (!list)
        return [];

    return list.map((item, i) => {
        const path = `objects[${i}]`;
        const obj = v.object(item, path);

        if (!obj)
            return null;

        const type = v.oneOf(obj.type, `${path}.type`, Object.keys(SIZE_SPEC));

        return {
            type,
            position: v.vec3(obj.position, `${path}.position`),
            rotation: v.vec3(obj.rotation, `${path}.rotation`, {
                optional: true,
                fallback: [0, 0, 0],
            }),
            size: type ? v.size(obj.size, `${path}.size`, type) : null,
            color: v.color(obj.color, `${path}.color`),
            collidable: v.boolean(obj.collidable, `${path}.collidable`, {
                optional: true,
                fallback: true,
            }),
        };
    });
}

function parseCheckpoints(v, raw) {
    const list = v.array(raw, "checkpoints", { optional: true });
    if (!list)
        return [];

    return list.map((item, i) => {
        const path = `checkpoints[${i}]`;
        const cp = v.object(item, path);

        if (!cp)
            return null;

        return {
            position: v.vec3(cp.position, `${path}.position`),
            radius: v.number(cp.radius, `${path}.radius`, { positive: true }),
        };
    });
}

/* ------------------------------------------------------------------ */
/* 世界 AABB（纯数学，不依赖 Three.js）                                 */
/* ------------------------------------------------------------------ */

function localHalfExtents(type, size) {
    switch (type) {
        case "box":
            return [size[0] / 2, size[1] / 2, size[2] / 2];
        case "cylinder":
            return [size[0], size[1] / 2, size[0]];
        case "torus":
            return [size[0] + size[1], size[0] + size[1], size[1]];
        default:
            throw new Error(`未知物体类型：${type}`);
    }
}

/** 欧拉角 XYZ 顺序的旋转矩阵（行优先 3x3），与 Three.js 默认 Euler 顺序一致 */
function rotationMatrixXYZ(rx, ry, rz) {
    const a = Math.cos(rx),
        b = Math.sin(rx);
    const c = Math.cos(ry),
        d = Math.sin(ry);
    const e = Math.cos(rz),
        f = Math.sin(rz);
    const ae = a * e,
        af = a * f,
        be = b * e,
        bf = b * f;

    return [
        [c * e, -c * f, d],
        [af + be * d, ae - bf * d, -b * c],
        [bf - ae * d, be + af * d, a * c],
    ];
}

function computeWorldAabb(obj) {
    const h = localHalfExtents(obj.type, obj.size);
    const m = rotationMatrixXYZ(obj.rotation.x, obj.rotation.y, obj.rotation.z);
    const ext = m.map(
        (row) =>
            Math.abs(row[0]) * h[0] +
            Math.abs(row[1]) * h[1] +
            Math.abs(row[2]) * h[2],
    );
    const p = obj.position;

    return {
        min: { x: p.x - ext[0], y: p.y - ext[1], z: p.z - ext[2] },
        max: { x: p.x + ext[0], y: p.y + ext[1], z: p.z + ext[2] },
    };
}

/* ------------------------------------------------------------------ */
/* 校验工具：收集全部错误后一次性抛出，信息精确到字段路径                */
/* ------------------------------------------------------------------ */

function describe(value) {
    if (value === null)
        return "null";

    if (Array.isArray(value)) {
        const s = JSON.stringify(value);
        return s.length > 40 ? `${s.slice(0, 40)}…` : s;
    }

    if (typeof value === "string")
        return `"${value}"`;

    if (typeof value === "object")
        return "对象";

    return String(value);
}

const isPlainObject = (x) =>
    x !== null && typeof x === "object" && !Array.isArray(x);
const isFiniteNumber = (x) => typeof x === "number" && Number.isFinite(x);

class Validator {
    constructor() {
        this.errors = [];
    }

    fail(path, message) {
        this.errors.push(`${path}：${message}`);
        return null;
    }

    throwIfErrors() {
        if (this.errors.length === 0)
            return;

        const err   = new Error(this.errors.join("\n"));
        err.name    = "MapValidationError";
        err.details = [...this.errors];

        throw err;
    }

    missing(value, path, optional) {
        if (value !== undefined)
            return false;

        if (!optional)
            this.fail(path, "缺少必需字段");

        return true;
    }

    object(value, path, { optional = false } = {}) {
        if (this.missing(value, path, optional))
            return null;

        if (!isPlainObject(value))
            return this.fail(path, `应为对象，实际为 ${describe(value)}`);

        return value;
    }

    array(value, path, { optional = false } = {}) {
        if (this.missing(value, path, optional))
            return null;

        if (!Array.isArray(value))
            return this.fail(path, `应为数组，实际为 ${describe(value)}`);

        return value;
    }

    number(
        value,
        path,
        { optional = false, fallback = null, positive = false, min } = {},
    ) {
        if (this.missing(value, path, optional))
            return fallback;

        if (!isFiniteNumber(value))
            return this.fail(path, `应为数值，实际为 ${describe(value)}`);

        if (positive && value <= 0)
            return this.fail(path, `必须大于 0，实际为 ${value}`);

        if (min !== undefined && value < min)
            return this.fail(path, `不能小于 ${min}，实际为 ${value}`);

        return value;
    }

    string(value, path) {
        if (this.missing(value, path, false))
            return null;

        if (typeof value !== "string" || value.trim() === "") {
            return this.fail(path, `应为非空字符串，实际为 ${describe(value)}`);
        }

        return value;
    }

    boolean(value, path, { optional = false, fallback = null } = {}) {
        if (this.missing(value, path, optional))
            return fallback;

        if (typeof value !== "boolean")
            return this.fail(
                path,
                `应为 true/false，实际为 ${describe(value)}`,
            );

        return value;
    }

    color(value, path) {
        if (this.missing(value, path, false))
            return null;

        if (typeof value !== "string" || !COLOR_PATTERN.test(value)) {
            return this.fail(
                path,
                `应为十六进制颜色（如 "#4a7c4e"），实际为 ${describe(value)}`,
            );
        }

        return value;
    }

    oneOf(value, path, options) {
        if (this.missing(value, path, false))
            return null;

        if (!options.includes(value)) {
            return this.fail(
                path,
                `不支持的取值 ${describe(value)}，可选：${options.join(" / ")}`,
            );
        }

        return value;
    }

    vec3(value, path, { optional = false, fallback = null } = {}) {
        let arr = value;
        if (value === undefined && optional)
            arr = fallback;
        else if (this.missing(value, path, optional))
            return null;

        if (
            !Array.isArray(arr) ||
            arr.length !== 3 ||
            !arr.every(isFiniteNumber)
        ) {
            return this.fail(
                path,
                `应为 3 个数值的数组 [x, y, z]，实际为 ${describe(value)}`,
            );
        }

        return { x: arr[0], y: arr[1], z: arr[2] };
    }

    range(value, path) {
        if (this.missing(value, path, false))
            return null;

        if (
            !Array.isArray(value) ||
            value.length !== 2 ||
            !value.every(isFiniteNumber)
        ) {
            return this.fail(
                path,
                `应为 [最小值, 最大值]，实际为 ${describe(value)}`,
            );
        }

        if (value[0] >= value[1])
            return this.fail(
                path,
                `最小值必须小于最大值，实际为 ${describe(value)}`,
            );

        return [value[0], value[1]];
    }

    size(value, path, type) {
        const spec = SIZE_SPEC[type];
        if (this.missing(value, path, false))
            return null;

        if (
            !Array.isArray(value) ||
            value.length !== spec.count ||
            !value.every(isFiniteNumber)
        ) {
            return this.fail(
                path,
                `${type} 需要 ${spec.count} 个数值 ${spec.label}，实际为 ${describe(value)}`,
            );
        }

        if (!value.every((n) => n > 0))
            return this.fail(
                path,
                `尺寸必须全部大于 0，实际为 ${describe(value)}`,
            );

        return [...value];
    }
}
