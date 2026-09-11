#!/usr/bin/env python3
"""下載詞彙層上游到 data/raw/vocab/。

用法：
    python3 etl/fetch_vocab.py                     全部
    python3 etl/fetch_vocab.py --only cdc,doid     指定來源
    python3 etl/fetch_vocab.py --check             只印版本資訊（每週排程判斷要不要重建）

來源與更新頻率：
    cdc   CDC FY2023 ICD-10-CM Index/Tabular/Neoplasm XML   靜態（台灣固定 2023 版）
    cms   CMS 2023 ICD-10-PCS Index/Definitions XML           靜態
    doid  Disease Ontology doid.obo（CC0）                    每月
    mesh  NLM MeSH desc{YEAR}.gz                              每年一月
    naer  國家教育研究院 醫學名詞 zip（政府開放授權）         每年
    wd    Wikidata ICD-10-CM/ICD-10 項目的中英文標籤與別名（CC0） 每週

★ 產物（data/raw/vocab/）不進 git；build_vocab.py 產出的精簡 JSON 進 curation/derived/，
  連同來源 sha。這樣 CI 每週只需要比對版本，不必每次都重抓 CDC（伺服器很慢）。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import urllib.parse
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from config import (CDC_MEMBERS, CDC_ZIP, CMS_MEMBERS, CMS_PCS_ZIP, DOID_OBO, MESH_DESC,  # noqa: E402
                    NAER_MED_ZIP, RAW, WIKIDATA_SPARQL)
from lib.http import content_length, fetch, probe, zip_members  # noqa: E402

OUT = RAW / "vocab"
OUT.mkdir(parents=True, exist_ok=True)


def _save(name: str, data: bytes) -> dict:
    p = OUT / name
    tmp = p.with_suffix(p.suffix + ".part")
    tmp.write_bytes(data)
    tmp.replace(p)
    return {"file": name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}


def mesh_year() -> int:
    """NLM 每年約年底預先發布下一年度檔；還沒出時退回前一年。

    ★ 未發布的年度會 302 到 200 + text/html 的 soft-404（16 KB），
      所以「存在」= 200 且不是 HTML 且大於 1 MB（真檔約 16.8 MB）。"""
    y = date.today().year + 1
    for yy in (y, y - 1, y - 2):
        status, ctype, size = probe(MESH_DESC.format(year=yy))
        if status == 200 and "html" not in ctype.lower() and size > 1_000_000:
            return yy
    raise RuntimeError("找不到任何年度的 MeSH desc 檔")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="cdc,cms,doid,mesh,naer,wd")
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()
    want = set(args.only.split(","))
    man_p = OUT / "manifest.json"
    man = json.loads(man_p.read_text(encoding="utf-8")) if man_p.exists() else {}

    if args.check:
        info = {"mesh_year": mesh_year(),
                "doid_bytes": content_length(DOID_OBO),
                "naer_bytes": content_length(NAER_MED_ZIP)}
        print(json.dumps(info))
        return 0

    if "cdc" in want:
        got = zip_members(CDC_ZIP, CDC_MEMBERS)
        man["cdc"] = {"url": CDC_ZIP, "members": {n: _save(n, b) for n, b in got.items()}}
        print(f"  cdc   {', '.join(f'{n} {len(b)/1e6:.1f}MB' for n, b in got.items())}")
    if "cms" in want:
        got = zip_members(CMS_PCS_ZIP, CMS_MEMBERS)
        man["cms"] = {"url": CMS_PCS_ZIP, "members": {n: _save(n, b) for n, b in got.items()}}
        print(f"  cms   {', '.join(f'{n} {len(b)/1e6:.1f}MB' for n, b in got.items())}")
    if "doid" in want:
        b = fetch(DOID_OBO)
        ver = re.search(rb"^data-version: (\S+)", b, re.M)
        man["doid"] = {"url": DOID_OBO, "version": ver.group(1).decode() if ver else None,
                       **_save("doid.obo", b)}
        print(f"  doid  {len(b)/1e6:.1f}MB  version {man['doid']['version']}")
    if "mesh" in want:
        y = mesh_year()
        url = MESH_DESC.format(year=y)
        b = fetch(url, timeout=1800)
        man["mesh"] = {"url": url, "year": y, **_save(f"desc{y}.gz", b)}
        print(f"  mesh  desc{y}.gz {len(b)/1e6:.1f}MB")
    if "naer" in want:
        b = fetch(NAER_MED_ZIP)
        man["naer"] = {"url": NAER_MED_ZIP, **_save("naer_med.zip", b)}
        print(f"  naer  {len(b)/1e6:.1f}MB")
    if "wd" in want:
        rows = []
        for prop in ("P4229", "P494"):          # ICD-10-CM、WHO ICD-10
            for kind, pred in (("label", "rdfs:label"), ("alias", "skos:altLabel")):
                q = (f'SELECT ?i ?c ?l (LANG(?l) AS ?lang) WHERE {{ ?i wdt:{prop} ?c . ?i {pred} ?l . '
                     'FILTER(LANG(?l) IN ("zh-tw","zh-hant","zh-hk","zh","en")) }')
                url = WIKIDATA_SPARQL + "?format=json&query=" + urllib.parse.quote(q)
                res = json.loads(fetch(url, timeout=300))
                for b_ in res["results"]["bindings"]:
                    rows.append([prop, kind, b_["i"]["value"].rsplit("/", 1)[-1], b_["c"]["value"],
                                 b_["l"]["value"], b_["lang"]["value"]])
                print(f"  wd    {prop} {kind}: {len(res['results']['bindings']):,}")
        data = json.dumps(rows, ensure_ascii=False).encode()
        man["wd"] = {"url": WIKIDATA_SPARQL, "rows": len(rows), "fetched": date.today().isoformat(),
                     **_save("wikidata.json", data)}

    man_p.write_text(json.dumps(man, ensure_ascii=False, indent=1), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
