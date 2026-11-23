/**
 * hud.js —— 仪表 HUD（DOM 实现，覆盖在 canvas 上）
 *
 * - update() 内部限频 10Hz，且只在数值/状态变化时写 DOM，避免每帧重排
 * - 低电量（< 20%）只切换 CSS class，闪烁由 CSS animation 实现（不使用 JS 定时器）
 * - 同时提供 loading / 错误覆盖层
 */

const UPDATE_INTERVAL_MS   = 100; // 10Hz
const LOW_BATTERY_RATIO    = 0.2;
const ATTITUDE_PITCH_SCALE = 120; // 姿态仪：每弧度俯仰对应的像素位移

const $ = (id) => document.getElementById(id);

export class Hud {
    constructor() {
        this.root = $("hud");
        this.el = {
            mapName       : $("hud-map-name"),
            altitude      : $("hud-altitude"),
            hSpeed        : $("hud-hspeed"),
            vSpeed        : $("hud-vspeed"),
            heading       : $("hud-heading"),
            battery       : $("hud-battery"),
            batteryFill   : $("hud-battery-fill"),
            batteryText   : $("hud-battery-text"),
            throttleFill  : $("hud-throttle-fill"),
            horizon       : $("hud-horizon"),
            attitudeText  : $("hud-attitude-text"),
            msgCrash      : $("msg-crash"),
            msgNoPower    : $("msg-nopower"),
            msgOutOfBounds: $("msg-oob"),
            msgCollision  : $("msg-collision"),
        };

        this.cache = new Map();
        this.lastUpdate = -Infinity;
    }

    show(mapName) {
        this.el.mapName.textContent = mapName;
        this.root.hidden = false;
    }

    /** 下次 update 立即刷新（重置后使用） */
    invalidate() {
        this.lastUpdate = -Infinity;
    }

    /**
     * @param {{altitude:number, horizontalSpeed:number, verticalSpeed:number, heading:number,
     *          batteryRatio:number, throttle:number, pitch:number, roll:number,
     *          crashed:boolean, powerLost:boolean, outOfBounds:boolean,
     *          collisionActive:boolean, impactSpeed:number}} d  角度为弧度
     * @param {number} now 毫秒时间戳
     */
    update(d, now) {
        if (now - this.lastUpdate < UPDATE_INTERVAL_MS)
            return;

        this.lastUpdate = now;
        const e = this.el;

        this._text(e.altitude, Math.max(0, d.altitude).toFixed(1));
        this._text(e.hSpeed, d.horizontalSpeed.toFixed(1));
        this._text(
            e.vSpeed,
            (d.verticalSpeed >= 0 ? "+" : "") + d.verticalSpeed.toFixed(1),
        );
        this._text(
            e.heading,
            String(Math.round(toDegrees(normalizeAngle(d.heading)))).padStart(
                3,
                "0",
            ),
        );

        const pct = Math.max(0, Math.min(1, d.batteryRatio)) * 100;
        this._text(e.batteryText, `${pct.toFixed(0)}%`);
        this._style(e.batteryFill, "width", `${pct.toFixed(1)}%`);
        this._toggle(e.battery, "low", d.batteryRatio < LOW_BATTERY_RATIO);
        this._style(
            e.throttleFill,
            "height",
            `${(d.throttle * 100).toFixed(0)}%`,
        );

        // 姿态仪：右滚 → 地平线逆时针转；机头下压 → 地平线上移
        const pitchPx = (-d.pitch * ATTITUDE_PITCH_SCALE).toFixed(1);
        this._style(
            e.horizon,
            "transform",
            `rotate(${(-d.roll).toFixed(3)}rad) translateY(${pitchPx}px)`,
        );
        this._text(
            e.attitudeText,
            `俯仰 ${toDegrees(d.pitch).toFixed(0)}°  横滚 ${toDegrees(d.roll).toFixed(0)}°`,
        );

        this._visible(e.msgCrash, d.crashed);
        this._visible(e.msgNoPower, d.powerLost && !d.crashed);
        this._visible(e.msgOutOfBounds, d.outOfBounds);
        this._visible(e.msgCollision, d.collisionActive && !d.crashed);

        if (d.collisionActive)
            this._text(
                e.msgCollision,
                `碰撞！冲击 ${d.impactSpeed.toFixed(1)} m/s`,
            );
    }

    _text(el, value) {
        if (this.cache.get(el) === value)
            return;

        this.cache.set(el, value);
        el.textContent = value;
    }

    _style(el, prop, value) {
        const key = `${el.id}.${prop}`;
        if (this.cache.get(key) === value)
            return;

        this.cache.set(key, value);
        el.style[prop] = value;
    }

    _toggle(el, cls, on) {
        const key = `${el.id}.class.${cls}`;
        if (this.cache.get(key) === on)
            return;

        this.cache.set(key, on);
        el.classList.toggle(cls, on);
    }

    _visible(el, on) {
        const key = `${el.id}.visible`;
        if (this.cache.get(key) === on)
            return;

        this.cache.set(key, on);
        el.hidden = !on;
    }
}

function toDegrees(rad) {
    return (rad * 180) / Math.PI;
}

function normalizeAngle(rad) {
    const t = Math.PI * 2;
    return ((rad % t) + t) % t;
}

/* ------------------------------------------------------------------ */
/* Loading / 错误覆盖层                                                 */
/* ------------------------------------------------------------------ */

export function showLoading(mapName) {
    const overlay = $("overlay");
    overlay.className = "overlay loading";
    $("overlay-title").textContent = "加载中…";
    $("overlay-detail").replaceChildren(
        document.createTextNode(`正在加载地图：${mapName}`),
    );

    overlay.hidden = false;
}

/**
 * @param {string} title  如“地图加载失败：xxx”
 * @param {string[]} details 逐条说明
 * @param {string} [hint]
 */
export function showError(title, details = [], hint = "") {
    const overlay = $("overlay");
    overlay.className = "overlay error";
    $("overlay-title").textContent = title;
    const list = document.createElement("ul");
    for (const line of details) {
        const li = document.createElement("li");
        li.textContent = line;
        list.appendChild(li);
    }

    const nodes = [list];
    if (hint) {
        const p = document.createElement("p");
        p.className = "overlay-hint";
        p.textContent = hint;
        nodes.push(p);
    }

    $("overlay-detail").replaceChildren(...nodes);
    overlay.hidden = false;
}

export function hideOverlay() {
    $("overlay").hidden = true;
}
