// app.js（完全コード）
// 仕様（今回の確定）
// - CSVの1行目から「そのまま」表示する（ブランク基準行は作らない）
// - Time列：1行目は必ず 00:00、2行目以降は「(開始sec - 先頭sec)」を mm:ss 表示（相対表示）
// - 秒列：各行の所要時間＝「次行の開始sec - 自行の開始sec」（最終行は0）
// - 新規LAP：押した時刻を「開始sec」として追加し、前行の秒（所要時間）を確定
// - CSV読込：旧互換CSVの「秒列（差分）」を累積して開始secを作る
//   → 1行目 start=0, 2行目 start=dt1, 3行目 start=dt1+dt2 …（ズレない）

// ================================
// Elements
// ================================
const video = document.getElementById("v");
const msg = document.getElementById("msg");
const currentPath = document.getElementById("currentPath"); // input前提（placeholder方式）
const lapBody = document.getElementById("lapBody");
const timeOverlay = document.getElementById("timeOverlay");
const workSubtitle = document.getElementById("workSubtitle");

// Meta
const processNameInput = document.getElementById("processName");
const elementWorkNameInput = document.getElementById("elementWorkName");

// Drawer
const menuBtn = document.getElementById("menuBtn");
const drawer = document.getElementById("drawer");
const drawerBackdrop = document.getElementById("drawerBackdrop");
const drawerClose = document.getElementById("drawerClose");

// UI
const lapBtn = document.getElementById("lapBtn");
const lapTitle = document.getElementById("lapTitle");

// Volume UI
const muteBtn = document.getElementById("muteBtn");
const volumeRange = document.getElementById("volumeRange");
const volumeLabel = document.getElementById("volumeLabel");

// Header badge
let headerModeBadge = null;

// ================================
// State
// ================================
let laps = [];
let activeIndex = -1;
let isAnalyzing = false;
let isDirty = false;

const TITLE_NORMAL = "作業手順書（クリックするとジャンプ）";
const TITLE_ANALYZING = "動画分析中（クリックをするとジャンプ）（右クリックすると分析やり直し）";

let projectMeta = { processName: "", elementWorkName: "" };

// ★動画パスは state で保持（UIが勝手に変わっても守る）
let projectVideoPath = "";

// ================================
// Dirty
// ================================
function setDirty(v) { isDirty = !!v; }

// ================================
// UI helpers
// ================================
function showError(text) { msg.className = "msg err"; msg.textContent = text; }
function showOK(text) { msg.className = "msg ok"; msg.textContent = text; }
function showInfo(text) { msg.className = "msg"; msg.textContent = text; }

function setPathText(path) {
    const p = (path ?? "").trim();
    projectVideoPath = p;
    if (!currentPath) return;
    currentPath.value = p;
    currentPath.title = p || "";
}

function getPathText() {
    const s = (projectVideoPath ?? "").trim();
    if (s) return s;
    if (!currentPath) return "";
    return String(currentPath.value ?? "").trim();
}

function resetVideo() {
    try { video.pause(); } catch { }
    video.removeAttribute("src");
    video.load();
}

function buildPlayUrl(path) {
    return "/video?path=" + encodeURIComponent(path) + "&ts=" + Date.now();
}

function formatMMSS(seconds) {
    const t = Math.max(0, Number(seconds) || 0);
    const mm = String(Math.floor(t / 60)).padStart(2, "0");
    const ss = String(Math.floor(t % 60)).padStart(2, "0");
    return `${mm}:${ss}`;
}

function escapeHtml(s) {
    return String(s ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}

// ================================
// Overlay
// ================================
function updateTimeOverlay() {
    if (!timeOverlay) return;
    timeOverlay.textContent = formatMMSS(Number(video.currentTime || 0));
}

// ================================
// Subtitle
// ================================
function updateWorkSubtitle() {
    if (!workSubtitle) return;

    if (activeIndex < 0 || !laps[activeIndex]) {
        workSubtitle.textContent = "";
        workSubtitle.style.visibility = "hidden";
        return;
    }

    const lap = laps[activeIndex];
    const work = (lap.work ?? "").trim();
    const cat = (lap.cat ?? "").trim();

    if (!work) {
        workSubtitle.textContent = "";
        workSubtitle.style.visibility = "hidden";
        return;
    }

    workSubtitle.textContent = cat ? `【${cat}】${work}` : work;
    workSubtitle.style.visibility = "visible";
}

// ================================
// Header badge
// ================================
function ensureHeaderModeBadge() {
    if (headerModeBadge) return;
    const headerInner = document.querySelector(".header-inner");
    if (!headerInner) return;

    const badge = document.createElement("span");
    badge.id = "headerModeBadge";
    badge.className = "header-mode-badge";
    badge.textContent = "動画再生モード";
    headerInner.appendChild(badge);
    headerModeBadge = badge;
}

// ================================
// Readonly style (JS-only)
// ================================
function applyReadonlyStyle(el, disabled) {
    if (!el) return;

    if (el.dataset._origStyleSaved !== "1") {
        el.dataset._origBg = el.style.background || "";
        el.dataset._origColor = el.style.color || "";
        el.dataset._origCursor = el.style.cursor || "";
        el.dataset._origStyleSaved = "1";
    }

    if (disabled) {
        el.style.background = "#f5f5f5";
        el.style.color = "#000";
        el.style.cursor = "not-allowed";
        el.title = "動画分析モード中のみ編集できます";
    } else {
        el.style.background = el.dataset._origBg;
        el.style.color = el.dataset._origColor;
        el.style.cursor = el.dataset._origCursor;
        el.title = "";
    }
}

function setTableEditable(editable) {
    lapBody.querySelectorAll(".cell-input, .cell-select").forEach(el => {
        el.disabled = !editable;
        applyReadonlyStyle(el, !editable);
    });
}

function setMetaEditable(editable) {
    if (processNameInput) { processNameInput.disabled = !editable; applyReadonlyStyle(processNameInput, !editable); }
    if (elementWorkNameInput) { elementWorkNameInput.disabled = !editable; applyReadonlyStyle(elementWorkNameInput, !editable); }
}

function setPathEditable(editable) {
    if (!currentPath) return;
    currentPath.disabled = !editable;
    applyReadonlyStyle(currentPath, !editable);
    currentPath.style.opacity = "1";
    currentPath.style.webkitTextFillColor = "#000";
}

// ================================
// Menu highlight
// ================================
function updateMenuModeHighlight() {
    document.querySelectorAll(".drawer-item").forEach(btn => {
        btn.classList.remove("active-mode", "active-playback");
        if (isAnalyzing && btn.dataset.action === "analyze") btn.classList.add("active-mode");
        if (!isAnalyzing && btn.dataset.action === "playback") btn.classList.add("active-playback");
    });
}

// ================================
// Analysis mode UI
// ================================
function setAnalyzing(on) {
    isAnalyzing = on;

    if (lapBtn) {
        lapBtn.disabled = !on;
        lapBtn.classList.toggle("lap-active", on);
    }

    if (lapTitle) {
        lapTitle.textContent = on ? TITLE_ANALYZING : TITLE_NORMAL;
        lapTitle.classList.toggle("analysis", on);
    }

    setTableEditable(on);
    setMetaEditable(on);
    setPathEditable(on);

    ensureHeaderModeBadge();
    if (headerModeBadge) {
        headerModeBadge.textContent = on ? "動画分析モード" : "動画再生モード";
        headerModeBadge.classList.toggle("analysis", on);
        headerModeBadge.classList.toggle("playback", !on);
    }

    updateMenuModeHighlight();

    showInfo(on
        ? "動画分析モードに入りました（LAP・編集が有効です）"
        : "動画再生モードに切り替えました（閲覧専用です）"
    );
}

// ================================
// Drawer control
// ================================
function openDrawer() {
    drawer.classList.add("open");
    drawer.setAttribute("aria-hidden", "false");
    menuBtn.setAttribute("aria-expanded", "true");
    drawerBackdrop.hidden = false;
    drawerClose.focus();
}
function closeDrawer() {
    drawer.classList.remove("open");
    drawer.setAttribute("aria-hidden", "true");
    menuBtn.setAttribute("aria-expanded", "false");
    drawerBackdrop.hidden = true;
    menuBtn.focus();
}
menuBtn?.addEventListener("click", () => {
    const isOpen = drawer.classList.contains("open");
    if (isOpen) closeDrawer(); else openDrawer();
});
drawerClose?.addEventListener("click", closeDrawer);
drawerBackdrop?.addEventListener("click", closeDrawer);
document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && drawer.classList.contains("open")) closeDrawer();
});

// ================================
// HTTP helper
// ================================
async function post(url, body) {
    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body ?? {})
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { }
    return { ok: res.ok, status: res.status, text, json };
}

// ================================
// Volume (default muted)
// ================================
function applyVolumeUI(vol01, muted) {
    const v = Math.max(0, Math.min(1, Number(vol01) || 0));
    const pct = Math.round(v * 100);

    video.volume = v;
    video.muted = !!muted;

    if (volumeRange) volumeRange.value = String(pct);
    if (volumeLabel) volumeLabel.textContent = `${pct}%`;
    if (muteBtn) muteBtn.textContent = (video.muted || pct === 0) ? "ミュート" : "音あり";
}
function initVolumeDefaults() {
    applyVolumeUI(0, true);
    muteBtn?.addEventListener("click", () => {
        const isMutedNow = !!video.muted;
        if (isMutedNow) {
            const pct = Number(volumeRange?.value || 0);
            const nextPct = pct > 0 ? pct : 20;
            applyVolumeUI(nextPct / 100, false);
        } else {
            applyVolumeUI(Number(volumeRange?.value || 0) / 100, true);
        }
    });
    volumeRange?.addEventListener("input", () => {
        const pct = Number(volumeRange.value || 0);
        applyVolumeUI(pct / 100, pct === 0);
    });
}

// ================================
// Path edit events (analysis only)
// ================================
if (currentPath) {
    currentPath.addEventListener("input", () => {
        if (!isAnalyzing) return;
        projectVideoPath = String(currentPath.value ?? "").trim();
        setDirty(true);
    });

    currentPath.addEventListener("keydown", async (e) => {
        if (e.key !== "Enter") return;
        if (!isAnalyzing) return;

        const p = getPathText();
        if (!p) { showInfo("パスが空です。"); return; }

        showInfo("動画パスを検証中…");
        const r = await post("/api/validate", { path: p });
        if (!r.ok) {
            if (r.json?.error === "unsupported_ext") showError(`非対応の拡張子です: ${r.json.ext}\n対応: mp4, m4v, mov`);
            else if (r.json?.error === "file_not_found") showError("ファイルが見つかりません（パスを確認してください）");
            else showError(`読み込みに失敗しました (${r.status})\n${r.text}`);
            return;
        }

        resetVideo();
        video.src = buildPlayUrl(r.json.path);
        try {
            video.load();
            video.currentTime = 0;
            showOK("動画パスを反映しました（再生は手動）");
            setDirty(true);
        } catch {
            showError("動画の読み込みに失敗しました。");
        } finally {
            updateTimeOverlay();
            updateActiveLapRow(true);
        }
    });
}

// ================================
// Meta dirty
// ================================
processNameInput?.addEventListener("input", (e) => { projectMeta.processName = e.target.value; setDirty(true); });
elementWorkNameInput?.addEventListener("input", (e) => { projectMeta.elementWorkName = e.target.value; setDirty(true); });

// ================================
// Time/Seconds normalization（Time相対表示＋秒差分）
// ================================
function normalizeLapsTimeAndDuration() {
    if (!laps || laps.length === 0) return;

    for (let i = 0; i < laps.length; i++) {
        laps[i].sec = Math.max(0, Math.floor(Number(laps[i].sec ?? 0)));
    }

    const baseSec = laps[0].sec;

    for (let i = 0; i < laps.length; i++) {
        const cur = laps[i];
        const relSec = Math.max(0, cur.sec - baseSec);

        cur.mmss = (i === 0) ? "00:00" : formatMMSS(relSec);

        if (i < laps.length - 1) {
            const nextSec = Number(laps[i + 1]?.sec ?? cur.sec);
            cur.dt = Math.max(0, Math.floor(nextSec - cur.sec));
        } else {
            cur.dt = 0;
        }
    }
}

// ================================
// LAP table
// ================================
function clearLapTable() {
    laps = [];
    activeIndex = -1;
    lapBody.innerHTML = "";
    setTableEditable(isAnalyzing);
    updateWorkSubtitle();
}

function appendLapRow(no, lapObj) {
    const tr = document.createElement("tr");
    tr.dataset.time = String(lapObj.sec);

    tr.innerHTML = `
    <td>${no}</td>
    <td>
      <input class="cell-input" type="text"
             data-field="work" data-index="${no - 1}"
             value="${escapeHtml(lapObj.work)}" placeholder="作業名" />
    </td>
    <td>
      <select class="cell-select" data-field="cat" data-index="${no - 1}">
        <option value="手作業">手作業</option>
        <option value="歩行">歩行</option>
        <option value="自動">自動</option>
      </select>
    </td>
    <td>${lapObj.dt}</td>
    <td>
      <input class="cell-input" type="text"
             data-field="key" data-index="${no - 1}"
             value="${escapeHtml(lapObj.key)}" placeholder="急所" />
    </td>
    <td>
      <input class="cell-input" type="text"
             data-field="reason" data-index="${no - 1}"
             value="${escapeHtml(lapObj.reason)}" placeholder="急所の理由" />
    </td>
    <td>${escapeHtml(lapObj.mmss)}</td>
  `;

    lapBody.appendChild(tr);

    const sel = tr.querySelector('select[data-field="cat"]');
    if (sel) sel.value = lapObj.cat || "手作業";

    tr.querySelectorAll(".cell-input, .cell-select").forEach(el => {
        el.disabled = !isAnalyzing;
        applyReadonlyStyle(el, !isAnalyzing);
    });
}

function setActiveRow(index, forceScroll = false) {
    if (!lapBody.children.length) {
        activeIndex = -1;
        updateWorkSubtitle();
        return;
    }

    if (index < 0) index = 0;
    if (index >= lapBody.children.length) index = lapBody.children.length - 1;

    const changed = (index !== activeIndex);

    if (activeIndex >= 0) {
        const oldRow = lapBody.children[activeIndex];
        if (oldRow) oldRow.classList.remove("active-row");
    }

    activeIndex = index;

    const row = lapBody.children[activeIndex];
    if (row) row.classList.add("active-row");

    if ((changed || forceScroll) && row) row.scrollIntoView({ block: "center", behavior: "auto" });

    updateWorkSubtitle();
}

function rebuildLapTableFromLaps() {
    normalizeLapsTimeAndDuration();

    lapBody.innerHTML = "";
    laps.forEach((lap, i) => appendLapRow(i + 1, lap));
    setTableEditable(isAnalyzing);
    if (laps.length > 0) setActiveRow(0, true);
    else setActiveRow(-1, false);
}

// ================================
// Jump
// ================================
function jumpToLapIndex(index) {
    if (!laps.length) return;
    if (index < 0) index = 0;
    if (index >= laps.length) index = laps.length - 1;

    const targetSec = laps[index].sec ?? 0;
    video.currentTime = targetSec;

    updateTimeOverlay();
    updateActiveLapRow(true);
    showInfo(`ジャンプ：No ${index + 1} / ${formatMMSS(targetSec)}`);
}

lapBody.addEventListener("click", (e) => {
    if (e.target.closest("input, select, textarea, button")) return;
    const tr = e.target.closest("tr");
    if (!tr) return;
    const rows = Array.from(lapBody.children);
    const idx = rows.indexOf(tr);
    if (idx < 0) return;
    jumpToLapIndex(idx);
});

// ================================
// Right-click redo (analysis only)
// ================================
lapBody.addEventListener("contextmenu", (e) => {
    if (!isAnalyzing) return;
    const tr = e.target.closest("tr");
    if (!tr) return;

    e.preventDefault();

    const rows = Array.from(lapBody.children);
    const idx = rows.indexOf(tr);
    if (idx < 0) return;

    const ok = window.confirm("ここから分析やり直しますか？");
    if (!ok) return;

    truncateFromIndex(idx);
    jumpToLapIndex(idx);
    showInfo(`やり直し：No ${idx + 1} から再開できます`);
});

function truncateFromIndex(idx) {
    laps = laps.slice(0, idx + 1);
    rebuildLapTableFromLaps();
    setActiveRow(idx, true);
    setTableEditable(isAnalyzing);
    setDirty(true);
}

// ================================
// Edit-in-table (analysis only)
// ================================
lapBody.addEventListener("input", (e) => {
    if (!isAnalyzing) return;
    const el = e.target;
    if (!el?.dataset?.field) return;

    const idx = Number(el.dataset.index);
    const field = el.dataset.field;

    if (!Number.isInteger(idx) || !laps[idx]) return;
    if (!["work", "key", "reason"].includes(field)) return;

    laps[idx][field] = el.value;
    if (field === "work" && idx === activeIndex) updateWorkSubtitle();
    setDirty(true);
});

lapBody.addEventListener("change", (e) => {
    if (!isAnalyzing) return;
    const el = e.target;
    if (!el?.dataset?.field) return;

    const idx = Number(el.dataset.index);
    const field = el.dataset.field;

    if (!Number.isInteger(idx) || !laps[idx]) return;
    if (field !== "cat") return;

    const v = el.value;
    if (!["手作業", "歩行", "自動"].includes(v)) return;

    laps[idx].cat = v;
    if (idx === activeIndex) updateWorkSubtitle();
    setDirty(true);
});

// ================================
// Control buttons (LAP)
// ================================
function handleLap() {
    const nowSec = Math.floor(Number(video.currentTime || 0));

    if (laps.length > 0) {
        const lastAbsSec = Number(laps[laps.length - 1].sec ?? 0);
        if (nowSec <= lastAbsSec) {
            showInfo(`この時刻（${formatMMSS(nowSec)}）では追加できません。直前LAP（${formatMMSS(lastAbsSec)}）より後でLAPしてください。`);
            return;
        }
    }

    laps.push({
        t: nowSec,
        sec: nowSec,   // 絶対開始秒
        dt: 0,
        mmss: "",
        work: "",
        cat: "手作業",
        key: "",
        reason: ""
    });

    rebuildLapTableFromLaps();

    showInfo(`LAP：No ${laps.length} / ${formatMMSS(nowSec)}`);
    updateActiveLapRow(true);
    setDirty(true);
}

function wireControlButtons() {
    document.querySelectorAll(".ctrl-btn").forEach(btn => {
        btn.addEventListener("click", async () => {
            const action = btn.dataset.action;
            switch (action) {
                case "play":
                    video.play();
                    showInfo("再生");
                    break;
                case "pause":
                    video.pause();
                    showInfo("一時停止");
                    break;
                case "restart":
                    video.pause();
                    video.currentTime = 0;
                    showInfo("始めから再生");
                    updateTimeOverlay();
                    updateActiveLapRow(true);
                    break;
                case "lap":
                    if (!isAnalyzing) {
                        showInfo("動画分析モード中のみLAPと編集が可能です（右メニューの「動画分析モード」）");
                        return;
                    }
                    handleLap();
                    break;
            }
        });
    });
}

// ================================
// Speed buttons
// ================================
function syncSpeedButtons(speed) {
    const buttons = document.querySelectorAll(".speed-btn");
    buttons.forEach(b => b.classList.remove("active"));
    const target = Array.from(buttons).find(b => Number(b.dataset.speed) === Number(speed));
    if (target) target.classList.add("active");
}
function wireSpeedButtons() {
    const buttons = document.querySelectorAll(".speed-btn");
    buttons.forEach(btn => {
        btn.addEventListener("click", () => {
            const speed = parseFloat(btn.dataset.speed);
            if (!Number.isFinite(speed)) return;
            video.playbackRate = speed;
            buttons.forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            showInfo(`再生速度：${speed.toFixed(1)}x`);
        });
    });
}

// ================================
// Active row sync
// ================================
function updateActiveLapRow(forceScroll = false) {
    if (!laps.length || !lapBody.children.length) {
        setActiveRow(-1, false);
        return;
    }

    const ctSec = Math.floor(Number(video.currentTime || 0));
    let idx = 0;
    for (let i = 0; i < laps.length; i++) {
        const lapSec = laps[i].sec ?? 0;
        if (ctSec >= lapSec) idx = i;
        else break;
    }
    setActiveRow(idx, forceScroll);
}

setInterval(() => {
    updateActiveLapRow(false);
    updateTimeOverlay();
}, 200);

video.addEventListener("timeupdate", () => {
    updateActiveLapRow(false);
    updateTimeOverlay();
});
video.addEventListener("loadedmetadata", () => {
    updateTimeOverlay();
    updateActiveLapRow(true);
});
video.addEventListener("keydown", (e) => e.preventDefault());
video.addEventListener("contextmenu", (e) => e.preventDefault());

video.addEventListener("error", () => {
    const code = video.error?.code;
    const map = {
        1: "ABORTED（再生が中断されました）",
        2: "NETWORK（読み込みエラー）",
        3: "DECODE（デコードできません：コーデック非対応の可能性）",
        4: "SRC_NOT_SUPPORTED（ソース非対応：形式/コーデックの可能性）",
    };
    const detail = code ? (map[code] || `code=${code}`) : "詳細不明";
    showError("再生エラー：" + detail);
});

// ================================
// Save / confirm
// ================================
async function onSaveProject() {
    try {
        if (!window.pywebview?.api?.save_project) {
            showError("save_project APIが見つかりません（app.pyにsave_projectを追加してください）。");
            return { ok: false };
        }

        normalizeLapsTimeAndDuration();

        const payload = {
            processName: projectMeta.processName || (processNameInput?.value || ""),
            elementWorkName: projectMeta.elementWorkName || (elementWorkNameInput?.value || ""),
            videoPath: getPathText(),
            laps: laps.map(x => ({
                sec: x.sec ?? 0,   // 絶対開始秒
                dt: x.dt ?? 0,     // 差分秒
                work: x.work ?? "",
                cat: x.cat ?? "手作業",
                key: x.key ?? "",
                reason: x.reason ?? ""
            }))
        };

        showInfo("保存先を選択してください…");
        const res = await window.pywebview.api.save_project(payload);

        if (!res || !res.ok) {
            showInfo((res && res.error) ? res.error : "キャンセルしました。");
            return { ok: false };
        }

        showOK(`保存しました：${res.path}`);
        setDirty(false);
        return { ok: true };
    } catch (e) {
        showError("保存に失敗しました: " + (e?.message || e));
        return { ok: false };
    }
}

async function confirmSaveIfDirty() {
    if (!isDirty) return true;

    const yes = window.confirm("作業中です。保存しますか？\n（OK＝保存して続行 / キャンセル＝保存せず続行）");
    if (yes) {
        const r = await onSaveProject();
        return r.ok;
    }
    return true;
}

// ================================
// New project (no autoplay)
// ================================
async function loadSelectedVideoNoAutoplay(path) {
    const p = (path ?? "").trim();
    if (!p) return;

    setAnalyzing(false);

    projectMeta.processName = "";
    projectMeta.elementWorkName = "";
    if (processNameInput) processNameInput.value = "";
    if (elementWorkNameInput) elementWorkNameInput.value = "";

    clearLapTable();
    setDirty(false);

    setPathText(p);

    const r = await post("/api/validate", { path: p });
    if (!r.ok) {
        if (r.json?.error === "unsupported_ext") showError(`非対応の拡張子です: ${r.json.ext}\n対応: mp4, m4v, mov`);
        else if (r.json?.error === "file_not_found") showError("ファイルが見つかりません（パスを確認してください）");
        else showError(`読み込みに失敗しました (${r.status})\n${r.text}`);
        return;
    }

    resetVideo();
    video.src = buildPlayUrl(r.json.path);

    try {
        video.load();
        video.currentTime = 0;
        showOK("読み込みました（再生は手動）");
    } catch {
        showError("読み込みに失敗しました。");
    } finally {
        updateTimeOverlay();
        updateActiveLapRow(true);
    }
}

async function onNewProject() {
    try {
        if (!window.pywebview?.api?.pick_video_file) {
            showError("アプリAPIが初期化されていません（pywebview.api が利用できません）。");
            return;
        }

        const ok = await confirmSaveIfDirty();
        if (!ok) return;

        const path = await window.pywebview.api.pick_video_file();
        await loadSelectedVideoNoAutoplay(path);
    } catch (e) {
        showError("ファイル選択に失敗しました: " + (e?.message || e));
    }
}

// ================================
// Open project (CSV)
// ================================
async function onOpenProject() {
    try {
        if (!window.pywebview?.api?.open_project) {
            showError("open_project APIが見つかりません（app.pyにopen_projectを追加してください）。");
            return;
        }

        const ok = await confirmSaveIfDirty();
        if (!ok) return;

        setAnalyzing(false);
        showInfo("CSVを選択してください…");

        const res = await window.pywebview.api.open_project();
        if (!res || !res.ok) {
            showInfo((res && res.error) ? res.error : "キャンセルしました。");
            return;
        }

        // meta
        projectMeta.processName = res.processName || "";
        projectMeta.elementWorkName = res.elementWorkName || "";
        if (processNameInput) processNameInput.value = projectMeta.processName;
        if (elementWorkNameInput) elementWorkNameInput.value = projectMeta.elementWorkName;

        // video path
        const p = (res.videoPath || "").trim();
        setPathText(p);

        // load video (no autoplay)
        if (p) {
            const r = await post("/api/validate", { path: p });
            if (r.ok) {
                resetVideo();
                video.src = buildPlayUrl(r.json.path);
                try { video.load(); video.currentTime = 0; } catch { }
            } else {
                if (r.json?.error === "unsupported_ext") showError(`非対応の拡張子です: ${r.json.ext}\n対応: mp4, m4v, mov`);
                else if (r.json?.error === "file_not_found") showError("CSVに記録された動画ファイルが見つかりません（パスを確認してください）");
                else showError(`読み込みに失敗しました (${r.status})\n${r.text}`);
            }
        } else {
            resetVideo();
        }

        // ---- CSV rows -> laps（ズレない版）----
        // open_project() が返す row.sec は「秒列」＝差分秒のことが多い
        // なので「差分を累積して開始時刻(sec)を作る」
        //
        // startSec = 0
        // row1: sec=startSec(0), startSec += dt1
        // row2: sec=startSec(dt1), startSec += dt2
        // ...
        const src = Array.isArray(res.laps) ? res.laps : [];
        const newLaps = [];

        let startSec = 0;

        for (const row of src) {
            const work = String(row.workName ?? "").trim();
            const catRaw = String(row.category ?? "").trim();
            const cat = ["手作業", "歩行", "自動"].includes(catRaw) ? catRaw : "手作業";
            const key = String(row.kyusho ?? "").trim();
            const reason = String(row.kyushoReason ?? "").trim();

            const dtRaw = Number(String(row.sec ?? "").trim());
            const dt = Number.isFinite(dtRaw) ? Math.max(0, Math.floor(dtRaw)) : 0;

            newLaps.push({
                t: startSec,
                sec: startSec, // ★開始時刻（絶対秒：このCSVの世界では0起点）
                dt: 0,
                mmss: "",
                work,
                cat,
                key,
                reason
            });

            startSec += dt;
        }

        laps = newLaps;
        rebuildLapTableFromLaps();

        try { video.currentTime = 0; } catch { }
        updateTimeOverlay();
        updateActiveLapRow(true);

        showOK(`読み込み完了：${res.csvPath || "CSV"}`);
        setDirty(false);
    } catch (e) {
        showError("プロジェクト読み込みに失敗しました: " + (e?.message || e));
    }
}

// ================================
// std-work payload
// ================================
function openStdWork() {
    normalizeLapsTimeAndDuration();

    // ★追加：動画の長さ（秒）
    const videoDurationSec = Number.isFinite(video.duration) ? Math.ceil(video.duration) : 0;

    const payload = {
        createdAt: new Date().toISOString(),
        processName: projectMeta.processName || (processNameInput?.value || ""),
        elementWorkName: projectMeta.elementWorkName || (elementWorkNameInput?.value || ""),
        videoPath: getPathText(),

        // ★追加
        videoDurationSec,

        laps: laps.map(x => ({
            sec: x.sec ?? 0,
            dt: x.dt ?? 0,
            work: x.work ?? "",
            cat: x.cat ?? "手作業",
            key: x.key ?? "",
            reason: x.reason ?? ""
        }))
    };

    localStorage.setItem("almani_stdwork_payload", JSON.stringify(payload));
    location.href = "/std-work";
}

// ================================
// Menu wiring
// ================================
function wireMenu() {
    document.querySelectorAll(".drawer-item").forEach(btn => {
        btn.addEventListener("click", async () => {
            const action = btn.getAttribute("data-action") || "";
            closeDrawer();

            if (action === "new-project") { await onNewProject(); return; }
            if (action === "open-project") { await onOpenProject(); return; }
            if (action === "save-project") { await onSaveProject(); return; }
            if (action === "analyze") { setAnalyzing(true); return; }
            if (action === "playback") { setAnalyzing(false); return; }
            if (action === "std-work") {
                const ok = await confirmSaveIfDirty();
                if (!ok) return;
                openStdWork();
                return;
            }

            showInfo(`（未実装）: ${btn.textContent}`);
        });
    });
}

// ================================
// Save (already defined above)
// ================================

// ================================
// Active row sync
// ================================
function updateActiveLapRow(forceScroll = false) {
    if (!laps.length || !lapBody.children.length) {
        setActiveRow(-1, false);
        return;
    }

    const ctSec = Math.floor(Number(video.currentTime || 0));
    let idx = 0;
    for (let i = 0; i < laps.length; i++) {
        const lapSec = laps[i].sec ?? 0;
        if (ctSec >= lapSec) idx = i;
        else break;
    }
    setActiveRow(idx, forceScroll);
}

setInterval(() => {
    updateActiveLapRow(false);
    updateTimeOverlay();
}, 200);

video.addEventListener("timeupdate", () => {
    updateActiveLapRow(false);
    updateTimeOverlay();
});
video.addEventListener("loadedmetadata", () => {
    updateTimeOverlay();
    updateActiveLapRow(true);
});
video.addEventListener("keydown", (e) => e.preventDefault());
video.addEventListener("contextmenu", (e) => e.preventDefault());

video.addEventListener("error", () => {
    const code = video.error?.code;
    const map = {
        1: "ABORTED（再生が中断されました）",
        2: "NETWORK（読み込みエラー）",
        3: "DECODE（デコードできません：コーデック非対応の可能性）",
        4: "SRC_NOT_SUPPORTED（ソース非対応：形式/コーデックの可能性）",
    };
    const detail = code ? (map[code] || `code=${code}`) : "詳細不明";
    showError("再生エラー：" + detail);
});

// ================================
// Drawer control + buttons wiring
// ================================
function wireControlButtons() {
    document.querySelectorAll(".ctrl-btn").forEach(btn => {
        btn.addEventListener("click", async () => {
            const action = btn.dataset.action;
            switch (action) {
                case "play":
                    video.play();
                    showInfo("再生");
                    break;
                case "pause":
                    video.pause();
                    showInfo("一時停止");
                    break;
                case "restart":
                    video.pause();
                    video.currentTime = 0;
                    showInfo("始めから再生");
                    updateTimeOverlay();
                    updateActiveLapRow(true);
                    break;
                case "lap":
                    if (!isAnalyzing) {
                        showInfo("動画分析モード中のみLAPと編集が可能です（右メニューの「動画分析モード」）");
                        return;
                    }
                    handleLap();
                    break;
            }
        });
    });
}

function syncSpeedButtons(speed) {
    const buttons = document.querySelectorAll(".speed-btn");
    buttons.forEach(b => b.classList.remove("active"));
    const target = Array.from(buttons).find(b => Number(b.dataset.speed) === Number(speed));
    if (target) target.classList.add("active");
}
function wireSpeedButtons() {
    const buttons = document.querySelectorAll(".speed-btn");
    buttons.forEach(btn => {
        btn.addEventListener("click", () => {
            const speed = parseFloat(btn.dataset.speed);
            if (!Number.isFinite(speed)) return;
            video.playbackRate = speed;
            buttons.forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            showInfo(`再生速度：${speed.toFixed(1)}x`);
        });
    });
}

// ================================
// Save / confirm
// ================================
async function onSaveProject() {
    try {
        if (!window.pywebview?.api?.save_project) {
            showError("save_project APIが見つかりません（app.pyにsave_projectを追加してください）。");
            return { ok: false };
        }

        normalizeLapsTimeAndDuration();

        const payload = {
            processName: projectMeta.processName || (processNameInput?.value || ""),
            elementWorkName: projectMeta.elementWorkName || (elementWorkNameInput?.value || ""),
            videoPath: getPathText(),
            laps: laps.map(x => ({
                sec: x.sec ?? 0,
                dt: x.dt ?? 0,
                work: x.work ?? "",
                cat: x.cat ?? "手作業",
                key: x.key ?? "",
                reason: x.reason ?? ""
            }))
        };

        showInfo("保存先を選択してください…");
        const res = await window.pywebview.api.save_project(payload);

        if (!res || !res.ok) {
            showInfo((res && res.error) ? res.error : "キャンセルしました。");
            return { ok: false };
        }

        showOK(`保存しました：${res.path}`);
        setDirty(false);
        return { ok: true };
    } catch (e) {
        showError("保存に失敗しました: " + (e?.message || e));
        return { ok: false };
    }
}

async function confirmSaveIfDirty() {
    if (!isDirty) return true;

    const yes = window.confirm("作業中です。保存しますか？\n（OK＝保存して続行 / キャンセル＝保存せず続行）");
    if (yes) {
        const r = await onSaveProject();
        return r.ok;
    }
    return true;
}

// ================================
// Init
// ================================
setPathText("");
ensureHeaderModeBadge();
clearLapTable();
wireMenu();
wireControlButtons();
wireSpeedButtons();
syncSpeedButtons(1.0);
updateTimeOverlay();
updateActiveLapRow(true);
setAnalyzing(false);
initVolumeDefaults();