# app.py
import sys
import socket
import threading
import time
import mimetypes
import csv
from pathlib import Path
from urllib.parse import unquote

import tkinter as tk
from tkinter import filedialog

import webview
from flask import Flask, request, jsonify, Response, abort, send_file

# =========================
# パス解決（通常実行 / PyInstaller 両対応）
# =========================
def base_dir() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).parent
    return Path(__file__).resolve().parent

APP_DIR = base_dir()
WEB_DIR = APP_DIR / "web"

# ffmpeg無し前提：AVIは除外（拡張子だけのチェック。中身コーデックはブラウザ依存）
ALLOWED_EXTS = {".mp4", ".m4v", ".mov"}

app = Flask(__name__)

# =========================
# 旧CSV互換：ユーティリティ
# =========================
INVALID_WIN = '<>:"/\\|?*'

def _safe_float(x):
    try:
        if x is None:
            return None
        s = str(x).strip()
        if s == "":
            return None
        return float(s)
    except Exception:
        return None

def _read_csv_compat(csv_path: str):
    """
    旧Excel文化のCSVを想定し、cp932優先で読む（ダメならutf-8-sig、utf-8）。
    """
    last_err = None
    for enc in ("cp932", "utf-8-sig", "utf-8"):
        try:
            with open(csv_path, "r", encoding=enc, newline="") as f:
                return list(csv.reader(f))
        except Exception as e:
            last_err = e
    raise last_err

def _cell(rows, r, c) -> str:
    rr = r - 1
    cc = c - 1
    if rr < 0 or cc < 0:
        return ""
    if rr >= len(rows):
        return ""
    row = rows[rr]
    if cc >= len(row):
        return ""
    v = row[cc]
    return "" if v is None else str(v)

def _format_mm_ss_from_excel_time(v) -> str:
    """
    - "mm:ss"等ならそのまま
    - Excel時刻シリアル(1日=1.0)なら mm:ss に復元
    - 秒数っぽい数値でも mm:ss に寄せる
    """
    if v is None:
        return ""
    s = str(v).strip()
    if s == "":
        return ""
    if ":" in s:
        return s

    num = _safe_float(s)
    if num is None:
        return s

    if 0 <= num < 1:
        total_sec = int(round(num * 86400))
    else:
        total_sec = int(round(num))

    if total_sec < 0:
        total_sec = 0

    mm = total_sec // 60
    ss = total_sec % 60
    return f"{mm:02d}:{ss:02d}"

def _sanitize_filename(name: str, fallback: str = "project") -> str:
    s = (name or "").strip()
    if not s:
        s = fallback
    # Windows禁止文字を置換
    for ch in INVALID_WIN:
        s = s.replace(ch, " ")
    # 末尾のドット/スペースはNG
    s = s.strip().strip(".")
    # 連続スペース整理
    s = " ".join(s.split())
    if not s:
        s = fallback
    # 長すぎ防止（雑に）
    if len(s) > 120:
        s = s[:120].rstrip()
    return s

def _sec_to_excel_time_serial(sec: int) -> str:
    """
    Excel時刻シリアル(1日=1.0)にしてCSVへ書く。
    旧CSVのTime列が数値（例: 0.0001273）だった互換のため。
    文字列で返す（Excelで数値として読める）
    """
    try:
        s = int(sec)
        if s < 0:
            s = 0
        return f"{s/86400:.12g}"  # それっぽい桁で
    except Exception:
        return "0"

def _ensure_row_cols(rows, r_index_1based: int, c_len: int):
    """rowsの指定行が存在し、列数がc_len以上になるように拡張"""
    while len(rows) < r_index_1based:
        rows.append([])
    row = rows[r_index_1based - 1]
    while len(row) < c_len:
        row.append("")
    return row

# =========================
# JS → Python ブリッジ API
# =========================
class Api:
    def pick_video_file(self) -> str:
        root = tk.Tk()
        root.withdraw()
        try:
            root.attributes("-topmost", True)
        except Exception:
            pass

        filetypes = [
            ("Video Files", "*.mp4 *.m4v *.mov"),
            ("MP4", "*.mp4"),
            ("M4V", "*.m4v"),
            ("MOV", "*.mov"),
        ]

        path = filedialog.askopenfilename(
            title="動画ファイルを選択",
            initialdir=str(Path.home()),
            filetypes=filetypes
        )

        try:
            root.destroy()
        except Exception:
            pass

        return path or ""

    def open_project(self):
        """
        右メニュー「プロジェクトを開く」:
        旧Excel版ALMANI互換CSVを選択して読み込み、固定マッピングで返す。
        """
        try:
            root = tk.Tk()
            root.withdraw()
            try:
                root.attributes("-topmost", True)
            except Exception:
                pass

            csv_path = filedialog.askopenfilename(
                title="ALMANIプロジェクト(CSV)を選択",
                initialdir=str(Path.home()),
                filetypes=[("CSV", "*.csv"), ("All Files", "*.*")]
            )

            try:
                root.destroy()
            except Exception:
                pass

            if not csv_path:
                return {"ok": False, "error": "キャンセルしました。"}

            rows = _read_csv_compat(csv_path)

            process_name = _cell(rows, 1, 2).strip()
            element_work_name = _cell(rows, 2, 2).strip()
            video_full_path = _cell(rows, 3, 2).strip()

            laps = []
            # R12〜最終行まで全部スキャン（空行はスキップ）
            for r in range(12, len(rows) + 1):
                no_ = _cell(rows, r, 2).strip()
                work = _cell(rows, r, 3).strip()
                kubun = _cell(rows, r, 4).strip()
                time_raw = _cell(rows, r, 5).strip()
                sec_raw = _cell(rows, r, 6).strip()
                kyusho = _cell(rows, r, 7).strip()
                reason = _cell(rows, r, 8).strip()

                if (no_ == "" and work == "" and kubun == "" and time_raw == "" and
                    sec_raw == "" and kyusho == "" and reason == ""):
                    continue

                laps.append({
                    "no": no_,
                    "workName": work,
                    "category": kubun,
                    "time": _format_mm_ss_from_excel_time(time_raw),
                    "sec": sec_raw,
                    "kyusho": kyusho,
                    "kyushoReason": reason
                })

            return {
                "ok": True,
                "csvPath": csv_path,
                "processName": process_name,
                "elementWorkName": element_work_name,
                "videoPath": video_full_path,
                "laps": laps
            }

        except Exception as e:
            return {"ok": False, "error": f"CSV読み込みに失敗しました: {e}"}

    def save_project(self, payload: dict):
        """
        右メニュー「プロジェクトを保存」:
        旧互換CSVで保存する（保存先はユーザーがダイアログで選択）

        ファイル名： "【工程名】要素作業名.csv"（自動生成）
        文字コード：cp932
        """
        try:
            process_name = str((payload or {}).get("processName") or "").strip()
            element_work_name = str((payload or {}).get("elementWorkName") or "").strip()
            video_path = str((payload or {}).get("videoPath") or "").strip()
            laps = (payload or {}).get("laps") or []
            if not isinstance(laps, list):
                laps = []

            safe_proc = _sanitize_filename(process_name, "工程名未設定")
            safe_elem = _sanitize_filename(element_work_name, "要素作業名未設定")
            default_filename = f"【{safe_proc}】{safe_elem}.csv"

            root = tk.Tk()
            root.withdraw()
            try:
                root.attributes("-topmost", True)
            except Exception:
                pass

            save_path = filedialog.asksaveasfilename(
                title="ALMANIプロジェクトを保存",
                initialdir=str(Path.home()),
                initialfile=default_filename,
                defaultextension=".csv",
                filetypes=[("CSV", "*.csv"), ("All Files", "*.*")]
            )

            try:
                root.destroy()
            except Exception:
                pass

            if not save_path:
                return {"ok": False, "error": "キャンセルしました。"}

            # --- 旧互換レイアウトで行列を構築 ---
            rows = []

            # 最低でも8列（C8まで）を意識
            # R1C2 工程名
            r1 = _ensure_row_cols(rows, 1, 8)
            r1[1] = process_name

            # R2C2 要素作業名
            r2 = _ensure_row_cols(rows, 2, 8)
            r2[1] = element_work_name

            # R3C2 動画フルパス
            r3 = _ensure_row_cols(rows, 3, 8)
            r3[1] = video_path

            # R11 ヘッダー（C2〜C8）
            r11 = _ensure_row_cols(rows, 11, 8)
            r11[1] = "No"
            r11[2] = "作業名"
            r11[3] = "区分"
            r11[4] = "Time"
            r11[5] = "秒"
            r11[6] = "急所"
            r11[7] = "急所の理由"

            # R12〜 データ
            # laps は JS 側の構造：
            #   sec: 絶対秒（0秒からの経過）
            #   dt : 差分秒（1行前からの差分／1行目だけ0からの経過）
            for i, lap in enumerate(laps, start=12):
                row = _ensure_row_cols(rows, i, 8)

                no = i - 11
                work = str((lap or {}).get("work") or "").strip()
                cat = str((lap or {}).get("cat") or "").strip()
                key = str((lap or {}).get("key") or "").strip()
                reason = str((lap or {}).get("reason") or "").strip()

                # Time列：旧互換として Excel時刻シリアル（絶対秒から）
                sec_abs = _safe_float((lap or {}).get("sec"))
                sec_abs_i = int(sec_abs) if sec_abs is not None else 0
                time_serial = _sec_to_excel_time_serial(sec_abs_i)

                # 秒列：画面表示と同じく dt（差分秒）を保存（旧の「時間(秒)」に近い）
                dt_val = _safe_float((lap or {}).get("dt"))
                dt_i = int(dt_val) if dt_val is not None else 0

                row[1] = str(no)              # C2 No
                row[2] = work                 # C3 作業名
                row[3] = cat                  # C4 区分
                row[4] = time_serial          # C5 Time（数値）
                row[5] = str(dt_i)            # C6 秒（差分）
                row[6] = key                  # C7 急所
                row[7] = reason               # C8 急所の理由

            # 書き出し（cp932 / Excel互換）
            sp = Path(save_path)
            sp.parent.mkdir(parents=True, exist_ok=True)

            with open(sp, "w", encoding="cp932", newline="") as f:
                w = csv.writer(f, lineterminator="\n")
                w.writerows(rows)

            return {"ok": True, "path": str(sp)}

        except Exception as e:
            return {"ok": False, "error": f"保存に失敗しました: {e}"}

# =========================
# 静的ファイル配信
# =========================
@app.get("/")
def index():
    f = WEB_DIR / "index.html"
    if not f.exists():
        abort(404)
    return send_file(str(f))

@app.get("/styles.css")
def css():
    f = WEB_DIR / "styles.css"
    if not f.exists():
        abort(404)
    return send_file(str(f), mimetype="text/css")

@app.get("/app.js")
def js():
    f = WEB_DIR / "app.js"
    if not f.exists():
        abort(404)
    return send_file(str(f), mimetype="application/javascript")

# ★追加：標準作業組み合わせ表（別HTML）
@app.get("/std-work")
def std_work():
    f = WEB_DIR / "std-work.html"
    if not f.exists():
        abort(404)
    return send_file(str(f))

@app.get("/std-work.css")
def std_work_css():
    f = WEB_DIR / "std-work.css"
    if not f.exists():
        abort(404)
    return send_file(str(f), mimetype="text/css")

@app.get("/std-work.js")
def std_work_js():
    f = WEB_DIR / "std-work.js"
    if not f.exists():
        abort(404)
    return send_file(str(f), mimetype="application/javascript")

@app.get("/api/allowed")
def api_allowed():
    return jsonify({"ok": True, "allowed_exts": sorted(ALLOWED_EXTS)})

# =========================
# <video> 用：Range対応ストリーミング
# =========================
def _parse_range_header(range_header: str, file_size: int):
    if not range_header or not range_header.startswith("bytes="):
        return None
    r = range_header.replace("bytes=", "").split(",")[0].strip()
    start_s, end_s = r.split("-")
    start = int(start_s) if start_s else 0
    end = int(end_s) if end_s else file_size - 1
    if start >= file_size:
        return None
    end = min(end, file_size - 1)
    return start, end

def stream_file(path: Path):
    if not path.exists() or not path.is_file():
        abort(404)

    ext = path.suffix.lower()
    if ext not in ALLOWED_EXTS:
        abort(415)

    file_size = path.stat().st_size

    if ext in (".mp4", ".m4v"):
        mime = "video/mp4"
    elif ext == ".mov":
        mime = "video/quicktime"
    else:
        mime, _ = mimetypes.guess_type(str(path))
        mime = mime or "application/octet-stream"

    range_header = request.headers.get("Range")
    byte_range = _parse_range_header(range_header, file_size)

    if byte_range:
        start, end = byte_range
        length = end - start + 1

        def generate():
            with open(path, "rb") as f:
                f.seek(start)
                remaining = length
                chunk = 1024 * 1024
                while remaining > 0:
                    data = f.read(min(chunk, remaining))
                    if not data:
                        break
                    remaining -= len(data)
                    yield data

        rv = Response(generate(), 206, mimetype=mime, direct_passthrough=True)
        rv.headers["Content-Range"] = f"bytes {start}-{end}/{file_size}"
        rv.headers["Accept-Ranges"] = "bytes"
        rv.headers["Content-Length"] = str(length)
        return rv

    def generate_all():
        with open(path, "rb") as f:
            while True:
                data = f.read(1024 * 1024)
                if not data:
                    break
                yield data

    rv = Response(generate_all(), 200, mimetype=mime, direct_passthrough=True)
    rv.headers["Content-Length"] = str(file_size)
    rv.headers["Accept-Ranges"] = "bytes"
    return rv

@app.get("/video")
def video():
    raw = unquote(request.args.get("path", ""))
    return stream_file(Path(raw))

@app.post("/api/validate")
def api_validate():
    data = request.get_json(force=True)
    raw = (data.get("path") or "").strip()
    if not raw:
        return jsonify({"ok": False, "error": "empty_path"}), 400

    p = Path(raw)
    if not p.exists():
        return jsonify({"ok": False, "error": "file_not_found"}), 400

    ext = p.suffix.lower()
    if ext not in ALLOWED_EXTS:
        return jsonify({"ok": False, "error": "unsupported_ext", "ext": ext}), 415

    return jsonify({"ok": True, "path": str(p), "ext": ext})

# =========================
# 起動
# =========================
def find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]

def run_server(port: int):
    app.run(host="127.0.0.1", port=port, debug=False, use_reloader=False)

def main():
    port = find_free_port()
    threading.Thread(target=run_server, args=(port,), daemon=True).start()
    time.sleep(0.25)

    url = f"http://127.0.0.1:{port}/"
    webview.create_window("ALMANI（アルマニ）", url, maximized=True, js_api=Api())
    webview.start()

if __name__ == "__main__":
    main()