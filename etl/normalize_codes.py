#!/usr/bin/env python3
"""健保 CM／PCS CSV → staging/codes_{cm,pcs}.json

輸出（依官方檔案順序）：
    {"codes": [[code, zh, en, use, st, rev, parent], ...], "report": {...}}
      st  : None | "new"（代碼新增）| "en"（英文名稱修改）| "zh"（中文名稱修改）
      rev : 官方「修訂日期」欄原文（例：「115.08.27修正中文名稱」），None 表示空
      parent: 檔內存在的最長前綴（CM）；PCS 無階層 → None（表格前綴由 build_vocab 補）

★ NFC：健保中文名稱含 CJK 相容字（U+F900–FAFF）時，看起來一樣但比對不到
  （nhi-drug-rules 在 86 個章節踩過）。相容字都有單一標準分解，NFC 會轉成統一碼。
"""

from __future__ import annotations

import csv
import json
import re
import sys
import unicodedata
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from config import CONTRACT, RAW, RE_CM, RE_PCS, STAGING  # noqa: E402

ST = {"": None, "代碼新增": "new", "英文名稱修改": "en", "中文名稱修改": "zh"}
COMPAT = re.compile("[豈-﫿]")


def clean(s: str) -> str:
    return re.sub(r"\s+", " ", unicodedata.normalize("NFC", s)).strip()


def parent_of(code: str, have: set[str]) -> str | None:
    c = code
    while len(c) > 3:
        c = c[:-1].rstrip(".")
        if c in have:
            return c
    return None


def run(kind: str) -> dict:
    path = RAW / f"{kind}.csv"
    with path.open(encoding="utf-8-sig", newline="") as f:
        rows = list(csv.reader(f))
    header, body = rows[0], rows[1:]
    if header != CONTRACT[kind]:
        raise SystemExit(f"❌ {kind} 表頭與契約不符：{header}")
    pat = re.compile(RE_CM if kind == "cm" else RE_PCS)
    seen: set[str] = set()
    bad, dups, bad_st, compat_before = [], [], [], 0
    out = []
    for r in body:
        code = r[0].strip().upper()
        if not pat.match(code):
            bad.append(code)
            continue
        if code in seen:
            dups.append(code)
            continue
        seen.add(code)
        compat_before += len(COMPAT.findall(r[3]))
        st_raw = r[4].strip()
        if st_raw not in ST:
            bad_st.append(st_raw)
        out.append([code, clean(r[3]), clean(r[2]), int(r[1]), ST.get(st_raw), r[5].strip() or None, None])
    if kind == "cm":
        for row in out:
            row[6] = parent_of(row[0], seen)
    compat_after = sum(len(COMPAT.findall(x[1])) for x in out)
    rep = {"rows": len(body), "kept": len(out), "billable": sum(1 for x in out if x[3] == 1),
           "bad_format": bad[:20], "n_bad_format": len(bad), "dups": dups[:20], "n_dups": len(dups),
           "unknown_status": sorted(set(bad_st)), "compat_before": compat_before,
           "compat_after": compat_after,
           "orphans": [x[0] for x in out if kind == "cm" and len(x[0]) > 3 and not x[6]][:20]}
    (STAGING / f"codes_{kind}.json").write_text(
        json.dumps({"codes": out, "report": rep}, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8")
    return rep


def main() -> int:
    for kind in ("cm", "pcs"):
        rep = run(kind)
        print(f"  {kind}: {rep['kept']:,} 碼（可申報 {rep['billable']:,}）｜格式錯 {rep['n_bad_format']}"
              f"｜重複 {rep['n_dups']}｜相容字 {rep['compat_before']}→{rep['compat_after']}"
              f"｜孤兒 {len(rep['orphans'])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
