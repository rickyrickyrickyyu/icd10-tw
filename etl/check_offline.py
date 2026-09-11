#!/usr/bin/env python3
"""離線包是否與線上版同一份資料與前端。

★ 不做成 validate.py 的閘門：離線包是 promote 的下游，validate 跑的時候 offline/ 必然還是
  上一輪的產物，當閘門會每次誤報。正確位置是 promote 之後（pipeline 最後一步、make verify）。
★ 比指紋不比日期：同一天重跑 ETL 資料已變但日期不變。
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from config import PUBLIC, ROOT  # noqa: E402
from lib.fingerprint import app_fingerprint, data_fingerprint  # noqa: E402


def main() -> int:
    man = ROOT / "offline" / "MANIFEST.txt"
    if not man.exists():
        print("－ 尚未產生離線包（make offline），略過")
        return 0
    live = data_fingerprint(PUBLIC)
    meta = json.loads((PUBLIC / "meta.json").read_text(encoding="utf-8"))
    body = man.read_text(encoding="utf-8")
    get = lambda k: (m.group(1) if (m := re.search(rf"{k}:\s*(\S+)", body)) else None)  # noqa: E731

    if meta.get("data_fingerprint") != live:
        print(f"❌ public/data 指紋 {live} ≠ meta.json {meta.get('data_fingerprint')} → make rebuild")
        return 1
    if get("fingerprint") != live:
        print(f"❌ 離線包資料指紋 {get('fingerprint')} ≠ 線上 {live} → make offline")
        return 1
    dist = ROOT / "dist-offline"
    if dist.exists() and get("app_fingerprint") and get("app_fingerprint") != app_fingerprint(dist):
        print("❌ 離線包前端指紋與目前建置不符 → make offline")
        return 1
    expect = sum(1 for p in PUBLIC.rglob("*.json")
                 if not p.relative_to(PUBLIC).as_posix().startswith(("detail/", "pdetail/")))
    if get("embedded_files") and int(get("embedded_files")) != expect:
        print(f"❌ 離線包收錄 {get('embedded_files')} 檔，public/data 有 {expect} 檔 → collect() 漏了")
        return 1
    print(f"✅ 離線包與線上版同一份資料與前端（指紋 {live}｜{expect} 個資料檔｜快照 {meta['built']}）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
