#!/usr/bin/env python3
"""2014↔2023、ICD-9→2023 對應檔 → staging。

輸出：
  map14.json   {"cm": {old: [[new, st14, st23], ...]}, "pcs": {...},
                "rev_cm": {new: [old, ...]}, "rev_pcs": {...}}
               ★ 只收「非恆等列」：同碼且同中文名、且兩邊狀態皆空的列（CM 67,838 列）
                 等於「沒變」，查不到時視同原碼即可。收進來只會讓分片大 10 倍。
  map9.json    {"cm": {icd9: [[code23, flag], ...]}, "pcs": {...},
                "names": {icd9: [zh, en]}, "rev_cm": {code23: [icd9...]}, "rev_pcs": {...}}
               ★ 排除「異動情形 = 刪除對應」（1,199 列）：那是已撤銷的對應，顯示出來會誤導。
               flag 是 GEM 五碼：approximate/no map/combination/scenario/choice list。
  oldnames.json {"zh14": {code23: [2014 中文名...]}, "zh9": {code23: [ICD-9 中文名...]}}
               給 build_vocab 當中文入口詞（舊譯名、2001 年用語）。
"""

from __future__ import annotations

import csv
import json
import sys
import unicodedata
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from config import CONTRACT, RAW, STAGING  # noqa: E402

nfc = lambda s: unicodedata.normalize("NFC", s).strip()  # noqa: E731


def rows(key: str) -> list[list[str]]:
    with (RAW / f"{key}.csv").open(encoding="utf-8-sig", newline="") as f:
        r = list(csv.reader(f))
    if r[0] != CONTRACT[key]:
        raise SystemExit(f"❌ {key} 表頭與契約不符：{r[0]}")
    return r[1:]


def main() -> int:
    map14 = {"cm": defaultdict(list), "pcs": defaultdict(list),
             "rev_cm": defaultdict(list), "rev_pcs": defaultdict(list)}
    zh14: dict[str, set] = defaultdict(set)
    stats = {}
    for kind in ("cm", "pcs"):
        body = rows(f"map14_{kind}")
        ident = 0
        nomap14 = 0
        for r in body:
            old, zh_old, new, zh_new = r[0].strip(), nfc(r[2]), r[3].strip(), nfc(r[5])
            s14, s23 = r[6].strip(), r[7].strip()
            # ★ 官方用 "NoDx"／空白表示「2014 碼刪除後無 2023 對應」，不是碼。
            #   第一版當成目標碼收進來，前端會出現連到不存在頁面的 NoDx 連結（gate 7 擋下）。
            if new in ("", "NoDx", "NoPCS"):
                map14[kind].setdefault(old, [])
                nomap14 += 1
                continue
            if old == new and not s14 and not s23:
                ident += 1
                if zh_old and zh_old != zh_new:
                    zh14[new].add(zh_old)          # 同碼改過中文名 → 舊譯名
                continue
            map14[kind][old].append([new, s14 or None, s23 or None])
            if old != new:
                map14[f"rev_{kind}"][new].append(old)
            if zh_old and zh_old != zh_new:
                zh14[new].add(zh_old)
        stats[f"map14_{kind}"] = {"rows": len(body), "identity_dropped": ident,
                                  "no_2023_target": nomap14, "kept_old_codes": len(map14[kind])}

    map9 = {"cm": defaultdict(list), "pcs": defaultdict(list), "names": {},
            "rev_cm": defaultdict(list), "rev_pcs": defaultdict(list)}
    zh9: dict[str, set] = defaultdict(set)
    for kind in ("cm", "pcs"):
        body = rows(f"map9_{kind}")
        deleted = nomap = 0
        for r in body:
            icd9, zh9name, new, flag, chg = r[0].strip(), nfc(r[2]), r[3].strip(), r[6].strip(), r[7].strip()
            if chg == "刪除對應":
                deleted += 1
                continue
            map9["names"][icd9] = [zh9name, nfc(r[1])]
            if new in ("", "NoDx", "NoPCS") or (len(flag) == 5 and flag[1] == "1"):   # GEM 第 2 碼 = no map
                nomap += 1
                continue
            map9[kind][icd9].append([new, flag or None])
            map9[f"rev_{kind}"][new].append(icd9)
            # 只有非 combination 的對應才把 ICD-9 名稱當入口詞：組合對應（第 3 碼=1）
            # 的 ICD-9 名稱只描述組合中的一部分，掛上去會讓搜尋命中錯的碼。
            if zh9name and not (len(flag) == 5 and flag[2] == "1"):
                zh9[new].add(zh9name)
        stats[f"map9_{kind}"] = {"rows": len(body), "deleted_excluded": deleted, "no_map": nomap,
                                 "icd9_codes": len(map9[kind])}

    STAGING.mkdir(parents=True, exist_ok=True)
    dump = lambda name, obj: (STAGING / name).write_text(  # noqa: E731
        json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    dump("map14.json", {k: dict(v) for k, v in map14.items()})
    dump("map9.json", {k: (dict(v) if isinstance(v, defaultdict) else v) for k, v in map9.items()})
    dump("oldnames.json", {"zh14": {k: sorted(v) for k, v in zh14.items()},
                           "zh9": {k: sorted(v) for k, v in zh9.items()}})
    dump("mappings_report.json", stats)
    for k, v in stats.items():
        print(f"  {k}: {v}")
    print(f"  舊譯名：2014 {len(zh14):,} 碼｜ICD-9 {len(zh9):,} 碼")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
