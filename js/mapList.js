/**
 * mapList.js —— 地图清单（maps/index.json 是唯一事实来源）
 *
 * loadMapList() -> Promise<MapEntry[]>
 *   MapEntry = { id: string, name: string, cover: string|null }
 *
 * 新增地图：把 maps/<id>.json 放进去，再在 maps/index.json 增加一条即可，
 * 前端代码无需改动。
 *
 * 校验规则（与 URL ?map= 的约束保持一致，id 可直接拼接地图数据路径）：
 *   - 顶层必须是非空数组
 *   - id 只能包含字母、数字、下划线、连字符，且不可重复
 *   - name 必须是非空字符串
 *   - cover 可为 null，或相对路径字符串
 */

export const MAP_LIST_URL = "maps/index.json";

/** 地图 id / ?map= 允许的字符集 */
export const MAP_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** 地图清单获取或解析失败 */
export class MapListError extends Error {
    constructor(message, details = [message]) {
        super(message);
        this.name = "MapListError";
        this.details = details;
    }
}

/**
 * @param {string} [url] 清单地址（默认 maps/index.json，相对路径以页面为基准）
 * @returns {Promise<{id:string,name:string,cover:string|null}[]>}
 */
export async function loadMapList(url = MAP_LIST_URL) {
    let response;
    try {
        response = await fetch(url, { cache: "no-cache" });
    } catch (err) {
        throw new MapListError(`地图清单获取失败：${url}`, [
            `网络错误，无法获取 ${url}（${err.message}）`,
        ]);
    }

    if (!response.ok) {
        throw new MapListError(`地图清单获取失败：${url}`, [
            `服务器返回 HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`,
            `请确认 ${url} 存在。`,
        ]);
    }

    let data;
    try {
        data = await response.json();
    } catch (err) {
        throw new MapListError("地图清单格式错误", [
            `JSON 语法错误：${err.message}`,
        ]);
    }

    return validateMapList(data);
}

function validateMapList(data) {
    if (!Array.isArray(data) || data.length === 0) {
        throw new MapListError("地图清单格式错误", [
            `${MAP_LIST_URL} 必须是非空数组。`,
        ]);
    }

    const seen = new Set();
    const entries = [];

    data.forEach((item, index) => {
        const where = `清单第 ${index + 1} 项`;

        if (!item || typeof item !== "object" || Array.isArray(item)) {
            throw new MapListError("地图清单格式错误", [
                `${where} 必须是对象。`,
            ]);
        }

        const id = typeof item.id === "string" ? item.id.trim() : "";
        if (!MAP_ID_PATTERN.test(id)) {
            throw new MapListError("地图清单格式错误", [
                `${where} 的 id 非法：“${String(item.id)}”，只能包含字母、数字、下划线（_）和连字符（-）。`,
            ]);
        }

        if (seen.has(id)) {
            throw new MapListError("地图清单格式错误", [
                `${where} 的 id 重复：“${id}”。`,
            ]);
        }
        seen.add(id);

        const name = typeof item.name === "string" ? item.name.trim() : "";
        if (!name) {
            throw new MapListError("地图清单格式错误", [
                `${where}（${id}）缺少有效的 name。`,
            ]);
        }

        let cover = null;
        if (item.cover !== null && item.cover !== undefined) {
            if (typeof item.cover !== "string" || !item.cover.trim()) {
                throw new MapListError("地图清单格式错误", [
                    `${where}（${id}）的 cover 必须为 null 或相对路径字符串。`,
                ]);
            }
            cover = item.cover.trim();
        }

        entries.push({ id, name, cover });
    });

    return entries;
}
