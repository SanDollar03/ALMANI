// std-work.js
// 統合テーブル + チャート列に「1枚のSVG」を重ねる方式（最新版）
//
// UI要件
// - 上部は工程名/作業名のみ（std-work.html側に #topProcess/#topElement を用意）
// - 「機械」→「自動」
// - 自動は直前の手作業と同じ行に「赤文字で改行表示」
// - 自動の線は手作業四角の前面に重なる破線（同じ行y）
// 描画要件
// - 0はチャート枠の左端（x=0固定）
// - 方眼：縦線のみ（1秒点線、10秒実線）
// - 横線は全て点線（行境界）
// - 歩行がある場合：手作業四角の右下 → 次の手作業四角の左上 を波線で連結
// - 歩行が無い場合：同じ角同士を実線で連結
//
// データ要件
// - 最初の手作業から開始
// - 歩行は直近手作業へ合算（連続歩行も合算）
// - 0秒手作業は省略

(function () {
    "use strict";

    // =========================
    // Config
    // =========================
    const PX_PER_SEC = 8;
    const MAX_AXIS_SEC = 180;
    const SCALE_STEP = 10;

    // 手作業四角
    const MANUAL_H = 12;
    const MANUAL_FILL = "#E6E6FA";
    const MANUAL_STROKE = "#000";
    const MANUAL_STROKE_W = 1;

    // 自動（破線・前面）
    const AUTO_W = 1.4;
    const AUTO_DASH = "6 6";

    // 連結（歩行なし）
    const LINK_W = 1.2;

    // 歩行波線
    const WALK_W = 1.2;
    const WALK_AMP = 2.2;
    const WALK_WAVE_LEN = 5;

    // grid
    const GRID_1S_COLOR = "#d0d0d0";   // 1秒点線
    const GRID_10S_COLOR = "#666";     // 10秒実線
    const GRID_H_COLOR = "#d9d9d9";    // 横点線

    // takt
    const DEFAULT_TAKT_SEC = 0; // 0なら総時間

    // =========================
    // Load payload
    // =========================
    const payloadText = localStorage.getItem("almani_stdwork_payload");
    const payload = payloadText ? safeJson(payloadText) : null;

    if (!payload || !Array.isArray(payload.laps)) {
        alert("ALMANIデータが見つかりません。");
        location.href = "/";
        return;
    }

    // CSS変数をJSに一致（ズレ防止）
    document.documentElement.style.setProperty("--sec-max", String(MAX_AXIS_SEC));
    document.documentElement.style.setProperty("--px-per-sec", String(PX_PER_SEC));

    // top display（工程名/作業名）
    setText("topProcess", payload.processName || "");
    setText("topElement", payload.elementWorkName || "");

    // build rows
    const rows = buildRows(payload.laps);

    // scale
    renderScale();

    // takt
    const taktFromLS = toNum(localStorage.getItem("almani_stdwork_takt_sec"));
    const taktFromPayload = toNum(payload.taktSec);
    const taktPref = firstNonZero(taktFromLS, taktFromPayload, DEFAULT_TAKT_SEC);

    // render table rows
    renderRows(rows);

    requestAnimationFrame(() => {
        const stage = ensureStage();
        layoutStage(stage);
        drawAll(stage, rows, taktPref);

        window.addEventListener("resize", () => {
            layoutStage(stage);
            drawAll(stage, rows, taktPref);
        });
    });

    // =========================
    // Scale (0..180 exact x)
    // =========================
    function renderScale() {
        const scaleRow = document.getElementById("scaleRow");
        if (!scaleRow) return;

        scaleRow.innerHTML = "";
        scaleRow.style.width = `${MAX_AXIS_SEC * PX_PER_SEC}px`;

        for (let t = 0; t <= MAX_AXIS_SEC; t += SCALE_STEP) {
            const d = document.createElement("div");
            d.className = "tick" + (t === 0 ? " zero" : "");
            d.textContent = String(t);
            d.style.left = `${t * PX_PER_SEC}px`;
            scaleRow.appendChild(d);
        }
    }

    // =========================
    // Render tbody rows
    // =========================
    function renderRows(rows) {
        const tbody = document.getElementById("oneTbody");
        if (!tbody) return;

        let sumManual = 0, sumAuto = 0, sumWalk = 0;

        tbody.innerHTML = "";

        for (const r of rows) {
            sumManual += r.manualSec;
            sumWalk += r.walkSec;
            sumAuto += r.autoSec;

            const autoNamesHtml = r.autoNames.length
                ? `<br>${r.autoNames.map(n => `<span class="auto-name">${escapeHtml(n)}</span>`).join("<br>")}`
                : "";

            const tr = document.createElement("tr");
            tr.innerHTML = `
        <td class="c-no">${r.no}</td>
        <td class="c-work c-work-td">${escapeHtml(r.workName)}${autoNamesHtml}</td>
        <td class="c-man">${r.manualSec ? r.manualSec : ""}</td>
        <td class="c-auto">${r.autoSec ? r.autoSec : ""}</td>
        <td class="c-walk">${r.walkSec ? r.walkSec : ""}</td>
        <td class="c-chart"></td>
      `;
            tbody.appendChild(tr);
        }

        setText("sumManual", sumManual ? String(sumManual) : "");
        setText("sumAuto", sumAuto ? String(sumAuto) : "");
        setText("sumWalk", sumWalk ? String(sumWalk) : "");
    }

    // =========================
    // Stage create/layout
    // =========================
    function ensureStage() {
        const wrap = document.querySelector(".sw-one");
        if (!wrap) throw new Error("sw-one not found");

        let stage = wrap.querySelector(".chart-stage");
        if (stage) return stage;

        stage = document.createElement("div");
        stage.className = "chart-stage";

        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");

        stage.appendChild(svg);
        wrap.appendChild(stage);

        return stage;
    }

    function layoutStage(stage) {
        const wrap = document.querySelector(".sw-one");
        const tbody = document.getElementById("oneTbody");
        if (!wrap || !tbody) return;

        const firstChartCell = tbody.querySelector("tr td.c-chart");
        if (!firstChartCell) return;

        const wrapRect = wrap.getBoundingClientRect();
        const cellRect = firstChartCell.getBoundingClientRect();
        const tbodyRect = tbody.getBoundingClientRect();

        // チャート枠の左上（tbodyのチャート列左端）をステージ原点（x=0）
        const left = cellRect.left - wrapRect.left;
        const top = tbodyRect.top - wrapRect.top;
        const width = cellRect.width;
        const height = tbodyRect.height;

        stage.style.left = `${left}px`;
        stage.style.top = `${top}px`;
        stage.style.width = `${width}px`;
        stage.style.height = `${height}px`;

        const svg = stage.querySelector("svg");
        if (!svg) return;

        svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
        svg.setAttribute("width", String(width));
        svg.setAttribute("height", String(height));
    }

    // =========================
    // Draw (grid + shapes + connectors + takt)
    // =========================
    function drawAll(stage, rows, taktPref) {
        const svg = stage.querySelector("svg");
        const tbody = document.getElementById("oneTbody");
        if (!svg || !tbody) return;

        while (svg.firstChild) svg.removeChild(svg.firstChild);

        const chartW = stage.getBoundingClientRect().width;
        const chartH = stage.getBoundingClientRect().height;

        const trs = Array.from(tbody.querySelectorAll("tr"));
        const N = Math.min(rows.length, trs.length);
        if (N <= 0) return;

        // row center y from DOM (完全同期)
        const tbodyRect = tbody.getBoundingClientRect();
        const yMid = [];
        for (let i = 0; i < N; i++) {
            const r = trs[i].getBoundingClientRect();
            yMid.push(((r.top + r.bottom) / 2) - tbodyRect.top);
        }

        // total operator timeline for takt default（手作業+歩行+自動も含めて並ぶ想定）
        const totalSec = rows.slice(0, N).reduce((a, r) => a + r.manualSec + r.walkSec + r.autoSec, 0);
        const taktSec = clampNum((taktPref > 0 ? taktPref : totalSec), 0, MAX_AXIS_SEC);

        // 1) grid
        drawGrid(svg, chartW, chartH);

        // 2) shapes
        // operator time t: 手作業→自動→歩行 の順で進める（表示の並びが自然）
        let t = 0;

        // manual rect positions for connector endpoints
        const manualInfo = []; // {rowIdx, x0, x1, yTop, yBot, hasWalk}

        // draw manual first (back)
        for (let i = 0; i < N; i++) {
            const r = rows[i];
            const ym = yMid[i];

            const manualStart = t;
            const manualEnd = t + r.manualSec;

            const x0 = manualStart * PX_PER_SEC;
            const x1 = manualEnd * PX_PER_SEC;

            // manual rect
            addRect(svg, x0, ym - MANUAL_H / 2, x1 - x0, MANUAL_H, {
                fill: MANUAL_FILL,
                stroke: MANUAL_STROKE,
                strokeW: MANUAL_STROKE_W
            });

            manualInfo.push({
                rowIdx: i,
                x0, x1,
                yTop: ym - MANUAL_H / 2,
                yBot: ym + MANUAL_H / 2,
                walkSec: r.walkSec
            });

            // advance time: manual
            t += r.manualSec;

            // advance time: auto (timeline consumes)
            t += r.autoSec;

            // advance time: walk (timeline consumes)
            t += r.walkSec;
        }

        // connectors (① and ④) between consecutive manual rows (since all rows are manual-rows by definition)
        for (let i = 0; i < N - 1; i++) {
            const a = manualInfo[i];
            const b = manualInfo[i + 1];

            const ax = a.x1;
            const ay = a.yBot;      // right-bottom
            const bx = b.x0;        // next left-top at its start time
            const by = b.yTop;

            if (a.walkSec > 0) {
                addWavyDiagonal(svg, ax, ay, bx, by, {
                    waveLen: WALK_WAVE_LEN,
                    amp: WALK_AMP,
                    w: WALK_W
                });
            } else {
                addLine(svg, ax, ay, bx, by, { w: LINK_W, color: "#000" });
            }
        }

        // auto overlay (front): draw dashed lines on top of manual rects
        // auto lines are drawn within the same row, starting immediately after manual in the timeline
        t = 0;
        for (let i = 0; i < N; i++) {
            const r = rows[i];
            const ym = yMid[i];

            const manualStart = t;
            const manualEnd = t + r.manualSec;

            // auto begins right after manual (overlay “in front” visually)
            const autoStart = manualEnd;
            const autoEnd = autoStart + r.autoSec;

            const x0 = autoStart * PX_PER_SEC;
            const x1 = autoEnd * PX_PER_SEC;

            if (r.autoSec > 0) {
                addLine(svg, x0, ym, x1, ym, { w: AUTO_W, dash: AUTO_DASH, color: "#000" });
            }

            // advance timeline
            t += r.manualSec + r.autoSec + r.walkSec;
        }

        // 3) takt
        const tx = taktSec * PX_PER_SEC;
        addLine(svg, tx, 0, tx, chartH, { w: 1.2, color: "red" });
    }

    // =========================
    // Grid: vertical 1s dotted, 10s solid / horizontal dotted
    // =========================
    function drawGrid(svg, w, h) {
        // vertical
        for (let s = 0; s <= MAX_AXIS_SEC; s++) {
            const x = s * PX_PER_SEC;
            if (x < 0 || x > w) continue;

            if (s % 10 === 0) {
                addLine(svg, x, 0, x, h, { w: 1.1, color: GRID_10S_COLOR });
            } else {
                addLine(svg, x, 0, x, h, { w: 0.8, color: GRID_1S_COLOR, dash: "1 4" });
            }
        }

        // horizontal dotted
        const rowH = readCssPx("--row-h", 36);
        const n = Math.floor(h / rowH);
        for (let i = 0; i <= n; i++) {
            const y = i * rowH;
            addLine(svg, 0, y, w, y, { w: 0.8, color: GRID_H_COLOR, dash: "2 4" });
        }
    }

    // =========================
    // Build rows
    // - 自動は直前手作業に統合（作業名は赤で追記）
    // - 歩行は直近手作業に合算
    // - 0秒手作業は省略
    // =========================
    function buildRows(laps) {
        const norm = laps.map(x => ({
            cat: normalizeCat(x?.cat),
            work: String(x?.work ?? "").trim(),
            dt: clampInt(x?.dt, 0, 24 * 3600)
        }));

        const startIdx = norm.findIndex(r => r.cat === "手作業" && r.dt > 0);
        if (startIdx < 0) return [];

        const out = [];
        let lastIdx = -1;

        for (let i = startIdx; i < norm.length; i++) {
            const r = norm[i];

            if (r.cat === "手作業") {
                if (r.dt <= 0) continue;
                out.push({
                    no: out.length + 1,
                    workName: r.work,
                    manualSec: r.dt,
                    autoSec: 0,
                    autoNames: [],
                    walkSec: 0
                });
                lastIdx = out.length - 1;
                continue;
            }

            if (r.cat === "歩行") {
                if (lastIdx >= 0) out[lastIdx].walkSec += r.dt;
                continue;
            }

            // 自動：直前手作業に統合
            if (r.cat === "自動") {
                if (lastIdx >= 0 && r.dt > 0) {
                    out[lastIdx].autoSec += r.dt;
                    if (r.work) out[lastIdx].autoNames.push(r.work);
                }
                continue;
            }
        }

        out.forEach((x, idx) => (x.no = idx + 1));
        return out;
    }

    // =========================
    // SVG helpers
    // =========================
    function addLine(svg, x1, y1, x2, y2, opt = {}) {
        const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
        line.setAttribute("x1", x1); line.setAttribute("y1", y1);
        line.setAttribute("x2", x2); line.setAttribute("y2", y2);
        line.setAttribute("stroke", opt.color || "#000");
        line.setAttribute("stroke-width", String(opt.w ?? 1));
        line.setAttribute("stroke-linecap", "butt");
        if (opt.dash) line.setAttribute("stroke-dasharray", opt.dash);
        svg.appendChild(line);
    }

    function addRect(svg, x, y, w, h, opt = {}) {
        const r = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        r.setAttribute("x", x);
        r.setAttribute("y", y);
        r.setAttribute("width", Math.max(0, w));
        r.setAttribute("height", Math.max(0, h));
        r.setAttribute("fill", opt.fill || "transparent");
        r.setAttribute("stroke", opt.stroke || "#000");
        r.setAttribute("stroke-width", String(opt.strokeW ?? 1));
        r.setAttribute("shape-rendering", "crispEdges");
        svg.appendChild(r);
    }

    function addWavyDiagonal(svg, x0, y0, x1, y1, opt = {}) {
        const waveLen = opt.waveLen ?? 5;
        const amp = opt.amp ?? 2.2;
        const strokeW = opt.w ?? 1.2;

        const dx = x1 - x0;
        const dy = y1 - y0;
        const len = Math.max(1, Math.hypot(dx, dy));
        const n = Math.max(18, Math.floor(len / waveLen));

        const nx = -dy / len;
        const ny = dx / len;

        let d = `M ${x0} ${y0}`;
        for (let i = 1; i <= n; i++) {
            const tt = i / n;
            const bx = x0 + dx * tt;
            const by = y0 + dy * tt;

            const phase = (i % 2 === 0) ? -1 : 1;
            const mt = (i - 0.5) / n;
            const mx = x0 + dx * mt + nx * amp * phase;
            const my = y0 + dy * mt + ny * amp * phase;

            d += ` Q ${mx} ${my} ${bx} ${by}`;
        }

        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", d);
        path.setAttribute("fill", "none");
        path.setAttribute("stroke", "#000");
        path.setAttribute("stroke-width", String(strokeW));
        path.setAttribute("stroke-linecap", "round");
        path.setAttribute("stroke-linejoin", "round");
        svg.appendChild(path);
    }

    // =========================
    // Utils
    // =========================
    function safeJson(t) { try { return JSON.parse(t); } catch { return null; } }

    function setText(id, v) {
        const el = document.getElementById(id);
        if (el) el.textContent = String(v ?? "");
    }

    function normalizeCat(cat) {
        const s = String(cat ?? "").trim();
        if (s === "歩行") return "歩行";
        if (s === "自動") return "自動";
        return "手作業";
    }

    function clampInt(v, min, max) {
        const n = Math.floor(Number(v) || 0);
        return Math.max(min, Math.min(max, n));
    }

    function clampNum(v, min, max) {
        const n = Number(v) || 0;
        return Math.max(min, Math.min(max, n));
    }

    function toNum(v) {
        const n = Number(v);
        return Number.isFinite(n) ? n : 0;
    }

    function firstNonZero(...vals) {
        for (const v of vals) if (Number(v) > 0) return Number(v);
        return 0;
    }

    function escapeHtml(s) {
        return String(s ?? "")
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll('"', "&quot;")
            .replaceAll("'", "&#39;");
    }

    function readCssPx(varName, fallback) {
        try {
            const v = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
            const n = Number(String(v).replace("px", "").trim());
            return Number.isFinite(n) && n > 0 ? n : fallback;
        } catch {
            return fallback;
        }
    }
})();
