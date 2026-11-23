/**
 * mapMenu.js —— 地图选择面板（DOM）
 *
 * 数据来自 mapList.js（maps/index.json），本模块只负责渲染与交互：
 *   open() / close() / toggle()
 *   setCurrent(id)   标记当前地图
 *   setBusy(id)      加载中：禁用卡片并显示对应卡片的 loading
 *   showError(text)  面板内显示错误（不打断面板）
 *
 * 快捷键：M 开关面板；Esc 关闭（首次进入必须选择地图，此时不可关闭）。
 */

const BADGE_CURRENT = "当前";

export class MapMenu {
    /**
     * @param {object} options
     * @param {{id:string,name:string,cover:string|null}[]} options.items
     * @param {(id:string)=>void} options.onSelect
     * @param {()=>boolean} [options.canClose] 是否允许关闭（未选择地图时返回 false）
     */
    constructor({ items, onSelect, canClose = () => true }) {
        this.items = items;
        this.onSelect = onSelect;
        this.canClose = canClose;

        this.currentId = null;
        this.busyId = null;
        this._lastFocus = null;

        this.root = this._build();
        document.body.appendChild(this.root);

        this._onKeyDown = (e) => {
            if (e.ctrlKey || e.metaKey || e.altKey || isEditableTarget(e.target))
                return;

            if (e.code === "KeyM" && !e.repeat) {
                e.preventDefault();
                this.toggle();
            }
            else if (e.key === "Escape" && this.isOpen) {
                if (this.busyId)
                    return;
                e.preventDefault();
                this._requestClose();
            }
        };
        window.addEventListener("keydown", this._onKeyDown);
    }

    get isOpen() {
        return !this.root.hidden;
    }

    open() {
        if (this.isOpen)
            return;

        this._lastFocus =
            document.activeElement instanceof HTMLElement
                ? document.activeElement
                : null;

        this._updateHeader();
        this.root.hidden = false;
        document.body.classList.add("map-menu-open");

        // 让面板直接可键盘操作：优先聚焦关闭按钮，否则聚焦第一张地图
        requestAnimationFrame(() => {
            const target = this._closeBtn.hidden
                ? this._cards[0]
                : this._closeBtn;
            target?.focus({ preventScroll: true });
        });
    }

    close() {
        if (!this.isOpen)
            return;

        this.setBusy(null);
        this.root.hidden = true;
        document.body.classList.remove("map-menu-open");

        if (this._lastFocus && document.contains(this._lastFocus))
            this._lastFocus.focus({ preventScroll: true });
    }

    toggle() {
        if (this.busyId)
            return;

        if (this.isOpen)
            this._requestClose();
        else
            this.open();
    }

    /** 标记当前地图（显示“当前”角标） */
    setCurrent(id) {
        this.currentId = id;

        for (const card of this._cards) {
            const isCurrent = card.dataset.id === id;
            card.classList.toggle("is-current", isCurrent);

            if (isCurrent)
                card.setAttribute("aria-current", "true");
            else
                card.removeAttribute("aria-current");
        }

        if (this.isOpen)
            this._updateHeader();
    }

    /** @param {string|null} id 加载中的地图 id；null 结束加载态 */
    setBusy(id) {
        this.busyId = id;
        this.root.classList.toggle("is-busy", Boolean(id));
        this._errorEl.hidden = true;

        for (const card of this._cards) {
            card.disabled = Boolean(id);
            card.classList.toggle(
                "is-loading",
                Boolean(id) && card.dataset.id === id,
            );
        }

        this._closeBtn.disabled = Boolean(id);
    }

    /** 面板内错误提示（例如地图文件加载失败），不关闭面板 */
    showError(message) {
        this._errorEl.textContent = message;
        this._errorEl.hidden = false;
    }

    destroy() {
        window.removeEventListener("keydown", this._onKeyDown);
        this.root.remove();
        document.body.classList.remove("map-menu-open");
    }

    /* ---------------- 内部实现 ---------------- */

    _build() {
        const root = document.createElement("div");
        root.id = "map-menu";
        root.className = "map-menu";
        root.hidden = true;
        root.innerHTML = `
            <div class="map-menu-panel" role="dialog" aria-modal="true"
                aria-labelledby="map-menu-title">
                <header class="map-menu-header">
                    <div>
                        <h2 class="map-menu-title" id="map-menu-title">选择飞行地图</h2>
                        <p class="map-menu-sub"></p>
                    </div>
                    <button type="button" class="map-menu-close"
                        aria-label="关闭地图面板">×</button>
                </header>
                <p class="map-menu-error" hidden></p>
                <div class="map-menu-grid"></div>
            </div>
        `;

        this._panel = root.querySelector(".map-menu-panel");
        this._closeBtn = root.querySelector(".map-menu-close");
        this._subEl = root.querySelector(".map-menu-sub");
        this._errorEl = root.querySelector(".map-menu-error");
        this._grid = root.querySelector(".map-menu-grid");

        for (const item of this.items)
            this._grid.appendChild(this._createCard(item));

        this._cards = Array.from(this._grid.querySelectorAll(".map-card"));

        this._closeBtn.addEventListener("click", () => this._requestClose());

        // 点击遮罩空白处关闭；点击面板内部不关闭
        root.addEventListener("click", (e) => {
            if (e.target === root)
                this._requestClose();
        });

        // 事件委托：卡片选择
        this._grid.addEventListener("click", (e) => {
            const card = e.target.closest(".map-card");
            if (!card || this.busyId)
                return;

            const id = card.dataset.id;
            if (id)
                this.onSelect?.(id);
        });

        return root;
    }

    _createCard(item) {
        const card = document.createElement("button");
        card.type = "button";
        card.className = "map-card";
        card.dataset.id = item.id;
        card.setAttribute("aria-label", `加载地图：${item.name}`);

        const cover = document.createElement("span");
        cover.className = "map-card-cover";
        cover.style.setProperty("--hue", String(hueFor(item.id)));

        if (item.cover) {
            const img = document.createElement("img");
            img.src = item.cover;
            img.alt = "";
            img.loading = "lazy";
            img.decoding = "async";
            cover.appendChild(img);
        }
        else {
            const glyph = document.createElement("span");
            glyph.className = "map-card-glyph";
            glyph.textContent = item.name.trim().charAt(0) || "?";
            cover.appendChild(glyph);
        }

        const badge = document.createElement("span");
        badge.className = "map-card-badge";
        badge.textContent = BADGE_CURRENT;
        cover.appendChild(badge);

        const loading = document.createElement("span");
        loading.className = "map-card-loading";
        loading.textContent = "加载中…";

        const info = document.createElement("span");
        info.className = "map-card-info";

        const name = document.createElement("span");
        name.className = "map-card-name";
        name.textContent = item.name;

        const id = document.createElement("span");
        id.className = "map-card-id";
        id.textContent = item.id;

        info.append(name, id);
        card.append(cover, loading, info);

        return card;
    }

    _updateHeader() {
        const closable = this.canClose();
        this._closeBtn.hidden = !closable;
        this._subEl.textContent = closable
            ? "点击卡片切换地图 · 按 M 或 Esc 关闭"
            : "点击卡片开始飞行";
    }

    _requestClose() {
        if (this.busyId || !this.canClose())
            return;

        this.close();
    }
}

function hueFor(id) {
    let hue = 0;
    for (let i = 0; i < id.length; i++)
        hue = (hue * 31 + id.charCodeAt(i)) % 360;

    return hue;
}

function isEditableTarget(target) {
    if (!(target instanceof HTMLElement))
        return false;

    const tag = target.tagName;
    return (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        target.isContentEditable
    );
}
