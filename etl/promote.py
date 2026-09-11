#!/usr/bin/env python3
"""staging/site → public/data 整包替換。validate 全綠（或人工放行）才執行。

★ 用目錄替換而不是逐檔覆蓋：分片檔（nodes/、map14/、map9/）數量會變，逐檔覆蓋會留下
  上一版多出來的舊分片，指紋對得上 meta 卻混了舊資料。
"""

from __future__ import annotations

import json
import shutil
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from config import PUBLIC, RAW, SNAPSHOTS, STAGING  # noqa: E402

SITE = STAGING / "site"


def main() -> int:
    rep = STAGING / "validation_report.json"
    if not rep.exists():
        raise SystemExit("❌ 找不到 validation_report.json，請先跑 validate.py")
    gates = json.loads(rep.read_text(encoding="utf-8"))
    failed = [g for g in gates if not g["passed"] and not g.get("overridden")]
    if failed:
        raise SystemExit(f"❌ 仍有 {len(failed)} 個閘門失敗，拒絕 promote：{[g['name'] for g in failed]}")
    over = [g for g in gates if g.get("overridden")]
    if over:
        print(f"⚠️  人工放行：{[g['name'] for g in over]}（記錄在 snapshots/last_run.json）")

    tmp = PUBLIC.with_name(PUBLIC.name + ".new")
    old = PUBLIC.with_name(PUBLIC.name + ".old")
    shutil.rmtree(tmp, ignore_errors=True)
    shutil.rmtree(old, ignore_errors=True)
    shutil.copytree(SITE, tmp)
    if PUBLIC.exists():
        PUBLIC.rename(old)
    tmp.rename(PUBLIC)
    shutil.rmtree(old, ignore_errors=True)

    man = json.loads((RAW / "fetch_manifest.json").read_text(encoding="utf-8"))
    meta = json.loads((PUBLIC / "meta.json").read_text(encoding="utf-8"))
    vocab_n = len(json.loads((PUBLIC / "vocab_cm.json").read_text(encoding="utf-8"))["t"])
    (SNAPSHOTS / "last_run.json").write_text(json.dumps({
        "run_at": date.today().isoformat(),
        "rows": {k: v["rows"] for k, v in man.items()},
        "sources_sha": {k: v["sha256"] for k, v in man.items()},   # fetch_csv.py --check 的比對基準
        "vocab_cm": vocab_n,
        "data_fingerprint": meta["data_fingerprint"],
        "sources": meta.get("sources"),
        "gates": gates,
    }, ensure_ascii=False, indent=1), encoding="utf-8")
    n = sum(1 for _ in PUBLIC.rglob("*.json"))
    print(f"✅ promote 完成：public/data {n} 檔｜指紋 {meta['data_fingerprint']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
