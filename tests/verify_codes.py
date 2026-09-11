#!/usr/bin/env python3
"""逐碼核對：public/data 的 CM／PCS 與健保署原始 CSV 完全一致（代碼、中英文名、USE、狀態）。

★ 為什麼要有：前端資料經過 normalize → site 兩次轉換，任何一步錯位（欄位順序、
  NFC、去重）都會讓某些碼的名稱悄悄變成別人的。gate 6 只驗 12 個金絲雀，這裡驗全部。
  中文名以 NFC + 空白正規化後比對（與 normalize_codes.py 相同規則）。
"""

from __future__ import annotations

import csv
import json
import re
import sys
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"
PUB = ROOT / "public" / "data"
clean = lambda s: re.sub(r"\s+", " ", unicodedata.normalize("NFC", s)).strip()  # noqa: E731
ST = {"": None, "代碼新增": "new", "英文名稱修改": "en", "中文名稱修改": "zh"}


def check(kind: str) -> list[str]:
    if not (RAW / f"{kind}.csv").exists():
        return [f"缺 data/raw/{kind}.csv（先跑 make refresh）"]
    with (RAW / f"{kind}.csv").open(encoding="utf-8-sig", newline="") as f:
        raw = list(csv.reader(f))[1:]
    pub = {r[0]: r for r in json.loads((PUB / f"{kind}.json").read_text(encoding="utf-8"))["rows"]}
    errs = []
    if len(raw) != len(pub):
        errs.append(f"{kind}: 筆數 raw {len(raw)} ≠ public {len(pub)}")
    for r in raw:
        c = r[0].strip().upper()
        p = pub.get(c)
        if not p:
            errs.append(f"{kind}: {c} 不在 public")
            continue
        want = [c, clean(r[3]), clean(r[2]), int(r[1]), ST.get(r[4].strip()), r[5].strip() or None]
        if p[:6] != want:
            errs.append(f"{kind}: {c} 不一致 public={p[:6]} raw={want}")
        if len(errs) > 20:
            break
    return errs


def main() -> int:
    errs = check("cm") + check("pcs")
    if errs:
        print("❌ 逐碼核對失敗：\n  " + "\n  ".join(errs[:20]))
        return 1
    print("✅ 逐碼核對：CM、PCS 全部與健保署原始 CSV 一致")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
