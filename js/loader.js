/**
 * loader.js —— 地图加载器（唯一的地图加载入口）
 *
 * loadMap(url, { name, format }) -> Promise<MapData>
 *   1. 根据扩展名（或显式 format）选择解析器
 *   2. fetch 获取数据；失败 → MapLoadError（文件不存在 / 网络错误）
 *   3. 反序列化 + 调用解析器 parse(data)；失败 → MapParseError（语法错误 / 字段缺失或非法）
 *
 * 扩展方式：在 mapParser/ 下新增解析器（导出 parse(data) -> MapData），
 * 然后在下方 PARSERS 中注册即可，其他模块无需改动。
 */

import { parse as parseJson } from "./mapParser/jsonParser.js";

const PARSERS = {
    json: {
        parse: parseJson,
        // 将 Response 读取为解析器所需的输入
        read: async (response) => {
            const text = await response.text();
            try {
                return JSON.parse(text);
            } catch (err) {
                throw new MapParseError(`JSON 语法错误：${err.message}`, [
                    `JSON 语法错误：${err.message}`,
                ]);
            }
        },
    },
    // 未来：
    // glb: { parse: parseGlb, read: (response) => response.arrayBuffer() },
};

/** 地图文件获取失败（不存在 / 网络错误） */
export class MapLoadError extends Error {
    constructor(mapName, reason) {
        super(`地图加载失败：${mapName}`);
        this.name    = "MapLoadError";
        this.mapName = mapName;
        this.reason  = reason;
    }
}

/** 地图内容非法（JSON 语法错误 / 缺少必需字段 / 字段取值非法） */
export class MapParseError extends Error {
    constructor(message, details = [message]) {
        super(message);
        this.name = "MapParseError";
        this.details = details;
    }
}

function detectFormat(url) {
    const clean = url.split(/[?#]/)[0];
    const dot   = clean.lastIndexOf(".");

    return dot >= 0 ? clean.slice(dot + 1).toLowerCase() : "";
}

/**
 * @param {string} url  地图文件路径（如 maps/map-valley.json）
 * @param {{name?: string, format?: string}} [options]
 * @returns {Promise<object>} MapData
 */
export async function loadMap(url, { name = url, format } = {}) {
    const fmt = format || detectFormat(url);
    const parser = PARSERS[fmt];
    if (!parser) {
        throw new MapParseError(`不支持的地图格式：“${fmt || "无扩展名"}”`);
    }

    let response;
    try {
        response = await fetch(url, { cache: "no-cache" });
    } catch (err) {
        throw new MapLoadError(
            name,
            `网络错误，无法获取 ${url}（${err.message}）`,
        );
    }

    if (!response.ok) {
        throw new MapLoadError(
            name,
            `服务器返回 HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}：${url}`,
        );
    }

    let data;
    try {
        data = await parser.read(response);
    } catch (err) {
        if (err instanceof MapParseError)
            throw err;

        throw new MapLoadError(name, `读取地图响应失败：${err.message}`);
    }

    try {
        return parser.parse(data);
    } catch (err) {
        if (err instanceof MapParseError)
            throw err;

        throw new MapParseError(err.message, err.details || [err.message]);
    }
}
