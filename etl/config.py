"""全案共用路徑與常數。所有路徑相對 repo root，讓本機與 CI 跑同一份程式。"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"
BUILD = ROOT / "data" / "build"
STAGING = BUILD / ".staging"
CURATION = ROOT / "curation"
DERIVED = CURATION / "derived"          # 靜態上游（CDC/CMS/DOID/MeSH/國教院）的衍生物，進 git
SNAPSHOTS = ROOT / "snapshots"
PUBLIC = ROOT / "public" / "data"
SOURCES = BUILD / "sources.json"

USER_AGENT = "icd10-tw/1.0 (+https://github.com/rickyrickyrickyyu/icd10-tw)"

# ── 健保署開放資料（政府資料開放授權第 1 版）──────────────────────────
NHI_API = "https://info.nhi.gov.tw/api/iode0000s01/Dataset?rId=A21030000I-{}"
DATASETS = {
    "cm":        "D20025-005",   # 2023 中文版 ICD-10-CM（data.gov.tw 177507）
    "pcs":       "D20025-006",   # 2023 中文版 ICD-10-PCS
    "map14_cm":  "D20026-007",   # 2014↔2023 CM 對應（177508）
    "map14_pcs": "D20026-008",
    "map9_cm":   "D20027-009",   # 2001 ICD-9-CM → 2023 CM（177509）
    "map9_pcs":  "D20027-00A",
}

# ★ 欄位契約：官方改欄位（尤其是轉版成「20XX年版」）是最可能的破壞來源，gate 逐字比對。
COLS_CODE = ["2023年版ICD-10-CM/PCS", "USE", "ICD-10-CM/PCS英文名稱", "ICD-10-CM/PCS中文名稱",
             "狀態", "修訂日期"]
COLS_MAP14 = ["2014年版ICD-10-CM/PCS", "2014年版ICD-10-CM/PCS_英文名稱", "2014年版ICD-10-CM/PCS_中文名稱",
              "2023年版ICD-10-CM/PCS", "2023年版ICD-10-CM/PCS_英文名稱", "2023年版ICD-10-CM/PCS_中文名稱",
              "2014代碼狀態", "2023代碼狀態", "修訂日期"]
COLS_MAP9 = ["2001年版ICD-9-CM", "ICD-9-CM英文名稱", "ICD-9-CM中文名稱",
             "2023年版ICD-10-CM/PCS", "2023年版ICD-10-CM/PCS英文名稱", "2023年版ICD-10-CM/PCS中文名稱",
             "對應情形", "異動情形", "修訂日期"]
CONTRACT = {"cm": COLS_CODE, "pcs": COLS_CODE, "map14_cm": COLS_MAP14, "map14_pcs": COLS_MAP14,
            "map9_cm": COLS_MAP9, "map9_pcs": COLS_MAP9}

# ── 詞彙層上游 ─────────────────────────────────────────────────────
# CDC 伺服器實測約 12 KB/s，整包 21.7 MB 要半小時；zip 裡大半是 PDF。
# fetch_vocab.py 用 HTTP range 只抓 XML 成員（約 60 秒）。
CDC_ZIP = ("https://ftp.cdc.gov/pub/health_statistics/nchs/publications/ICD10CM/2023/"
           "icd10cm-Tabular-Index-2023.zip")
CDC_MEMBERS = ["icd10cm-index-2023.xml", "icd10cm-tabular-2023.xml", "icd10cm-neoplasm-2023.xml"]
CMS_PCS_ZIP = "https://www.cms.gov/files/zip/2023-icd-10-pcs-code-tables-and-index.zip"
CMS_MEMBERS = ["icd10pcs_index_2023.xml", "icd10pcs_definitions_2023.xml"]
DOID_OBO = "https://raw.githubusercontent.com/DiseaseOntology/HumanDiseaseOntology/main/src/ontology/doid.obo"
MESH_DESC = "https://nlmpubs.nlm.nih.gov/projects/mesh/MESH_FILES/xmlmesh/desc{year}.gz"
NAER_MED_ZIP = ("https://terms.naer.edu.tw/media/terms_data/1/"
                "%E9%86%AB%E5%AD%B8%E5%90%8D%E8%A9%9E%E5%A3%93%E7%B8%AE%E6%AA%94_GdCMZyw.zip")

# Wikidata（CC0）：有 ICD-10-CM（P4229）或 ICD-10（P494）的項目，取中英文標籤與別名。
# ★ 實測 v0 中文全掛的題（手足口病、漢生病、尖銳濕疣、白癜風、足蹠疣）都在這裡。
WIKIDATA_SPARQL = "https://query.wikidata.org/sparql"

# ICD-10-CM 代碼格式（台灣版有 7 碼延伸與 X 佔位）
RE_CM = r"^[A-Z][0-9][0-9A-Z](\.[0-9A-Z]{1,4})?$"
RE_PCS = r"^[0-9A-HJ-NP-Z]{7}$"

for _d in (RAW, BUILD, STAGING, DERIVED, SNAPSHOTS, PUBLIC):
    _d.mkdir(parents=True, exist_ok=True)
