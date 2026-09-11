#!/usr/bin/env python3
"""重大傷病 2014↔2023 ICD-10-CM 對照表（健保署 ods）→ staging/catastrophic.json

輸入：curation/catastrophic/*.ods（人工從瀏覽器下載的快照，sha 記在 catastrophic.yaml）
      ★ 健保署 dl- 連結對 curl／CI 回 WAF 的 5.6 KB HTML，只有瀏覽器拿得到。
輸出：{"codes": {code23: [{"cat": 1, "note": "本次不受轉版影響", "ver": ""}...]},
       "categories": {1: "…", ...}, "report": {...}}

★ ods 裡的碼不帶小數點（C4321）→ 以 2023 版主檔為準補回（C43.21）。
  補點規則：CM 第 3 碼後加點；補完若主檔沒有這個碼 → 記在 report 讓 gate 擋。
★ 只用 stdlib 解析（zipfile + xml），不加 odfpy 依賴。
"""

from __future__ import annotations

import hashlib
import json
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))
from config import CURATION, STAGING  # noqa: E402

T = "{urn:oasis:names:tc:opendocument:xmlns:table:1.0}"
CAT_YAML = CURATION / "catastrophic.yaml"


def ods_rows(path: Path, sheet_index: int = 0) -> list[list[str]]:
    with zipfile.ZipFile(path) as z:
        root = ET.fromstring(z.read("content.xml"))
    sheets = list(root.iter(T + "table"))
    out = []
    for tr in sheets[sheet_index].iter(T + "table-row"):
        cells: list[str] = []
        for c in tr.iter(T + "table-cell"):
            n = min(int(c.get(T + "number-columns-repeated", "1")), 30)
            cells += ["".join(c.itertext()).strip()] * n
        if any(cells):
            out.append(cells)
    return out


def dotted(code: str) -> str:
    code = code.strip().upper()
    return code if len(code) <= 3 or "." in code else f"{code[:3]}.{code[3:]}"


def main() -> int:
    conf = yaml.safe_load(CAT_YAML.read_text(encoding="utf-8"))
    src = CURATION / "catastrophic" / conf["file"]
    sha = hashlib.sha256(src.read_bytes()).hexdigest()
    cm = {c[0] for c in json.loads((STAGING / "codes_cm.json").read_text(encoding="utf-8"))["codes"]}

    rows = ods_rows(src)
    hdr_i = next(i for i, r in enumerate(rows) if r and r[0] == "重大傷病類別")
    hdr = rows[hdr_i]
    want = ["重大傷病類別", "2014年ICD-10-CM", "2014 ICD-10-CM中文名稱", "2023年ICD-10-CM",
            "2023 ICD-10-CM_中文名稱", "2014代碼狀態", "2023代碼狀態", "說明", "版本註記"]
    if hdr[:9] != want:
        raise SystemExit(f"❌ 重大傷病 ods 表頭改了：{hdr[:9]}")

    codes: dict[str, list] = {}
    missing, bad_cat = [], []
    for r in rows[hdr_i + 1:]:
        r = (r + [""] * 9)[:9]
        if not r[3]:
            continue
        try:
            cat = int(r[0])
        except ValueError:
            bad_cat.append(r[0])
            continue
        c23 = dotted(r[3])
        if c23 not in cm:
            missing.append(c23)
            continue
        entry = {"cat": cat, "note": r[7] or None, "ver": r[8] or None, "old": dotted(r[1]) if r[1] else None}
        if entry not in codes.setdefault(c23, []):
            codes[c23].append(entry)

    cats = {int(k): v for k, v in (conf.get("categories") or {}).items()}
    used = sorted({e["cat"] for v in codes.values() for e in v})
    rep = {"file": conf["file"], "sha256": sha, "sha_expected": conf.get("sha256"),
           "rows": len(rows) - hdr_i - 1, "codes": len(codes), "missing_in_cm": missing[:30],
           "n_missing": len(missing), "bad_category": bad_cat[:10],
           "categories_used": used, "categories_unnamed": [c for c in used if c not in cats],
           "version": conf.get("version"), "reviewed": conf.get("reviewed", False)}
    (STAGING / "catastrophic.json").write_text(json.dumps(
        {"codes": codes, "categories": cats, "report": rep}, ensure_ascii=False,
        separators=(",", ":")), encoding="utf-8")
    print(f"  重大傷病：{len(codes):,} 碼｜類別 {len(used)}｜主檔查無 {len(missing)}"
          f"｜未命名類別 {rep['categories_unnamed']}｜sha {'✓' if sha == conf.get('sha256') else '✗'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
