#!/usr/bin/env python3
"""fail-closed 驗證閘門。全部跑完再一次報告，然後才決定要不要 promote。

用法：
    python3 etl/validate.py [--override 2,9]

沿用 nhi-drug-rules：不在第一個失敗就停（要一次看完全部問題），warn 一律實作成 fail，
人工看過後用 --override 放行並留痕在 last_run.json。
"""

from __future__ import annotations

import argparse
import gzip
import json
import re
import sys
from dataclasses import asdict, dataclass
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))
from config import CONTRACT, CURATION, RAW, RE_CM, RE_PCS, SNAPSHOTS, STAGING  # noqa: E402
from lib.fingerprint import data_fingerprint  # noqa: E402

SITE = STAGING / "site"
PREV = SNAPSHOTS / "last_run.json"
# 台灣版特有、官方本來就沒有上層節點的碼（U00 類目不存在於檔內）
ORPHAN_ALLOW = re.compile(r"^U00\.")


@dataclass
class Gate:
    id: int
    name: str
    passed: bool
    message: str
    overridden: bool = False


def J(p: Path):
    return json.loads(p.read_text(encoding="utf-8"))


def run() -> list[Gate]:
    g: list[Gate] = []
    prev = J(PREV) if PREV.exists() else {}
    man = J(RAW / "fetch_manifest.json")
    ccm, cpcs = J(STAGING / "codes_cm.json"), J(STAGING / "codes_pcs.json")
    cm_codes = {r[0] for r in ccm["codes"]}
    pcs_codes = {r[0] for r in cpcs["codes"]}
    vrep = J(STAGING / "vocab_report.json")

    # 1 欄位契約（strict UTF-8 已在 fetch_csv 擋過，這裡比表頭）
    bad = [k for k, v in man.items() if v["header"] != CONTRACT[k]]
    g.append(Gate(1, "CSV 表頭契約", not bad, f"不符：{bad}" if bad else f"{len(man)} 檔全符合"))

    # 2 筆數健檢：與上期 ±2%，且有絕對下限（首次執行沒有上期）
    prev_rows = prev.get("rows", {})
    drift = []
    for k, v in man.items():
        p0 = prev_rows.get(k)
        if p0 and not (0.98 * p0 <= v["rows"] <= 1.02 * p0):
            drift.append(f"{k} {p0}→{v['rows']}")
    floor_ok = man["cm"]["rows"] >= 90_000 and man["pcs"]["rows"] >= 75_000
    g.append(Gate(2, "筆數健檢", not drift and floor_ok,
                  f"CM {man['cm']['rows']:,}／PCS {man['pcs']['rows']:,}" + (f"｜漂移 {drift}" if drift else "")))

    # 3 代碼格式與唯一性
    r3 = [ccm["report"], cpcs["report"]]
    bad3 = sum(r["n_bad_format"] + r["n_dups"] for r in r3)
    fmt_cm = sum(1 for c in cm_codes if not re.match(RE_CM, c))
    fmt_pcs = sum(1 for c in pcs_codes if not re.match(RE_PCS, c))
    g.append(Gate(3, "代碼格式與唯一性", bad3 == 0 and fmt_cm == 0 and fmt_pcs == 0,
                  f"格式錯/重複 {bad3}｜CM 格式 {fmt_cm}｜PCS 格式 {fmt_pcs}"))

    # 4 階層封閉 + 章節涵蓋
    orphans = [c for c in ccm["report"]["orphans"] if not ORPHAN_ALLOW.match(c)]
    tree = J(STAGING / "tree_cm.json")
    uncovered = sorted({c[:3] for c in cm_codes
                        if not any(ch["first"] <= c[:3] <= ch["last"] for ch in tree["chapters"])})
    mism = vrep.get("chapter_range_mismatch", [])
    g.append(Gate(4, "階層封閉／章節涵蓋", not orphans and not uncovered and not mism,
                  f"孤兒 {orphans[:5]}｜未涵蓋類目 {uncovered[:5]}｜章節範圍不符 {mism}"))

    # 5 CJK 相容字
    ca = ccm["report"]["compat_after"] + cpcs["report"]["compat_after"]
    g.append(Gate(5, "CJK 相容字已正規化", ca == 0, f"殘留 {ca}（正規化前 {ccm['report']['compat_before']}）"))

    # 6 金絲雀碼
    can = yaml.safe_load((CURATION / "canaries.yaml").read_text(encoding="utf-8"))["cm"]
    names = {r[0]: r for r in ccm["codes"]}
    miss6 = [f"{c}:{want}" for c, want in can.items() if c not in names or want not in names[c][1]]
    g.append(Gate(6, "金絲雀碼", not miss6, f"{len(can) - len(miss6)}/{len(can)}" + (f" 缺 {miss6}" if miss6 else "")))

    # 7 對應檔完整性：2023 目標碼都存在
    m14, m9 = J(STAGING / "map14.json"), J(STAGING / "map9.json")
    bad7 = []
    for kind, valid in (("cm", cm_codes), ("pcs", pcs_codes)):
        bad7 += [t[0] for v in m14[kind].values() for t in v if t[0] not in valid][:5]
        bad7 += [t[0] for v in m9[kind].values() for t in v if t[0] not in valid][:5]
    g.append(Gate(7, "對應檔目標碼存在", not bad7, f"不存在 {bad7[:10]}" if bad7 else "全部存在"))

    # 8 重大傷病
    cat = J(STAGING / "catastrophic.json")["report"]
    ok8 = cat["n_missing"] == 0 and not cat["categories_unnamed"] and cat["sha256"] == cat["sha_expected"]
    g.append(Gate(8, "重大傷病對照表", ok8,
                  f"{cat['codes']:,} 碼｜主檔查無 {cat['n_missing']}｜未命名類別 {cat['categories_unnamed']}"
                  f"｜sha {'✓' if cat['sha256'] == cat['sha_expected'] else '✗ 與 catastrophic.yaml 不符'}"))

    # 9 皮膚科常用碼清單（首載）：碼存在、可申報、不重複、檔案夠小
    dc_path = SITE / "derm_common.json"
    dc = J(dc_path)
    gz = len(gzip.compress(dc_path.read_bytes())) // 1024
    dc_codes = [r[0] for grp in dc["groups"] for r in grp["codes"]]
    not_bill = [r[0] for grp in dc["groups"] for r in grp["codes"] if r[3] != 1]
    dups = sorted({c for c in dc_codes if dc_codes.count(c) > 1})
    ok9 = not dc["missing"] and not not_bill and not dups and gz < 50 and len(dc_codes) >= 30
    g.append(Gate(9, "皮膚科常用碼清單", ok9,
                  f"{len(dc_codes)} 碼／{len(dc['groups'])} 類｜gzip {gz} KB（上限 50）"
                  + (f"｜查無 {dc['missing']}" if dc["missing"] else "")
                  + (f"｜不可申報 {not_bill}" if not_bill else "")
                  + (f"｜重複 {dups}" if dups else "")))

    # 10 詞彙目標碼有效（ICD-9 不可能混進主索引：主索引的碼必須全是 2023 CM）
    vcm, vpcs = J(STAGING / "vocab_cm.json"), J(STAGING / "vocab_pcs.json")
    pcs_pref = {c[:k] for c in pcs_codes for k in (3, 4)} | pcs_codes
    bad10 = [t[1] for t in vcm["t"] if t[1] not in cm_codes][:5] + [t[1] for t in vpcs["t"] if t[1] not in pcs_pref][:5]
    g.append(Gate(10, "入口詞目標碼有效（無 ICD-9 混入）", not bad10, f"無效 {bad10}" if bad10 else
                  f"CM {len(vcm['t']):,}／PCS {len(vpcs['t']):,} 條"))

    # 11 詞彙量健檢：上游（Wikidata/MeSH/CDC）抓失敗時詞彙會突然變少，搜尋品質無聲退化
    p11 = prev.get("vocab_cm")
    n11 = len(vcm["t"])
    ok11 = n11 >= 150_000 and (not p11 or n11 >= 0.9 * p11)
    g.append(Gate(11, "詞彙量健檢", ok11, f"{n11:,}（上期 {p11}）｜各來源 {vrep.get('by_source')}"))

    # 12 預設碼：CDC 主詞（完整碼）幾乎都該可申報。
    # ★ 例外：需要第 7 碼的類目（傷害、中毒等，T14.8／S00.512）—— CDC 字母索引本來就
    #   不寫第 7 碼（A 初次／D 後續／S 後遺症），由撰碼者補上。這不是資料錯。
    use = {r[0]: r[3] for r in ccm["codes"]}
    nodes = J(STAGING / "nodes_cm.json")
    x7_roots = {c for c, n in nodes.items() if n.get("x7")}
    needs7 = lambda c: any(c.startswith(r) for r in x7_roots if r[:3] == c[:3])  # noqa: E731
    src_i = vcm["src"].index("cdc-idx")
    mains = [t for t in vcm["t"] if t[2] == src_i and not (t[3] & 1) and "," not in t[0]]
    nb = [t[1] for t in mains if use.get(t[1]) != 1 and not needs7(t[1])]
    rate = 1 - len(nb) / max(1, len(mains))
    g.append(Gate(12, "預設碼可申報", rate >= 0.97,
                  f"{rate:.1%}（{len(mains):,} 個主詞；非可申報且非第 7 碼類目 {len(nb)}：{nb[:5]}）"))

    # 13 出處標示：MeSH 年度、DOID 版本必須寫進 meta（About 頁與頁尾依此顯名）
    meta = J(SITE / "meta.json")
    src = meta.get("sources", {})
    miss13 = [k for k in ("nhi", "cdc", "cms", "mesh", "doid", "catastrophic") if not src.get(k)]
    g.append(Gate(13, "出處與版本標示", not miss13, f"缺 {miss13}" if miss13 else "齊全"))

    # 14 分片檔名乾淨（ASCII，離線包與 URL 都安全）
    badname = [p.relative_to(SITE).as_posix() for p in SITE.rglob("*.json")
               if not re.fullmatch(r"[A-Za-z0-9_./-]+", p.relative_to(SITE).as_posix())]
    g.append(Gate(14, "檔名乾淨", not badname, f"{badname[:5]}" if badname else "全部 ASCII"))

    # 16 官方中文名亂碼：目前已知 8 個（「瘻」掉成「?」）。新版若變多 = 官方換檔又壞了一批
    qm = vrep.get("zh_question_marks", [])
    known = set(yaml.safe_load((CURATION / "canaries.yaml").read_text(encoding="utf-8")).get("known_garbled", []))
    new_bad = [c for c in qm if c not in known]
    g.append(Gate(16, "官方中文名亂碼", not new_bad,
                  f"已知 {len(known)}、本次 {len(qm)}" + (f"｜新增 {new_bad[:10]}" if new_bad else "")))

    # 15 指紋一致：meta 記的指紋 = site 實際內容
    fp = data_fingerprint(SITE)
    g.append(Gate(15, "資料指紋", fp == meta.get("data_fingerprint"), f"{fp} vs meta {meta.get('data_fingerprint')}"))
    return g


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--override", default="")
    args = ap.parse_args()
    over = {int(x) for x in args.override.split(",") if x.strip()}
    gates = run()
    for x in gates:
        if not x.passed and x.id in over:
            x.overridden = True
    for x in gates:
        mark = "✅" if x.passed else ("⚠️ 放行" if x.overridden else "❌")
        print(f"  {mark} [{x.id:>2}] {x.name}：{x.message}")
    (STAGING / "validation_report.json").write_text(
        json.dumps([asdict(x) for x in gates], ensure_ascii=False, indent=1), encoding="utf-8")
    failed = [x for x in gates if not x.passed and not x.overridden]
    if failed:
        print(f"❌ {len(failed)} 個閘門未過，不 promote")
        return 1
    print("✅ 閘門全綠")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
