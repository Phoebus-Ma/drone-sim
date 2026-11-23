/**
 * main.js —— 入口：地图清单、地图切换、初始化流程编排
 *
 * 流程：
 *   ?map=<id> → 直接加载该地图（清单仍会加载，供 M 面板使用）
 *   无 ?map   → 首屏显示地图选择面板，选择后加载
 *   切换地图   → 引擎与输入只创建一次；engine.buildMap() 内部先释放旧场景资源，
 *               物理状态按新地图 spawn 重置，URL 的 ?map= 同步为所选地图
 */

import { loadMap, MapLoadError, MapParseError } from "./loader.js";
import { loadMapList, MapListError, MAP_ID_PATTERN } from "./mapList.js";
import { MapMenu } from "./mapMenu.js";
import {
    PHYSICS_CONFIG,
    createCollisionWorld,
    createInitialState,
    step,
    isOutOfBounds,
} from "./physics.js";
import { Controls, KeyboardInputSource } from "./controls.js";
import { TouchInputSource } from "./touchControls.js";
import { Hud, showLoading, showError, hideOverlay } from "./hud.js";

const COLLISION_MESSAGE_MS = 800;

/* ------------------------------------------------------------------ */
/* 运行时状态（引擎 / 输入 / 物理状态在多次切图之间复用）               */
/* ------------------------------------------------------------------ */

let engine = null;
let controls = null;
let hud = null;
let menu = null;
let currentMapId = null;

let world = null;
let spawn = null;
let state = null;
let prevState = null;
let accumulator = 0;
let input = { throttle: 0.5, pitch: 0, roll: 0, yaw: 0 };
let seenCollisions = 0;
let lastCollisionAt = -Infinity;
let loopStarted = false;

/* ------------------------------------------------------------------ */
/* URL 同步                                                            */
/* ------------------------------------------------------------------ */

function getRequestedMap() {
    const raw = new URLSearchParams(window.location.search).get("map");
    return raw && raw.trim() ? raw.trim() : null;
}

/** 切换地图后让 ?map= 与所选地图一致（replaceState，不新增历史记录） */
function syncMapUrl(mapId) {
    const url = new URL(window.location.href);
    url.searchParams.set("map", mapId);

    try {
        history.replaceState(null, "", url);
    }
    catch {
        // file:// 等受限环境忽略即可，不影响飞行
    }
}

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

async function bootstrap() {
    const requested = getRequestedMap();

    // 清单是面板的唯一数据源；即使 URL 直接指定地图也尝试加载，供 M 面板使用
    let listError = null;
    try {
        await loadList();
    }
    catch (err) {
        listError = err;
    }

    if (requested) {
        showLoading(requested);
        await enterMap(requested);
        return;
    }

    if (!menu) {
        showError(
            "地图清单加载失败",
            listError instanceof MapListError ? listError.details : [
                String((listError && listError.message) || listError),
            ],
            "请检查 maps/index.json。也可以使用 ?map=map-valley 直接进入。",
        );

        return;
    }

    hideOverlay();
    menu.open();
}

async function loadList() {
    const items = await loadMapList();

    if (!menu) {
        menu = new MapMenu({
            items,
            canClose: () => currentMapId !== null,
            onSelect: (id) => enterMap(id),
        });
    }

    return items;
}

/* ------------------------------------------------------------------ */
/* 地图加载 / 切换                                                      */
/* ------------------------------------------------------------------ */

/**
 * 加载并进入地图（首屏直连或面板选择共用）。
 * 面板打开时错误显示在面板内；否则使用全屏错误覆盖层。
 */
async function enterMap(mapName) {
    const viaMenu = Boolean(menu && menu.isOpen);

    if (mapName === currentMapId) {
        menu?.close();
        hideOverlay();

        return true;
    }

    if (!MAP_ID_PATTERN.test(mapName)) {
        showError(
            `地图加载失败：${mapName}`,
            ["地图名只能包含字母、数字、下划线（_）和连字符（-）。"],
            "示例：?map=map-valley",
        );

        return false;
    }

    if (viaMenu)
        menu.setBusy(mapName);
    else
        showLoading(mapName);

    let mapData;
    try {
        mapData = await loadMap(`maps/${mapName}.json`, { name: mapName });
    }
    catch (err) {
        reportMapError(mapName, err, viaMenu);

        return false;
    }

    try {
        await ensureEngine();
    }
    catch (err) {
        reportEngineError(err, viaMenu);

        return false;
    }

    try {
        applyMap(mapName, mapData);
    }
    catch (err) {
        reportMapError(mapName, err, viaMenu);

        return false;
    }

    menu?.setBusy(null);
    menu?.close();
    hideOverlay();

    return true;
}

/** 引擎、输入、HUD 只创建一次，切图时复用 */
async function ensureEngine() {
    if (engine)
        return;

    let Engine;
    try {
        ({ Engine } = await import("./engine.js"));
    }
    catch (err) {
        throw new Error(`无法加载 Three.js：${err.message}`);
    }

    engine = new Engine(document.getElementById("viewport"), {
        // world 在切图时替换，这里用闭包读取当前世界
        getGroundHeight: (x, z) => world.getGroundHeight(x, z),
    });

    hud = new Hud();
    controls = new Controls();
    controls.addSource(new KeyboardInputSource(window));
    controls.addSource(new TouchInputSource()); // 无触摸设备时自动保持隐藏
    controls.on("reset", resetSimulation);

    const mapButton = document.getElementById("hud-map-btn");
    mapButton?.addEventListener("click", openMenu);
}

function applyMap(mapName, mapData) {
    world = createCollisionWorld(mapData.collision);
    spawn = mapData.meta.spawn;

    engine.buildMap(mapData); // 内部先 dispose 上一张地图的几何体 / 材质 / 纹理
    resetSimulation();

    currentMapId = mapName;
    hud.show(mapData.meta.name);
    syncMapUrl(mapName);
    menu?.setCurrent(mapName);

    startLoop();
}

function resetSimulation() {
    if (!spawn)
        return;

    state = createInitialState(spawn); // 位置、姿态、速度、电量全部恢复
    prevState = state;
    accumulator = 0;
    seenCollisions = 0;
    lastCollisionAt = -Infinity;
    controls.reset();
    engine.resetView(state);
    hud.invalidate();
}

/* ------------------------------------------------------------------ */
/* 固定步长主循环（只启动一次）                                          */
/* ------------------------------------------------------------------ */

function startLoop() {
    if (loopStarted)
        return;

    loopStarted = true;
    const STEP = PHYSICS_CONFIG.fixedTimeStep;

    engine.start((frameDt, now) => {
        if (!state || !world)
            return;

        const dt = Math.min(frameDt, PHYSICS_CONFIG.maxFrameTime);
        input = controls.update(dt);

        accumulator += dt;
        while (accumulator >= STEP) {
            prevState = state;
            state = step(state, input, world, STEP);
            accumulator -= STEP;
        }

        if (state.collisionCount !== seenCollisions) {
            seenCollisions = state.collisionCount;
            lastCollisionAt = now;
            engine.shake(Math.min(1, state.lastImpactSpeed / 8));
        }

        engine.renderFrame(prevState, state, accumulator / STEP, dt);

        const p = state.position;
        hud.update(
            {
                altitude:
                    p.y -
                    PHYSICS_CONFIG.droneRadius -
                    world.getGroundHeight(p.x, p.z),
                horizontalSpeed: Math.hypot(state.velocity.x, state.velocity.z),
                verticalSpeed: state.velocity.y,
                heading: -state.yaw, // 航向按罗盘习惯：右转增大
                batteryRatio: state.battery / PHYSICS_CONFIG.batteryCapacity,
                throttle: input.throttle,
                pitch: state.pitch,
                roll: state.roll,
                crashed: state.crashed,
                powerLost: state.battery <= 0,
                outOfBounds: isOutOfBounds(p, world.bounds),
                collisionActive: now - lastCollisionAt < COLLISION_MESSAGE_MS,
                impactSpeed: state.lastImpactSpeed,
            },
            now,
        );
    });
}

/* ------------------------------------------------------------------ */
/* 地图面板                                                            */
/* ------------------------------------------------------------------ */

function openMenu() {
    if (!menu) {
        showError(
            "地图清单不可用",
            ["无法读取 maps/index.json，暂时无法切换地图。"],
            "请检查网络或文件后刷新页面。",
        );

        return;
    }

    menu.open();
}

/* ------------------------------------------------------------------ */
/* 错误提示                                                            */
/* ------------------------------------------------------------------ */

function reportMapError(mapName, err, inline) {
    const info = describeMapError(mapName, err);

    if (inline && menu) {
        menu.setBusy(null);
        menu.showError(`${info.title}：${info.details.join("；")}`);

        return;
    }

    menu?.setBusy(null);
    showError(info.title, info.details, info.hint);
}

function describeMapError(mapName, err) {
    if (err instanceof MapLoadError) {
        return {
            title: `地图加载失败：${mapName}`,
            details: [err.reason],
            hint: `请确认 maps/${mapName}.json 文件存在。`,
        };
    }

    if (err instanceof MapParseError) {
        return {
            title: `地图数据错误：${mapName}`,
            details: err.details,
            hint: "请检查地图 JSON 中上述字段。",
        };
    }

    return {
        title: `地图加载失败：${mapName}`,
        details: [String((err && err.message) || err)],
        hint: "",
    };
}

function reportEngineError(err, inline) {
    const title = "渲染引擎加载失败";
    const details = [err.message];

    if (inline && menu) {
        menu.setBusy(null);
        menu.showError(`${title}：${err.message}`);

        return;
    }

    menu?.setBusy(null);
    showError(title, details, "请检查网络能否访问 cdn.jsdelivr.net。");
}

bootstrap().catch((err) => {
    showError(
        "模拟器初始化失败",
        [String((err && err.message) || err)],
        "请确认浏览器支持 WebGL 及 ES Module/importmap。",
    );
});
