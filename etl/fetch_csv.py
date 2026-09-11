#!/usr/bin/env python3
"""下載 6 個健保署 ICD CSV → data/raw/<key>.csv，並記錄 sha／筆數／表頭。

用法：
    python3 etl/fetch_csv.py            下載全部
    python3 etl/fetch_csv.py --check    只下載比對 sha，印出 CHANGED=0|1（每週排程用）

★ strict UTF-8：解碼失敗直接中止。曾因管線寫法把串流截斷，看起來像 API 回壞資料 ——
  不管哪一邊的錯，半截 CSV 都不能進下游。
★ 變更偵測比 sha 不比日期：data.gov.tw 的「更新時間」每次重新上架都會跳，
  內容不見得有變；反過來官方也可能不改日期就換內容。
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from config import BUILD, DATASETS, NHI_API, RAW, SNAPSHOTS, SOURCES  # noqa: E402
from lib.http import fetch  # noqa: E402
from lib.prov import Registry  # noqa: E402

MANIFEST = RAW / "fetch_manifest.json"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()

    prev = {}
    last = SNAPSHOTS / "last_run.json"
    if last.exists():
        prev = json.loads(last.read_text(encoding="utf-8")).get("sources_sha", {})

    reg = Registry(SOURCES)
    man: dict[str, dict] = {}
    changed = []
    for key, rid in DATASETS.items():
        url = NHI_API.format(rid)
        raw = fetch(url)
        try:
            text = raw.decode("utf-8-sig")          # strict
        except UnicodeDecodeError as e:
            raise SystemExit(f"❌ {key} 不是合法 UTF-8（位置 {e.start}）—— 下載可能被截斷，拒絕寫入")
        rows = list(csv.reader(io.StringIO(text)))
        sha = hashlib.sha256(raw).hexdigest()
        man[key] = {"rid": rid, "url": url, "sha256": sha, "bytes": len(raw),
                    "rows": len(rows) - 1, "header": rows[0] if rows else []}
        if prev.get(key) != sha:
            changed.append(key)
        if not args.check:
            dest = RAW / f"{key}.csv"
            tmp = dest.with_suffix(".part")
            tmp.write_bytes(raw)
            tmp.replace(dest)
            reg.register_http(f"nhi:{key}", url, dest, rows=len(rows) - 1)
        print(f"  {key:10s} {len(rows)-1:>7,} 列  {len(raw)/1e6:5.1f} MB  sha {sha[:10]}"
              + ("  ← 有變" if key in changed else ""))

    if not args.check:
        MANIFEST.write_text(json.dumps(man, ensure_ascii=False, indent=1), encoding="utf-8")
        reg.dump()
    (BUILD / "fetch_events.json").write_text(
        json.dumps({"changed": changed}, ensure_ascii=False), encoding="utf-8")
    print(f"CHANGED={1 if changed else 0}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
