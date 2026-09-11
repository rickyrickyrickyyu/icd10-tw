#!/usr/bin/env python3
"""產生可帶進封閉網路的單一 HTML 檔（沿用 nhi-drug-rules 的做法，改成壓縮內嵌）。

用法：
    python3 etl/build_offline.py

★ 單一 .html、零可執行檔：醫院封閉電腦的 .exe/.bat/.command 幾乎必被擋，純網頁雙擊即開。
★ 壓縮內嵌：public/data 全部 JSON 約 56 MB，原樣內嵌會讓 HTML 破 50 MB、開檔要十幾秒。
  每個檔 gzip 後 base64，執行時才用瀏覽器內建 DecompressionStream 解（懶載，用到才解）。
  代價：需要 Chrome/Edge 80+、Safari 16.4+（前端偵測到舊瀏覽器會顯示明確訊息）。
★ 只讀 public/data（promote 後的正式產物），不重跑 ETL；指紋與線上版比對。
"""

from __future__ import annotations

import base64
import gzip
import hashlib
import json
import re
import sys
import zipfile
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from config import PUBLIC, ROOT  # noqa: E402
from lib.fingerprint import app_fingerprint, data_fingerprint  # noqa: E402

DIST = ROOT / "dist-offline"
OUT = ROOT / "offline"
TODAY = date.today().isoformat()
STAMP = TODAY.replace("-", "")
NAME = f"icd10-tw-offline-{STAMP}.html"

# 防毒／注入紅旗：單獨出現就拒絕輸出。atob 本身合法（解內嵌資料），只禁止與動態執行同時出現。
_AV_FLAGS = ("eval(", "new Function(", "document.write(", "<iframe")


def _embed(obj) -> str:
    """★ json.dumps 不跳脫 `</script>`；上游資料若出現這串會逃逸成可執行 HTML。"""
    s = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
    return s.replace("<", "\\u003c").replace(">", "\\u003e").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")


def collect() -> tuple[dict, int]:
    """{路徑: gzip+base64 字串}。meta.json 保留明文（啟動就要讀，而且很小）。"""
    payload: dict = {}
    raw_total = 0
    for p in sorted(PUBLIC.rglob("*.json")):
        rel = p.relative_to(PUBLIC).as_posix()
        raw = p.read_bytes()
        raw_total += len(raw)
        if rel == "meta.json":
            payload[rel] = json.loads(raw)
        else:
            payload[rel] = base64.b64encode(gzip.compress(raw, compresslevel=9, mtime=0)).decode("ascii")
    return payload, raw_total


def build_html(payload: dict, fp: str) -> str:
    """★ 腳本放在 </body> 之前：Vite 產的是 type=module（延後執行），內嵌成傳統 script
      會立即執行，那時 #root 還不存在 → React error #299 整頁空白（nhi-drug-rules 踩過）。"""
    idx = (DIST / "index.html").read_text(encoding="utf-8")
    app_js = ""
    for m in re.finditer(r'<script[^>]+src="([^"]+)"[^>]*></script>', idx):
        f = DIST / m.group(1).lstrip("./")
        if f.exists():
            app_js += f.read_text(encoding="utf-8") + "\n"
        idx = idx.replace(m.group(0), "")
    for m in re.finditer(r'<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"[^>]*>', idx):
        f = DIST / m.group(1).lstrip("./")
        idx = idx.replace(m.group(0), f"<style>\n{f.read_text(encoding='utf-8')}\n</style>" if f.exists() else "")
    idx = re.sub(r'<link[^>]+rel="(manifest|icon|apple-touch-icon)"[^>]*>', "", idx)
    meta = payload.get("meta.json", {})
    tail = (
        "<script>window.__ICD_OFFLINE__=" + _embed(payload)
        + ";window.__ICD_OFFLINE_META__=" + _embed({"built": meta.get("built"), "packed_at": TODAY,
                                                    "fingerprint": fp, "files": len(payload)})
        + ";</script>\n<script>\n" + app_js + "\n</script>\n"
    )
    if "</body>" not in idx:
        raise SystemExit("❌ dist-offline/index.html 沒有 </body>")
    return idx.replace("</body>", tail + "</body>")


README = """ICD-10 健保診斷碼查詢 — 離線版
================================

怎麼用
------
用滑鼠左鍵連點兩下 {name}，它會用你電腦上的瀏覽器打開。不需安裝、不需網路。
Windows 請用 Edge 或 Chrome（需 80 版以上）；若開在記事本，右鍵 →「開啟方式」→ 選瀏覽器。

注意事項
--------
1. 資料快照日期 {built}。之後健保署若修訂，這個檔案不會自動更新；
   新版在 https://github.com/rickyrickyrickyyu/icd10-tw/releases
2. 代碼與是否可申報一律以衛生福利部中央健康保險署公告為準。本檔為非官方參考工具。
3. 「常用碼」存在這台電腦的瀏覽器裡，換電腦或換瀏覽器就看不到。
4. 手機請用線上版。

資料來源
--------
健保署開放資料（政府資料開放授權條款第 1 版）、CDC/CMS ICD-10、Disease Ontology、
Wikidata、NLM MeSH®、國家教育研究院。
資料快照：{built}　指紋：{fp}
"""


def main() -> int:
    if not (DIST / "index.html").exists():
        raise SystemExit("❌ 找不到 dist-offline，請先執行：pnpm exec vite build --mode offline")
    meta = json.loads((PUBLIC / "meta.json").read_text(encoding="utf-8"))
    fp = data_fingerprint(PUBLIC)
    if meta.get("data_fingerprint") != fp:
        raise SystemExit(f"❌ public/data 指紋 {fp} 與 meta.json {meta.get('data_fingerprint')} 不符，請重跑 make rebuild")

    payload, raw_total = collect()
    html = build_html(payload, fp)
    flags = [f for f in _AV_FLAGS if f in html]
    if flags:
        raise SystemExit(f"❌ 產物含防毒紅旗字樣 {flags}，拒絕輸出")
    if "atob(" in html and any(x in html for x in ("eval(", "new Function(", 'setTimeout("')):
        raise SystemExit("❌ atob 與動態執行同時出現，疑似混淆，拒絕輸出")
    _, _, rest = html.partition("window.__ICD_OFFLINE__=")
    block, _, _ = rest.partition(";window.__ICD_OFFLINE_META__=")
    if "</" in block or "<script" in block.lower():
        raise SystemExit("❌ 內嵌資料含未跳脫的 `</`，可能造成 script 逃逸，拒絕輸出")

    OUT.mkdir(exist_ok=True)
    p = OUT / NAME
    p.write_text(html, encoding="utf-8")
    print(f"✅ {NAME}  {p.stat().st_size/1e6:.1f} MB（資料原始 {raw_total/1e6:.1f} MB，{len(payload)} 檔）")
    readme = README.format(name=NAME, built=meta["built"], fp=fp)
    (OUT / "READ-ME-FIRST.txt").write_bytes(b"\xef\xbb\xbf" + readme.replace("\n", "\r\n").encode("utf-8"))
    zp = OUT / f"icd10-tw-offline-{STAMP}.zip"
    with zipfile.ZipFile(zp, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        z.write(p, p.name)
        z.write(OUT / "READ-ME-FIRST.txt", "READ-ME-FIRST.txt")
    # ★ 清掉舊日期產物，免得把過期版本拖進隨身碟；只刪自己命名規則的檔
    for old in OUT.iterdir():
        if re.fullmatch(r"icd10-tw-offline-\d{8}\.(html|zip)", old.name) and STAMP not in old.name:
            old.unlink()
    (OUT / "MANIFEST.txt").write_text(
        f"packed_at: {TODAY}\ndata_built: {meta['built']}\nfingerprint: {fp}\n"
        f"app_fingerprint: {app_fingerprint(DIST)}\nembedded_files: {len(payload)}\n"
        f"{p.name}  {p.stat().st_size} bytes  {hashlib.sha256(p.read_bytes()).hexdigest()[:16]}\n"
        f"{zp.name}  {zp.stat().st_size} bytes\n", encoding="utf-8")
    print(f"📦 {zp.name}  {zp.stat().st_size/1e6:.1f} MB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
