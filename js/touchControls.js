/**
 * touchControls.js —— 移动端双摇杆触摸输入（V2 新增）
 *
 * 与 KeyboardInputSource 实现同一输入源接口，通过 controls.addSource() 接入：
 *   getAxes() -> { throttle, pitch, roll, yaw }   各轴为 -1~1 的“摇杆偏移量”
 *   onAction(cb)                                  订阅离散动作（'reset'）
 *   dispose()
 *
 * 布局：
 *   左摇杆：纵向 = 油门（上推增大 / 下拉减小），横向 = 偏航（右推右转）
 *   右摇杆：纵向 = 俯仰（上推前进 / 下拉后退），横向 = 横滚（右推右移）
 *
 * 与键盘同时生效时：Controls.update() 已按“各轴绝对值最大者”合并，
 * 即推得更深的输入源占优，无需修改 controls.js。
 *
 * 显示策略：
 *   - 具备触摸能力（'ontouchstart' in window 或 maxTouchPoints > 0）且主指针为触摸
 *     （pointer: coarse / hover: none）才显示；触屏笔记本仍以鼠标为主，不显示；
 *   - 页面加载后才在 DevTools 里切换设备模拟时，第一次触摸也会自动显示。
 */

const DEADZONE = 0.06; // 摇杆死区（占满舵量的比例），避免手指微颤导致漂移
const KNOB_TRAVEL_RATIO = 0.3; // 摇杆头最大位移 / 底盘直径（40% 的摇杆头刚好不越界）

const ZERO_AXES = { throttle: 0, pitch: 0, roll: 0, yaw: 0 };

/** 是否以触摸为主要输入方式（不使用 UA 判断） */
export function isTouchDevice() {
    const hasTouch =
        "ontouchstart" in window ||
        (navigator.maxTouchPoints || 0) > 0;

    if (!hasTouch)
        return false;

    // 触屏笔记本虽然有触摸硬件，但主指针仍是鼠标（pointer: fine / hover: hover），
    // 此时不显示摇杆；手机/平板的 pointer 为 coarse 或 hover 为 none。
    const coarse = window.matchMedia("(pointer: coarse)").matches;
    const noHover = window.matchMedia("(hover: none)").matches;

    return coarse || noHover;
}

export class TouchInputSource {
    /**
     * @param {{mount?: HTMLElement}} [options] 摇杆 UI 挂载点，默认 body
     */
    constructor({ mount = document.body } = {}) {
        this.mount = mount;
        this.actionListeners = [];
        this.sticks = new Map(); // side -> stick state

        this.root = this._buildDom();
        mount.appendChild(this.root);

        // 加载后首次触摸（含 DevTools 设备模拟）也能唤出摇杆
        this._onDocumentPointerDown = (e) => {
            if (e.pointerType === "touch")
                this.show();
        };
        this._onWindowBlur = () => this._releaseAll();
        this._onVisibility = () => {
            if (document.hidden)
                this._releaseAll();
        };

        window.addEventListener("pointerdown", this._onDocumentPointerDown, true);
        window.addEventListener("blur", this._onWindowBlur);
        document.addEventListener("visibilitychange", this._onVisibility);

        if (isTouchDevice())
            this.show();
    }

    /* ---------------- 输入源接口 ---------------- */

    getAxes() {
        if (this.root.hidden)
            return { ...ZERO_AXES };

        const left = this.sticks.get("left");
        const right = this.sticks.get("right");

        return {
            throttle: left ? left.ay : 0, // 上推为正（油门增大）
            yaw: left ? left.ax : 0, // 右推为正（右转）
            pitch: right ? right.ay : 0, // 上推为正（前进）
            roll: right ? right.ax : 0, // 右推为正（右移）
        };
    }

    onAction(callback) {
        this.actionListeners.push(callback);
    }

    _emit(action) {
        for (const cb of this.actionListeners) cb(action);
    }

    /* ---------------- 显隐 ---------------- */

    show() {
        if (!this.root.hidden)
            return;

        this.root.hidden = false;
        document.body.classList.add("touch-mode");

        // 触屏上没有 R 键，提示语改为点击屏幕按钮
        const crashMsg = document.getElementById("msg-crash");
        if (crashMsg)
            crashMsg.textContent = "坠机！点击「重置」";
    }

    dispose() {
        window.removeEventListener(
            "pointerdown",
            this._onDocumentPointerDown,
            true,
        );
        window.removeEventListener("blur", this._onWindowBlur);
        document.removeEventListener("visibilitychange", this._onVisibility);

        this._releaseAll();
        this.root.remove();
        document.body.classList.remove("touch-mode");
        this.actionListeners = [];
    }

    /* ---------------- 内部实现 ---------------- */

    _buildDom() {
        const root = document.createElement("div");
        root.id = "touch-controls";
        root.className = "touch-controls";
        root.hidden = true;
        root.innerHTML = `
            <div class="stick stick-left">
                <span class="stick-label">油门 · 偏航</span>
                <div class="stick-base"><span class="stick-cross"></span></div>
                <div class="stick-knob"></div>
            </div>
            <div class="stick stick-right">
                <span class="stick-label">俯仰 · 横滚</span>
                <div class="stick-base"><span class="stick-cross"></span></div>
                <div class="stick-knob"></div>
            </div>
            <button type="button" class="touch-reset" aria-label="重置飞行">
                <span class="touch-reset-icon" aria-hidden="true">⟲</span>重置
            </button>
        `;

        this._bindStick(root.querySelector(".stick-left"), "left");
        this._bindStick(root.querySelector(".stick-right"), "right");

        const resetBtn = root.querySelector(".touch-reset");
        resetBtn.addEventListener("click", () => {
            this._emit("reset");
            resetBtn.blur(); // 触摸后不留焦点，避免键盘事件干扰
        });

        return root;
    }

    _bindStick(el, side) {
        const state = {
            el,
            knob: el.querySelector(".stick-knob"),
            pointerId: null,
            ax: 0, // 死区处理后的轴值（-1~1）
            ay: 0,
        };
        this.sticks.set(side, state);

        el.addEventListener("pointerdown", (e) => {
            if (state.pointerId !== null)
                return; // 该摇杆已被另一根手指占用
            if (e.pointerType === "mouse" && e.button !== 0)
                return;

            e.preventDefault();
            state.pointerId = e.pointerId;
            el.classList.add("active");

            // 指针捕获：手指滑出摇杆范围仍持续跟踪
            try {
                el.setPointerCapture(e.pointerId);
            }
            catch {
                // 合成事件（自动化测试）可能不支持捕获，忽略即可
            }

            this._track(state, e);
        });

        el.addEventListener("pointermove", (e) => {
            if (e.pointerId !== state.pointerId)
                return;

            e.preventDefault();
            this._track(state, e);
        });

        const release = (e) => {
            if (e.pointerId !== state.pointerId)
                return;

            state.pointerId = null;
            el.classList.remove("active");
            this._apply(state, 0, 0); // 回中
        };
        el.addEventListener("pointerup", release);
        el.addEventListener("pointercancel", release);
        el.addEventListener("lostpointercapture", release);

        el.addEventListener("contextmenu", (e) => e.preventDefault()); // 长按不弹菜单
    }

    _track(state, e) {
        const rect = state.el.getBoundingClientRect();
        const travel = rect.width * KNOB_TRAVEL_RATIO || 1;
        const dx = (e.clientX - (rect.left + rect.width / 2)) / travel;
        const dy = (rect.top + rect.height / 2 - e.clientY) / travel; // 屏幕向上 = 正

        const len = Math.hypot(dx, dy);
        const scale = len > 1 ? 1 / len : 1; // 限制在单位圆内

        this._apply(state, dx * scale, dy * scale);
    }

    /** @param {number} nx @param {number} ny 已裁剪到单位圆内的偏移量 */
    _apply(state, nx, ny) {
        const len = Math.hypot(nx, ny);
        let ax = 0,
            ay = 0;
        if (len > DEADZONE) {
            const out = (len - DEADZONE) / (1 - DEADZONE);
            ax = (nx / len) * out;
            ay = (ny / len) * out;
        }

        state.ax = ax;
        state.ay = ay;

        const travel = (state.el.clientWidth || 0) * KNOB_TRAVEL_RATIO;
        state.knob.style.transform =
            `translate(${(nx * travel).toFixed(1)}px, ${(-ny * travel).toFixed(1)}px)`;
    }

    _releaseAll() {
        for (const state of this.sticks.values()) {
            state.pointerId = null;
            state.el.classList.remove("active");
            this._apply(state, 0, 0);
        }
    }
}
