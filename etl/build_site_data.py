#!/usr/bin/env python3
"""staging → staging/site/（前端資料）。validate 驗過之後 promote 才整包換進 public/data。

★ 與 nhi-drug-rules 的差別：那邊 build_site_data 直接寫 public/data，閘門擋下時正式目錄
  其實已經被改了。這裡全部先寫 staging/site/，promote 用目錄整包替換。

檔案（路徑即前端 getJson 的 key）：
  meta.json                建置資訊、筆數、各來源版本、data_fingerprint
  derm.json                皮膚科子集：{rows, vocab}（首載）
  cm.json / vocab_cm.json  全 CM 與詞彙（切全庫時懶載）
  pcs.json / vocab_pcs.json
  tree.json                CM 章節樹（CDC Tabular + 中文章名）＋ PCS section
  mesh.json                MeSH descriptor 資訊（只收有連到 ICD 的）
  cat.json                 重大傷病：類別、碼 → [[類別, 說明序號]]、說明字串表
  nodes/<首字>.json         撰碼注意事項、7th 字元、MeSH、反查（舊碼、ICD-9）
  map14/{cm,pcs}/<首字>.json   2014 舊碼 → 新碼
  map9/{cm,pcs}/<首字>.json    ICD-9 → 新碼（含 ICD-9 名稱）
"""

from __future__ import annotations

import json
import shutil
import sys
from collections import defaultdict
from datetime import date
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))
from config import CURATION, RAW, STAGING  # noqa: E402
from lib.fingerprint import data_fingerprint  # noqa: E402

SITE = STAGING / "site"


def load(name: str):
    return json.loads((STAGING / name).read_text(encoding="utf-8"))


def write(rel: str, obj) -> None:
    p = SITE / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def shard_key(code: str) -> str:
    c = code[0].upper()
    return c if c.isalnum() else "_"


def in_ranges(code: str, ranges: list[list[str]]) -> bool:
    for lo, hi in ranges:
        # 前綴區間：code 的前 len(lo) 碼 ≥ lo 且前 len(hi) 碼 ≤ hi
        if code[:len(lo)] >= lo and code[:len(hi)] <= hi:
            return True
    return False


def main() -> int:
    if SITE.exists():
        shutil.rmtree(SITE)
    SITE.mkdir(parents=True)

    cm = load("codes_cm.json")["codes"]
    pcs = load("codes_pcs.json")["codes"]
    vcm, vpcs = load("vocab_cm.json"), load("vocab_pcs.json")
    nodes = load("nodes_cm.json")
    tree = load("tree_cm.json")
    mesh = load("mesh.json")
    cat = load("catastrophic.json")
    m14, m9 = load("map14.json"), load("map9.json")
    chapters = yaml.safe_load((CURATION / "chapters.yaml").read_text(encoding="utf-8"))
    derm = yaml.safe_load((CURATION / "derm_ranges.yaml").read_text(encoding="utf-8"))

    # 列：[code, zh, en, use, st, rev]（parent 由前端依前綴推，省空間）
    cm_rows = [r[:6] for r in cm]
    pcs_rows = [r[:6] for r in pcs]
    write("cm.json", {"rows": cm_rows})
    write("pcs.json", {"rows": pcs_rows})
    write("vocab_cm.json", vcm)
    write("vocab_pcs.json", vpcs)

    # 皮膚科子集：範圍內的碼 + 其所有祖先（麵包屑才接得起來）
    have = {r[0] for r in cm_rows}
    keep = {r[0] for r in cm_rows if in_ranges(r[0], derm["ranges"])}
    for c in list(keep):
        x = c
        while len(x) > 3:
            x = x[:-1].rstrip(".")
            if x in have:
                keep.add(x)
    write("derm.json", {"rows": [r for r in cm_rows if r[0] in keep],
                        "vocab": {"src": vcm["src"], "t": [t for t in vcm["t"] if t[1] in keep],
                                  "def": {h: c for h, c in (vcm.get("def") or {}).items() if h in keep and c in keep}}})

    tree["pcs"] = chapters["pcs"]
    write("tree.json", tree)
    write("mesh.json", mesh)

    # 重大傷病：說明字串去重成表，碼只存序號
    notes: list[str] = []
    nidx: dict[str, int] = {}
    codes = {}
    for code, entries in cat["codes"].items():
        out = []
        for e in entries:
            n = e["note"] or ""
            if n not in nidx:
                nidx[n] = len(notes)
                notes.append(n)
            out.append([e["cat"], nidx[n]])
        codes[code] = out
    write("cat.json", {"categories": cat["categories"], "notes": notes, "codes": codes,
                       "version": cat["report"]["version"], "file": cat["report"]["file"]})

    # 節點資訊＋反查，依首字分片
    shards: dict[str, dict] = defaultdict(dict)
    for code, info in nodes.items():
        shards[shard_key(code)][code] = dict(info)
    for kind in ("cm",):
        for new, olds in m14[f"rev_{kind}"].items():
            shards[shard_key(new)].setdefault(new, {})["m14"] = olds
        for new, icd9s in m9[f"rev_{kind}"].items():
            shards[shard_key(new)].setdefault(new, {})["m9"] = sorted(set(icd9s))
    for k, v in shards.items():
        write(f"nodes/{k}.json", v)

    for kind in ("cm", "pcs"):
        sh = defaultdict(dict)
        for old, targets in m14[kind].items():
            sh[shard_key(old)][old] = targets
        for k, v in sh.items():
            write(f"map14/{kind}/{k}.json", v)
        sh = defaultdict(dict)
        for icd9, targets in m9[kind].items():
            sh[shard_key(icd9)][icd9] = {"n": m9["names"].get(icd9), "t": targets}
        for k, v in sh.items():
            write(f"map9/{kind}/{k}.json", v)

    # 各來源版本（給頁尾出處與 DataFreshness）
    fm = json.loads((RAW / "fetch_manifest.json").read_text(encoding="utf-8"))
    vm_p = RAW / "vocab" / "manifest.json"
    vm = json.loads(vm_p.read_text(encoding="utf-8")) if vm_p.exists() else {}
    rep = load("vocab_report.json")
    meta = {
        "built": date.today().isoformat(),
        "counts": {"cm": len(cm_rows), "cm_billable": sum(1 for r in cm_rows if r[3] == 1),
                   "pcs": len(pcs_rows), "derm": len(keep),
                   "vocab_cm": len(vcm["t"]), "vocab_pcs": len(vpcs["t"]),
                   "catastrophic": len(codes)},
        "sources": {
            "nhi": {k: {"rows": v["rows"], "sha256": v["sha256"][:16]} for k, v in fm.items()},
            "cdc": "FY2023", "cms": "2023",
            "doid": (vm.get("doid") or {}).get("version"),
            "mesh": (vm.get("mesh") or {}).get("year"),
            "naer": "醫學名詞",
            "catastrophic": cat["report"]["version"],
        },
        "vocab_report": {k: rep.get(k) for k in ("cdc_index", "cdc_tabular", "doid", "mesh")},
    }
    meta["data_fingerprint"] = data_fingerprint(SITE)
    write("meta.json", meta)

    total = sum(p.stat().st_size for p in SITE.rglob("*.json"))
    n_files = sum(1 for _ in SITE.rglob("*.json"))
    print(f"  site/: {n_files} 檔、{total/1e6:.1f} MB｜皮膚科子集 {len(keep):,} 碼"
          f"｜指紋 {meta['data_fingerprint']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
