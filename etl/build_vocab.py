#!/usr/bin/env python3
"""詞彙層（MeSH 式）：把所有來源整理成「入口詞 → ICD 節點」＋節點資訊。

輸入：staging/codes_{cm,pcs}.json、staging/map9.json、staging/oldnames.json、
      data/raw/vocab/*（CDC/CMS/DOID/MeSH/國教院）、curation/{chapters,synonyms_zh,abbrev}.yaml
輸出（staging/）：
  vocab_cm.json   {"src": [...來源名...], "t": [[文字, 代碼, 來源序號, 旗標], ...]}
                  旗標：1 = 不完整碼（CDC 以 "-" 結尾，需選到下層）
  vocab_pcs.json  同上，代碼為 PCS 表前綴（3–4 碼）或完整碼
  nodes_cm.json   {code: {"n": {excl1,excl2,codeFirst,useAdd,codeAlso,incl,includes},
                          "x7": {字元: 意義}, "mesh": [ui...], "rel": [seeAlso 文字]}}
  tree_cm.json    {"chapters": [{n, zh, en, first, last, sections: [[id, en, first, last]]}]}
  mesh.json       {ui: [name, [tree...], scope]}
  vocab_report.json
  ../../tests/bench/data/heldout.json   基準測試的保留集（見 HELDOUT）

★ 只做確定性轉換，不生成任何新詞。每筆入口詞帶來源；目標碼不在台灣 2023 版就丟（記數）。
★ 入口詞文字保留原樣，正規化交給 src/lib/search/normalize.js —— 搜尋只有一份實作，
  Python 這邊只做去重（NFKC+casefold+空白）。
"""

from __future__ import annotations

import gzip
import hashlib
import io
import json
import re
import sys
import unicodedata
import zipfile
from collections import defaultdict
from pathlib import Path
from xml.etree import ElementTree as ET

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))
from config import CURATION, RAW, ROOT, STAGING  # noqa: E402

V = RAW / "vocab"
BENCH = ROOT / "tests" / "bench" / "data"
BENCH.mkdir(parents=True, exist_ok=True)

# ── 來源（順序即序號，前端靠序號查權重與標籤）──
SRC = ["title",       # 0 官方英文名（前端另外從 codes 讀，這裡不重複輸出）
       "cdc-idx",     # 1 CDC Index 路徑
       "cdc-see",     # 2 CDC Index see 交叉參照（解析後）
       "cdc-incl",    # 3 Tabular inclusion term
       "cdc-neo",     # 4 Neoplasm Table
       "doid",        # 5 Disease Ontology 名稱／exact synonym
       "doid-rel",    # 6 DOID related/broad/narrow synonym
       "mesh",        # 7 MeSH entry term
       "zh14",        # 8 2014 版舊中文名
       "zh9",         # 9 ICD-9 中文名（掛在目標碼的共同祖先）
       "naer",        # 10 國教院醫學名詞中文譯名
       "cur-zh",      # 11 人工策展俗稱（已核可）
       "cur-abbr",    # 12 人工策展縮寫（已核可）
       "cms-idx",     # 13 CMS PCS Index
       "en9",         # 14 ICD-9 英文名（同 zh9 規則）
       "wd",          # 15 Wikidata 標籤（有 ICD-10-CM ID 的項目）
       "wd-alias",    # 16 Wikidata 別名，或只有 WHO ICD-10 ID 的項目
       "fix-zh"]      # 17 官方中文名亂碼修復（見 repair_zh）
S = {n: i for i, n in enumerate(SRC)}

# 縮寫 → 全名（abbrev.yaml 的 expand），前端在多字查詢時展開（v12）
ABBR: dict[str, str] = {}

# 保留集：用 (來源, 文字, 代碼) 的雜湊決定，固定、可重現、跨次建置穩定。
HELDOUT = {"cdc-idx": 5, "cdc-see": 5, "zh14": 5, "zh9": 5}   # 1/5 = 20%


def key(s: str) -> str:
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", s)).strip().casefold()


def heldout(src: str, text: str, code: str) -> bool:
    m = HELDOUT.get(src)
    if not m:
        return False
    h = hashlib.sha1(f"{src}|{key(text)}|{code}".encode()).digest()
    return h[0] % m == 0


class Vocab:
    def __init__(self, valid: set[str]):
        self.valid = valid
        self.nodot = {c.replace(".", ""): c for c in valid}
        self.rows: dict[tuple, list] = {}
        self.dropped = defaultdict(int)
        self.heldout: list[dict] = []

    def resolve(self, code: str) -> tuple[str | None, int]:
        c = code.strip().upper()
        inc = 1 if c.endswith("-") else 0
        c = c.rstrip("-").rstrip(".")
        if c in self.valid:
            return c, inc
        if c.replace(".", "") in self.nodot:
            return self.nodot[c.replace(".", "")], inc
        return None, inc

    def add(self, text: str, code: str, src: str, *, raw_code: bool = False) -> None:
        text = re.sub(r"\s+", " ", unicodedata.normalize("NFC", text)).strip(" ,;")
        if not text or len(text) > 200:
            return
        if raw_code:
            c, inc = code, 0
        else:
            c, inc = self.resolve(code)
        if not c:
            self.dropped[src] += 1
            return
        # ★ 保留集不從詞彙表移除（那樣正式站會少 20% 入口詞），只標旗標 2；
        #   基準測試建索引時才排除旗標 2 的列，用它們當查詢題目。
        h = 2 if heldout(src, text, c) else 0
        if h:
            self.heldout.append({"q": text, "code": c, "src": src})
        k = (key(text), c)
        if k in self.rows:                       # 同文字同碼：保留權重較高（序號較小）的來源
            row = self.rows[k]
            if S[src] < row[2]:
                row[2] = S[src]
            if not h:
                row[3] &= ~2                     # 任一非保留來源也有這筆 → 不算保留
            return
        self.rows[k] = [text, c, S[src], inc | h]

    def dump(self) -> dict:
        return {"src": SRC, "t": list(self.rows.values())}


# ── CDC Index ────────────────────────────────────────────────────────
def title_text(el) -> tuple[str, str]:
    """(主文字, nemod 文字)。nemod = 括號內的非必要修飾語，當作可有可無的詞。"""
    t = el.find("title")
    if t is None:
        return "", ""
    main = (t.text or "") + "".join((c.tail or "") for c in t)
    nemod = " ".join("".join(n.itertext()) for n in t.findall("nemod"))
    return main.strip(), nemod.strip(" ()")


def neo_table() -> dict[str, dict[str, str]]:
    """Neoplasm Table：key(", ".join(部位路徑)) → {欄位號: 碼}（給 see Neoplasm 解析用）。"""
    root = ET.parse(V / "icd10cm-neoplasm-2023.xml").getroot()
    out: dict[str, dict[str, str]] = {}

    def walk(el, path: list[str]) -> None:
        main, _ = title_text(el)
        p = path + [main] if main else path
        cells = {c.get("col"): (c.text or "").strip() for c in el.findall("cell")
                 if (c.text or "").strip() not in ("", "-")}
        site = [x for x in p if not x.lower().startswith("neoplasm")]
        if cells and site:
            out[key(", ".join(site))] = cells
        for t in el.findall("term"):
            walk(t, p)

    for mt in root.iter("mainTerm"):
        walk(mt, [])
    return out


NEO_WORD = {"malignant": "2", "secondary": "3", "in situ": "4", "benign": "5",
            "uncertain": "6", "unspecified": "7"}


def cdc_index(v: Vocab, rep: dict) -> None:
    root = ET.parse(V / "icd10cm-index-2023.xml").getroot()
    # ★ 路徑 key 用 ", " 串接後整串比對，不拆逗號：CDC 主詞本身就有逗號
    #   （"Wound, open"、"Abnormal, abnormality, abnormalities"），see 目標
    #   "Wound, open, cheek" 若按逗號拆會把主詞切斷 —— 第一版因此 55% 的 see 解析失敗。
    #   同一主詞的變體（"Abnormal, abnormality, abnormalities"）另外登記第一個詞當別名。
    node_code: dict[str, str] = {}             # 路徑 key → 該節點自己的碼
    node_desc: dict[str, set] = defaultdict(set)   # 路徑 key → 子孫所有碼（無碼節點用）
    sees: list[tuple[list[str], str]] = []
    n_paths = 0

    def pkeys(p: list[str]) -> list[str]:
        ks = [key(", ".join(p))]
        head = p[0].split(",")[0]
        if head != p[0]:
            ks.append(key(", ".join([head, *p[1:]])))
        return ks

    def walk(el, path: list[str]) -> set:
        nonlocal n_paths
        main, nemod = title_text(el)
        p = path + [main] if main else path
        code = el.findtext("code")
        here: set = set()
        if code:
            n_paths += 1
            # MeSH 式倒裝（"Dermatitis, atopic"）與自然語序（"atopic dermatitis"）都收；
            # 更深的層級前端以「詞集合」比對，語序不影響。
            v.add(", ".join(p), code, "cdc-idx")
            if len(p) == 2:
                v.add(f"{p[1]} {p[0]}", code, "cdc-idx")
            # ★ 主詞帶變形清單（"Stenosis, stenotic"、"Tuberculosis, tubercular, tuberculous"）時，
            #   另收「只用主詞第一個字」的版本。否則詞集合多了 stenotic，永遠對不到使用者打的
            #   "aortic stenosis"，I35.0 輸給 DOID 對到的風濕性／先天性碼（diverse 題組 v10 實測）。
            head = p[0].split(",")[0].strip() if p else ""
            if head and head != p[0]:
                hp = [head, *p[1:]]
                v.add(", ".join(hp), code, "cdc-idx")
                if len(hp) == 2:
                    v.add(f"{hp[1]} {hp[0]}", code, "cdc-idx")
            if nemod and len(p) <= 2:
                v.add(" ".join([nemod, *reversed(p)]) if len(p) == 2 else f"{nemod} {p[0]}", code, "cdc-idx")
            c, _ = v.resolve(code)
            if c:
                here.add(c)
                for k in pkeys(p):
                    node_code.setdefault(k, code)
        see = el.find("see")
        if see is not None and see.text:
            sees.append((p, see.text.strip()))
        rep["seeAlso"] += len([sa for sa in el.findall("seeAlso") if sa.text])
        for t in el.findall("term"):
            here |= walk(t, p)
        for k in pkeys(p):
            node_desc[k] |= here
        return here

    rep["seeAlso"] = 0
    for mt in root.iter("mainTerm"):
        walk(mt, [])
    neo = neo_table()

    # see 解析："Shingles → see Herpes, zoster"：在 index 裡找到目標節點的碼，
    # 再把「來源詞」掛上去。目標節點本身無碼時掛到子孫碼的共同祖先（旗標：不完整）。
    ok = anc = neo_ok = skip = miss = 0
    for p, target in sees:
        t = re.sub(r"\s*-\s*see also.*$", "", target).strip()
        tl = t.lower()
        if tl.startswith("condition") or "by site" in tl or "by type" in tl:
            skip += 1                           # 泛指性參照，沒有特定碼
            continue
        code, via = None, None
        if tl.startswith("neoplasm"):
            parts = [x.strip() for x in t.split(",")[1:]]
            col = next((NEO_WORD[w] for w in NEO_WORD if parts and parts[-1].lower().startswith(w)), None)
            site = key(", ".join(parts[:-1] if col else parts))
            cells = neo.get(site, {})
            code = cells.get(col or "2")
            via = "neo" if code else None
        if not code:
            segs = t.split(", ")
            # 找不到就「只退一層」（"Herpes, zoster, eye" → "Herpes, zoster"），而且至少保留主詞＋一層：
            # 一路退到只剩主詞會對到非常籠統的碼（bee sting 曾因此掛到 D55.0）。
            for cut in [c for c in (len(segs), len(segs) - 1) if c >= 1 and not (c == 1 and len(segs) > 1)]:
                k = key(", ".join(segs[:cut]))
                if k in node_code:
                    code, via = node_code[k], "node"
                    break
                if node_desc.get(k):
                    code, via = lca(sorted(node_desc[k]), v.valid), "anc"
                    break
        if not code:
            miss += 1
            continue
        ok += via == "node"
        anc += via == "anc"
        neo_ok += via == "neo"
        v.add(", ".join(p), code, "cdc-see")
        if len(p) == 2:
            v.add(f"{p[1]} {p[0]}", code, "cdc-see")
    rep["cdc_index"] = {"paths_with_code": n_paths, "see_node": ok, "see_ancestor": anc,
                        "see_neoplasm": neo_ok, "see_generic_skipped": skip, "see_unresolved": miss}


# ── CDC Tabular：inclusion terms、撰碼注意、7th 字元、章節 ─────────────
NOTE_TAGS = {"excludes1": "excl1", "excludes2": "excl2", "codeFirst": "codeFirst",
             "useAdditionalCode": "useAdd", "codeAlso": "codeAlso", "inclusionTerm": "incl",
             "includes": "includes"}


def cdc_tabular(v: Vocab, nodes: dict, rep: dict, chapters_yaml: dict) -> dict:
    root = ET.parse(V / "icd10cm-tabular-2023.xml").getroot()
    zh = {c["n"]: c for c in chapters_yaml["cm"]}
    tree = {"chapters": []}
    n_incl = 0
    for ch in root.findall("chapter"):
        n = int(ch.findtext("name"))
        desc = (ch.findtext("desc") or "").strip()
        secs = [[s.get("id"), " ".join((s.text or "").split()), s.get("first"), s.get("last")]
                for s in ch.find("sectionIndex").findall("sectionRef")]
        rng = re.search(r"\(([A-Z0-9]{3})-([A-Z0-9]{3})\)", desc)
        first, last = (rng.group(1), rng.group(2)) if rng else (secs[0][2], secs[-1][3])
        y = zh.get(n, {})
        if y and list(y["range"]) != [first, last]:
            rep.setdefault("chapter_range_mismatch", []).append([n, y["range"], [first, last]])
        tree["chapters"].append({"n": n, "zh": y.get("zh"), "en": re.sub(r"\s*\([^)]*\)$", "", desc),
                                 "first": first, "last": last, "sections": secs})

        for d in ch.iter("diag"):
            code = d.findtext("name")
            c, _ = v.resolve(code or "")
            if not c:
                continue
            info = {}
            for tag, short in NOTE_TAGS.items():
                notes = [" ".join((nt.text or "").split()) for x in d.findall(tag) for nt in x.findall("note")]
                if notes:
                    info[short] = notes
            for note in info.get("incl", []):
                v.add(note, c, "cdc-incl")
                n_incl += 1
            x7 = d.find("sevenChrDef")
            if x7 is not None:
                info["x7"] = {e.get("char"): " ".join((e.text or "").split()) for e in x7.findall("extension")}
            if info:
                nodes[c] = {**nodes.get(c, {}), "n": {k: v_ for k, v_ in info.items() if k != "x7"}}
                if "x7" in info:
                    nodes[c]["x7"] = info["x7"]
    rep["cdc_tabular"] = {"inclusion_terms": n_incl, "nodes_with_notes": len(nodes)}
    return tree


# ── Neoplasm Table ──────────────────────────────────────────────────
NEO_COL = {"2": "malignant primary", "3": "malignant secondary metastatic", "4": "carcinoma in situ",
           "5": "benign", "6": "uncertain behavior", "7": "unspecified behavior"}


def cdc_neoplasm(v: Vocab, rep: dict) -> None:
    root = ET.parse(V / "icd10cm-neoplasm-2023.xml").getroot()
    n = 0

    def walk(el, path: list[str]) -> None:
        nonlocal n
        main, _ = title_text(el)
        p = path + [main] if main else path
        site = [x for x in p if not x.lower().startswith("neoplasm")]
        for cell in el.findall("cell"):
            col, code = cell.get("col"), (cell.text or "").strip()
            if col in NEO_COL and code and code != "-" and site:
                v.add(f"neoplasm {' '.join(site)} {NEO_COL[col]}", code, "cdc-neo")
                n += 1
        for t in el.findall("term"):
            walk(t, p)

    for mt in root.iter("mainTerm"):
        walk(mt, [])
    rep["cdc_neoplasm"] = n


# ── DOID + MeSH ─────────────────────────────────────────────────────
def doid_mesh(v: Vocab, nodes: dict, rep: dict) -> dict:
    text = (V / "doid.obo").read_text(encoding="utf-8")
    want_mesh: dict[str, set] = defaultdict(set)      # MeSH UI → ICD 節點
    n_terms = n_syn = 0
    for block in text.split("\n[Term]\n")[1:]:
        if "is_obsolete: true" in block:
            continue
        icds = []
        for x in re.findall(r"^xref: ICD10CM:(\S+)", block, re.M):
            c, _ = v.resolve(x)
            if c:
                icds.append(c)
        if not icds:
            continue
        n_terms += 1
        name = re.search(r"^name: (.+)$", block, re.M)
        syns = re.findall(r'^synonym: "(.+?)" (EXACT|RELATED|BROAD|NARROW)', block, re.M)
        mesh = re.findall(r"^xref: MESH:(D\d+)", block, re.M)
        for c in icds:
            if name:
                v.add(name.group(1), c, "doid")
            for s, kind in syns:
                # BROAD/NARROW 的語意範圍與 ICD 節點不同，只收 EXACT 與 RELATED
                if kind in ("EXACT", "RELATED"):
                    v.add(s, c, "doid" if kind == "EXACT" else "doid-rel")
                    n_syn += 1
            for m in mesh:
                want_mesh[m].add(c)
    rep["doid"] = {"terms_with_icd": n_terms, "synonyms": n_syn, "mesh_links": len(want_mesh)}

    mesh_info: dict[str, list] = {}
    mp = next(V.glob("desc*.gz"))
    n_entry = 0
    with gzip.open(mp, "rb") as f:
        for _ev, el in ET.iterparse(f, events=("end",)):
            if el.tag != "DescriptorRecord":
                continue
            ui = el.findtext("DescriptorUI")
            if ui in want_mesh:
                name = el.findtext("DescriptorName/String")
                trees = [t.text for t in el.findall("TreeNumberList/TreeNumber")]
                scope = None
                for con in el.findall("ConceptList/Concept"):
                    if con.get("PreferredConceptYN") == "Y":
                        scope = " ".join((con.findtext("ScopeNote") or "").split()) or None
                terms = {t.text for t in el.findall("ConceptList/Concept/TermList/Term/String")}
                mesh_info[ui] = [name, trees, scope]
                for c in want_mesh[ui]:
                    for t in terms:
                        v.add(t, c, "mesh")
                        n_entry += 1
                    nodes.setdefault(c, {}).setdefault("mesh", []).append(ui)
            el.clear()
    rep["mesh"] = {"file": mp.name, "descriptors": len(mesh_info), "entry_terms": n_entry}
    return mesh_info


# ── 中文來源：舊譯名、ICD-9、國教院 ────────────────────────────────────
def lca(codes: list[str], valid: set[str]) -> str | None:
    """目標碼的最近共同祖先（以前綴計，且必須是存在的節點、至少到 3 碼類目）。"""
    if not codes:
        return None
    pre = codes[0]
    for c in codes[1:]:
        i = 0
        while i < min(len(pre), len(c)) and pre[i] == c[i]:
            i += 1
        pre = pre[:i]
    pre = pre.rstrip(".")
    while len(pre) >= 3 and pre not in valid:
        pre = pre[:-1].rstrip(".")
    return pre if len(pre) >= 3 else None


def chinese(vcm: Vocab, vpcs: Vocab, rep: dict, cm_rows: list) -> None:
    old = json.loads((STAGING / "oldnames.json").read_text(encoding="utf-8"))
    for code, names in old["zh14"].items():
        tgt = vcm if code in vcm.valid else vpcs if code in vpcs.valid else None
        if tgt:
            for n in names:
                tgt.add(n, code, "zh14", raw_code=True)

    m9 = json.loads((STAGING / "map9.json").read_text(encoding="utf-8"))
    n9 = 0
    for kind, voc in (("cm", vcm), ("pcs", vpcs)):
        for icd9, targets in m9[kind].items():
            zh, en = m9["names"].get(icd9, ["", ""])
            codes = sorted({t[0] for t in targets if t[0] in voc.valid})
            node = codes[0] if len(codes) == 1 else lca(codes, voc.valid)
            if not node:
                continue
            if zh:
                voc.add(zh, node, "zh9", raw_code=True)
                n9 += 1
            if en:
                voc.add(en, node, "en9", raw_code=True)
    rep["zh9_attached"] = n9

    # 國教院：英文名 → 中文譯名。對到 (a) ICD 英文標題去掉 ", unspecified" 後完全相同，
    # 或 (b) CDC Index 主詞（該主詞的預設碼）。
    T = "{urn:oasis:names:tc:opendocument:xmlns:table:1.0}"
    en2zh: dict[str, list[str]] = defaultdict(list)
    with zipfile.ZipFile(V / "naer_med.zip") as outer:
        for info in outer.infolist():
            inner = zipfile.ZipFile(io.BytesIO(outer.read(info)))
            root = ET.fromstring(inner.read("content.xml"))
            for tr in root.iter(T + "table-row"):
                cells = ["".join(c.itertext()).strip() for c in tr.iter(T + "table-cell")][:3]
                if len(cells) >= 3 and cells[0] != "ID" and cells[1] and cells[2]:
                    for zh in re.split(r"[；;]", cells[2]):
                        if zh.strip():
                            en2zh[key(cells[1])].append(zh.strip())
    core = lambda en: key(re.sub(r",?\s*(unspecified|not elsewhere classified)$", "", en, flags=re.I))  # noqa: E731
    n_naer = 0
    for r in cm_rows:
        for zh in en2zh.get(core(r[2]), []):
            vcm.add(zh, r[0], "naer", raw_code=True)
            n_naer += 1
    idx = ET.parse(V / "icd10cm-index-2023.xml").getroot()
    for mt in idx.iter("mainTerm"):
        main, _ = title_text(mt)
        code = mt.findtext("code")
        if code and key(main) in en2zh:
            for zh in en2zh[key(main)]:
                vcm.add(zh, code, "naer")
                n_naer += 1
    rep["naer_attached"] = n_naer


# ── Wikidata（CC0）─────────────────────────────────────────────────────
SNOMED_TAIL = re.compile(r"\s*\((disorder|finding|morphologic abnormality|situation|procedure)\)\s*$", re.I)


def wikidata(vcm: Vocab, rep: dict, cm_rows: list) -> None:
    """P4229（ICD-10-CM）標籤 → wd；別名、或只有 P494（WHO ICD-10）→ wd-alias。

    ★ 簡體過濾：Wikidata 的 "zh" 語系混了簡體（尖锐湿疣、足癣）。台灣使用者不會打簡體，
      而且簡體字串會出現在「命中原因」上很怪。zh-tw/zh-hant/zh-hk 直接收；
      純 "zh" 的字串，每個中文字都必須出現在台灣醫學語料（官方中文名、舊譯名、國教院）才收。
    ★ SNOMED 風格尾巴 "(disorder)" 去掉；純大寫 2–5 字母縮寫（AD、SAF）歧義太大，
      降到 wd-alias（最低權重），不讓它們搶整句 ATM 的第一名。
    """
    p = V / "wikidata.json"
    if not p.exists():
        rep["wikidata"] = "missing"
        return
    rows = json.loads(p.read_text(encoding="utf-8"))
    cjk = re.compile(r"[㐀-鿿]")

    # ★ 簡體判定：能否以 Big5（cp950）編碼。台灣用的正體字都在 Big5，简体独有字（锐、湿、癣、风）不在。
    #   v2–v10 用「每個字都要出現在台灣醫學語料」判定，太嚴 ——「川崎病」的「崎」語料沒出現就被擋，
    #   而官方 M30.3 中文名是「皮膚粘膜淋巴結綜合症(Kawasaki)」，結果「川崎病」查無結果。
    def traditional_ok(s: str) -> bool:
        try:
            s.encode("cp950")
            return True
        except UnicodeEncodeError:
            return False
    has_cm = {r[2] for r in rows if r[0] == "P4229"}
    n = defaultdict(int)
    for prop, kind, item, code, text, lang in rows:
        if prop == "P494" and item in has_cm:
            continue                              # 同一項目已有 CM 碼，以 CM 為準
        text = SNOMED_TAIL.sub("", text).strip()
        if not text:
            continue
        if lang == "zh":
            chars = cjk.findall(text)
            if not chars or not traditional_ok("".join(chars)):
                n["zh_rejected"] += 1
                continue
        elif lang.startswith("zh") and not cjk.search(text):
            continue
        abbr = bool(re.fullmatch(r"[A-Z]{2,5}", text))
        src = "wd" if prop == "P4229" and kind == "label" and not abbr else "wd-alias"
        before = len(vcm.rows)
        vcm.add(text, code, src)
        n[f"{prop}_{'zh' if lang.startswith('zh') else 'en'}"] += len(vcm.rows) - before
    rep["wikidata"] = dict(n)


# ── 官方中文名亂碼修復 ─────────────────────────────────────────────────
def repair_zh(vcm: Vocab, rep: dict, cm_rows: list) -> None:
    """健保署 CSV 有 8 個 CM 中文名把「瘻」變成「?」（K50.013「小腸克隆氏病併?管」，
    同檔 K50.113 卻是正確的「瘻管」）—— 來源檔轉碼掉字。

    ★ 不改官方名稱（畫面照原樣顯示），只多掛一條修復後的入口詞讓「瘻管」搜得到。
      規則刻意窄：只修「?管」且英文名含 fistula，其他 ? 一律不猜。
    """
    fixed = []
    for r in cm_rows:
        if "?" in r[1] and "?管" in r[1] and "fistula" in r[2].lower():
            vcm.add(r[1].replace("?管", "瘻管"), r[0], "fix-zh", raw_code=True)
            fixed.append(r[0])
    rep["zh_repaired"] = fixed
    rep["zh_question_marks"] = [r[0] for r in cm_rows if "?" in r[1] or "\ufffd" in r[1]]


# ── 人工策展（只收 approved: true）──────────────────────────────────────
def curated(vcm: Vocab, rep: dict) -> None:
    for fname, src in (("synonyms_zh.yaml", "cur-zh"), ("abbrev.yaml", "cur-abbr")):
        p = CURATION / fname
        if not p.exists():
            continue
        items = yaml.safe_load(p.read_text(encoding="utf-8")).get("items") or []
        ok = [x for x in items if x.get("approved") is True]
        # ★ 醫師核可的對應以核可為準（v16）：同一段文字在其他來源指向別的碼 → 移除；
        #   同文字同碼已存在 → 來源改記為策展（權重較高）。
        #   v15 以前 add() 只保留「序號較小」的來源：「泌尿道感染」的核可條目 N39.0 被 ICD-9 舊名（0.55）蓋掉，
        #   Wikidata 把同一段文字指到 N30.0 急性膀胱炎（0.7）反而排第一。
        by_key: dict = {}
        for (k, c) in vcm.rows:
            by_key.setdefault(k, []).append(c)
        cur_src = {S["cur-zh"], S["cur-abbr"]}
        overridden = 0
        for x in ok:
            k = key(x["term"])
            keep = {vcm.resolve(c)[0] for c in x["codes"]}
            for c in by_key.get(k, []):
                row = vcm.rows.get((k, c))
                if row and c not in keep and row[2] not in cur_src:
                    del vcm.rows[(k, c)]
                    overridden += 1
            for code in x["codes"]:
                vcm.add(x["term"], code, src)
                c = vcm.resolve(code)[0]
                if (k, c) in vcm.rows:
                    vcm.rows[(k, c)][2] = S[src]
            if x.get("expand"):
                ABBR[key(x["term"])] = x["expand"]
        rep[fname] = {"items": len(items), "approved": len(ok), "overrode_other_sources": overridden}
    rep["abbr_expand"] = len(ABBR)


# ── CMS PCS Index ───────────────────────────────────────────────────
def cms_index(vpcs: Vocab, rep: dict) -> None:
    root = ET.parse(V / "icd10pcs_index_2023.xml").getroot()
    prefixes = {c[:k] for c in vpcs.valid for k in (3, 4)}
    n = 0

    def walk(el, path: list[str]) -> None:
        nonlocal n
        t = el.findtext("title")
        p = path + [t.strip()] if t else path
        for c in el.findall("codes"):
            code = (c.text or "").strip().upper()
            if code in prefixes or code in vpcs.valid:
                vpcs.add(", ".join(p), code, "cms-idx", raw_code=True)
                if len(p) == 2:
                    vpcs.add(f"{p[1]} {p[0]}", code, "cms-idx", raw_code=True)
                n += 1
        for sub in el.findall("term"):
            walk(sub, p)

    for mt in root.iter("mainTerm"):
        walk(mt, [])
    rep["cms_index"] = n


def main() -> int:
    cm_rows = json.loads((STAGING / "codes_cm.json").read_text(encoding="utf-8"))["codes"]
    pcs_rows = json.loads((STAGING / "codes_pcs.json").read_text(encoding="utf-8"))["codes"]
    vcm, vpcs = Vocab({r[0] for r in cm_rows}), Vocab({r[0] for r in pcs_rows})
    chapters_yaml = yaml.safe_load((CURATION / "chapters.yaml").read_text(encoding="utf-8"))
    nodes: dict[str, dict] = {}
    rep: dict = {}

    cdc_index(vcm, rep)
    tree = cdc_tabular(vcm, nodes, rep, chapters_yaml)
    cdc_neoplasm(vcm, rep)
    mesh_info = doid_mesh(vcm, nodes, rep)
    chinese(vcm, vpcs, rep, cm_rows)
    wikidata(vcm, rep, cm_rows)
    repair_zh(vcm, rep, cm_rows)
    curated(vcm, rep)
    cms_index(vpcs, rep)

    # 標題碼（不可申報）的預設子碼：中文查「帶狀疱疹」只經官方名稱對到 B02（標題碼）。
    #   1. 3 碼類目：ICD 慣例 H.9（B02.9、L40.9、E11.9、I63.9）且可申報
    #   2. 否則：「直接子碼」中英文名含 unspecified 的可申報碼（最短）
    # ★ v7 的兩條規則都錯過：CDC 英文名比對把 B02 的預設碼選成 B02.30（帶狀疱疹眼病），
    #   「子孫碼含 unspecified」也會抓到 B02.30「ocular disease, unspecified」——
    #   正解 B02.9 叫「without complications」，根本沒有 unspecified 這個字。
    use = {r[0]: r[3] for r in cm_rows}
    direct_unspec: dict[str, str] = {}
    for r in cm_rows:
        if r[3] == 1 and r[6] and "unspecified" in r[2].lower():
            cur = direct_unspec.get(r[6])
            if cur is None or len(r[0]) < len(cur):
                direct_unspec[r[6]] = r[0]
    defaults: dict[str, str] = {}
    for r in cm_rows:
        if r[3] != 0:
            continue
        if len(r[0]) == 3 and use.get(f"{r[0]}.9") == 1:
            defaults[r[0]] = f"{r[0]}.9"
        elif r[0] in direct_unspec:
            defaults[r[0]] = direct_unspec[r[0]]
    rep["header_defaults"] = {"n": len(defaults), "headers": sum(1 for r in cm_rows if r[3] == 0),
                              "sample": {k: defaults[k] for k in ("B02", "L40", "L20", "E11", "I63") if k in defaults}}

    rep["cm_terms"], rep["pcs_terms"] = len(vcm.rows), len(vpcs.rows)
    rep["cm_codes_with_terms"] = len({r[1] for r in vcm.rows.values()})
    rep["dropped"] = {"cm": dict(vcm.dropped), "pcs": dict(vpcs.dropped)}
    by_src = defaultdict(int)
    for r in vcm.rows.values():
        by_src[SRC[r[2]]] += 1
    for r in vpcs.rows.values():
        by_src[SRC[r[2]]] += 1
    rep["by_source"] = dict(by_src)
    rep["heldout"] = len(vcm.heldout) + len(vpcs.heldout)

    dump = lambda name, obj: (STAGING / name).write_text(  # noqa: E731
        json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    dump("vocab_cm.json", {**vcm.dump(), "def": defaults, "abbr": ABBR})
    dump("vocab_pcs.json", vpcs.dump())
    dump("nodes_cm.json", nodes)
    dump("tree_cm.json", tree)
    dump("mesh.json", mesh_info)
    dump("vocab_report.json", rep)
    (BENCH / "heldout.json").write_text(json.dumps(
        {"cm": vcm.heldout, "pcs": vpcs.heldout}, ensure_ascii=False, indent=0), encoding="utf-8")
    print(json.dumps(rep, ensure_ascii=False, indent=1)[:3000])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
