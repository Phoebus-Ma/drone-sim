/**
 * main.js —— 入口：解析 URL 参数、初始化流程编排
 *
 * 流程：URL ?map=<name> → loader 加载 maps/<name>.json → （成功后才）创建渲染引擎
 *       → 固定步长物理循环（1/120s + accumulator）→ 渲染插值 → HUD（10Hz）
 */

import { loadMap, MapLoadError, MapParseError } from "./loader.js";
import {
    PHYSICS_CONFIG,
    createCollisionWorld,
    createInitialState,
    step,
    isOutOfBounds,
} from "./physics.js";
import { Controls, KeyboardInputSource } from "./controls.js";
import { Hud, showLoading, showError, hideOverlay } from "./hud.js";

const DEFAULT_MAP = "map-valley";
const MAP_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const COLLISION_MESSAGE_MS = 800;

function getMapName() {
    const raw = new URLSearchParams(window.location.search).get("map");
    return raw && raw.trim() ? raw.trim() : DEFAULT_MAP;
}

async function bootstrap() {
    const mapName = getMapName();
    showLoading(mapName);

    if (!MAP_NAME_PATTERN.test(mapName)) {
        showError(
            `地图加载失败：${mapName}`,
            ["地图名只能包含字母、数字、下划线（_）和连字符（-）。"],
            "示例：?map=map-valley",
        );

        return;
    }

    let mapData;
    try {
        mapData = await loadMap(`maps/${mapName}.json`, { name: mapName }); // 路径由 URL 参数拼接，不硬编码地图名
    } catch (err) {
        if (err instanceof MapLoadError) {
            showError(
                `地图加载失败：${mapName}`,
                [err.reason],
                `请确认 maps/${mapName}.json 文件存在。`,
            );
        }
        else if (err instanceof MapParseError) {
            showError(
                `地图数据错误：${mapName}`,
                err.details,
                "请检查地图 JSON 中上述字段。",
            );
        }
        else {
            showError(`地图加载失败：${mapName}`, [
                String((err && err.message) || err),
            ]);
        }

        return;
    }

    // 地图有效后才加载渲染引擎（Three.js），失败时不会出现空场景
    let Engine;
    try {
        ({ Engine } = await import("./engine.js"));
    } catch (err) {
        showError(
            "渲染引擎加载失败",
            [`无法加载 Three.js：${err.message}`],
            "请检查网络能否访问 cdn.jsdelivr.net。",
        );

        return;
    }

    startSimulation(mapData, Engine);
}

function startSimulation(mapData, Engine) {
    const world = createCollisionWorld(mapData.collision);
    const spawn = mapData.meta.spawn;

    const engine = new Engine(document.getElementById("viewport"), {
        getGroundHeight: world.getGroundHeight,
    });

    engine.buildMap(mapData);

    const hud = new Hud();
    const controls = new Controls();
    controls.addSource(new KeyboardInputSource(window));
    // 未来：controls.addSource(new TouchJoystickSource(...));

    const STEP = PHYSICS_CONFIG.fixedTimeStep;
    let state = createInitialState(spawn);
    let prevState = state;
    let accumulator = 0;
    let input = { throttle: 0.5, pitch: 0, roll: 0, yaw: 0 };
    let seenCollisions = 0;
    let lastCollisionAt = -Infinity;

    const reset = () => {
        state = createInitialState(spawn); // 位置、姿态、速度、电量全部恢复
        prevState = state;
        accumulator = 0;
        seenCollisions = 0;
        lastCollisionAt = -Infinity;
        controls.reset();
        engine.resetView(state);
        hud.invalidate();
    };

    controls.on("reset", reset);

    engine.resetView(state);
    hideOverlay();
    hud.show(mapData.meta.name);

    engine.start((frameDt, now) => {
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

bootstrap().catch((err) => {
    showError(
        "模拟器初始化失败",
        [String((err && err.message) || err)],
        "请确认浏览器支持 WebGL 及 ES Module/importmap。",
    );
});
