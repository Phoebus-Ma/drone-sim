/**
 * controls.js —— 输入控制
 *
 * 对外只输出统一的输入状态对象（物理模块只认这个对象）：
 *   { throttle: 0~1, pitch: -1~1, roll: -1~1, yaw: -1~1 }
 *   throttle 0.5 = 悬停；pitch +1 = 前进；roll +1 = 右移；yaw +1 = 右转
 *
 * 结构：
 *   输入源（InputSource） → Controls（合并 + 平滑 + 映射） → 输入状态对象
 *
 * 输入源接口（任何新输入方式只需实现它，然后 controls.addSource(source)）：
 *   getAxes(): { throttle, pitch, roll, yaw }   各轴为 -1~1 的“摇杆偏移量”
 *   onAction(callback): 订阅离散动作，callback('reset') 等
 *   dispose(): 移除监听
 *
 * V1 只实现 KeyboardInputSource；未来的 TouchJoystickSource 等实现相同接口即可，
 * 无需修改 Controls 与物理模块。
 */

export const AXES = ["throttle", "pitch", "roll", "yaw"];

/** 键盘轴绑定：KeyboardEvent.code → [轴, 方向] */
const KEY_AXIS_BINDINGS = {
    KeyW       : ["throttle", +1],
    KeyS       : ["throttle", -1],
    ArrowUp    : ["pitch",    +1],
    ArrowDown  : ["pitch",    -1],
    ArrowLeft  : ["roll",     -1],
    ArrowRight : ["roll",     +1],
    KeyA       : ["yaw",      -1],
    KeyD       : ["yaw",      +1],
};

/** 键盘动作绑定 */
const KEY_ACTION_BINDINGS = {
    KeyR: "reset",
};

/** 键盘“摇杆”平滑：推杆/回中速率（每秒变化量），让数字按键也有渐进感 */
const SMOOTHING = {
    rise: 3.0,
    release: 6.0,
};

export class KeyboardInputSource {
    constructor(target = window) {
        this.target  = target;
        this.pressed = new Set();
        this.actionListeners = [];

        this._onKeyDown = (e) => {
            if (e.ctrlKey || e.metaKey || e.altKey)
                return;

            if (KEY_AXIS_BINDINGS[e.code]) {
                e.preventDefault(); // 防止方向键滚动页面
                this.pressed.add(e.code);
            }
            else if (KEY_ACTION_BINDINGS[e.code]) {
                e.preventDefault();
                if (!e.repeat)
                    this._emit(KEY_ACTION_BINDINGS[e.code]);
            }
        };
        this._onKeyUp = (e) => {
            this.pressed.delete(e.code);
        };
        this._onBlur = () => this.pressed.clear(); // 窗口失焦时防止“粘键”

        target.addEventListener("keydown", this._onKeyDown);
        target.addEventListener("keyup",   this._onKeyUp);
        target.addEventListener("blur",    this._onBlur);
    }

    getAxes() {
        const axes = { throttle: 0, pitch: 0, roll: 0, yaw: 0 };

        for (const code of this.pressed) {
            const binding = KEY_AXIS_BINDINGS[code];
            if (binding)
                axes[binding[0]] += binding[1];
        }

        for (const k of AXES)
            axes[k] = Math.max(-1, Math.min(1, axes[k]));

        return axes;
    }

    onAction(callback) {
        this.actionListeners.push(callback);
    }

    _emit(action) {
        for (const cb of this.actionListeners) cb(action);
    }

    dispose() {
        this.target.removeEventListener("keydown", this._onKeyDown);
        this.target.removeEventListener("keyup", this._onKeyUp);
        this.target.removeEventListener("blur", this._onBlur);
        this.pressed.clear();
    }
}

// 未来扩展示例（V1 不实现）：
// export class TouchJoystickSource {
//   getAxes() { return { throttle, pitch, roll, yaw }; } // 从虚拟摇杆读取 -1~1
//   onAction(cb) { ... }                                  // 例如“重置”按钮
// }

function moveTowards(current, target, maxDelta) {
    if (Math.abs(target - current) <= maxDelta)
        return target;

    return current + Math.sign(target - current) * maxDelta;
}

export class Controls {
    constructor() {
        this.sources = [];
        this.sticks = { throttle: 0, pitch: 0, roll: 0, yaw: 0 }; // 平滑后的摇杆偏移
        this.actionHandlers = new Map();
    }

    addSource(source) {
        this.sources.push(source);
        if (typeof source.onAction === "function") {
            source.onAction((action) => this._dispatch(action));
        }

        return source;
    }

    /** 订阅动作，如 controls.on('reset', fn) */
    on(action, handler) {
        if (!this.actionHandlers.has(action))
            this.actionHandlers.set(action, []);

        this.actionHandlers.get(action).push(handler);
    }

    _dispatch(action) {
        const handlers = this.actionHandlers.get(action);
        if (handlers)
            for (const h of handlers)
                h();
    }

    /**
     * 每帧调用：合并所有输入源（取绝对值最大者）→ 平滑 → 映射为输入状态对象
     * @param {number} dt 帧间隔（秒）
     * @returns {{throttle:number,pitch:number,roll:number,yaw:number}} 新对象
     */
    update(dt) {
        const target = { throttle: 0, pitch: 0, roll: 0, yaw: 0 };
        for (const src of this.sources) {
            const a = src.getAxes();
            for (const k of AXES) {
                if (Math.abs(a[k] || 0) > Math.abs(target[k]))
                    target[k] = a[k];
            }
        }

        for (const k of AXES) {
            const cur = this.sticks[k];
            const pushing =
                Math.abs(target[k]) > Math.abs(cur) &&
                Math.sign(target[k]) === Math.sign(cur || target[k]);
            const rate = pushing ? SMOOTHING.rise : SMOOTHING.release;
            this.sticks[k] = moveTowards(cur, target[k], rate * dt);
        }

        return {
            throttle: 0.5 + 0.5 * this.sticks.throttle, // 摇杆居中 = 悬停
            pitch: this.sticks.pitch,
            roll: this.sticks.roll,
            yaw: this.sticks.yaw,
        };
    }

    /** 摇杆回中（R 重置时调用） */
    reset() {
        for (const k of AXES) this.sticks[k] = 0;
    }
}
