# ICD-10 健保診斷碼查詢（icd10-tw）

<sub>by M116 RickyYu</sub>

> **給接手的 AI／工程師**，照這個順序讀：
> [30 秒定位](#30-秒定位) → [三個版本怎麼同步](#三個版本) → [自動更新](#自動更新) →
> [搜尋設計](#搜尋設計mesh-式) → [基準測試與迭代](#基準測試與迭代) →
> [**踩過的坑**](#踩過的坑不要再踩一次) → [驗證清單](#驗證清單) → [策展核可](#策展核可俗稱縮寫)。
>
> 架構照抄 `~/Developer/小工具專區/nhi-drug-rules`（單一權威資料 → 本機／線上／離線三版，
> 指紋綁定、fail-closed 閘門）。「踩過的坑」都是實測打臉過的結論。

**線上版：<https://rickyrickyrickyyu.github.io/icd10-tw/>**（手機可「加入主畫面」離線使用）｜
離線單檔：[GitHub Releases](https://github.com/rickyrickyrickyyu/icd10-tw/releases)｜終端機：`icd`

以**健保署 2023 年版中文版 ICD-10-CM/PCS** 為準（健保自 114/1/1 起全面採用），搜尋仿 PubMed MeSH：
中文、英文、俗稱、縮寫、錯字、代碼（有沒有小數點都可以）、2014 舊碼、ICD-9 都能查，
結果上方的 *Search details* 會說明查詢被對應到哪些主題。

## 規模

- CM 96,802 碼（可申報 73,681）／PCS 78,530 碼
- 入口詞 CM 262,385 條、PCS 71,805 條（17 個來源，見[詞彙層](#詞彙層入口詞來源)）
- 2014→2023 對應（去掉恆等列後 CM 2,137／PCS 5,065 個舊碼）、ICD-9→2023（CM 12,384／PCS 3,377）
- 重大傷病 3,091 碼、29 類
- 首載 gzip 226 KB（皮膚科子集 5,350 碼）；全庫懶載約 2.7 MB gz；離線單檔 8.9 MB

## 30 秒定位

| 想改什麼 | 檔案 |
|---|---|
| 加／改一個處理步驟 | `bin/pipeline.sh`（**唯一**步驟清單；Makefile、一鍵更新、CI 都呼叫它） |
| 加驗證閘門 | `etl/validate.py`（16 道，fail-closed） |
| 搜尋排序、權重 | `src/lib/search/engine.js` 的 `CONFIG`（改完一定 `make bench`） |
| 正規化（英式拼法、中文異體字、stem） | `src/lib/search/normalize.js` |
| 查詢語法、代碼偵測、ICD-9 隔離 | `src/lib/search/query.js` |
| 入口詞來源（CDC/DOID/MeSH/Wikidata…） | `etl/build_vocab.py` |
| 俗稱、縮寫（人工核可） | `curation/synonyms_zh.yaml`、`curation/abbrev.yaml` |
| 重大傷病對照表 | `curation/catastrophic.yaml` ＋ `bin/fetch_catastrophic.mjs` |
| 金絲雀碼、已知官方亂碼 | `curation/canaries.yaml` |
| 基準題組 | `tests/bench/*.yaml`、`tests/bench/run.mjs`；歷史 `bench_history.jsonl` |
| 終端機查詢 | `cli/icd.mjs`（直接 import 網頁的搜尋程式，**只有一份實作**） |

## 使用

```bash
pnpm install
make refresh      # 抓資料 → 建置 → 驗證 → promote → 本機網頁 → 離線包
pnpm dev          # http://localhost:5193/icd10-tw/
```

終端機（`~/Developer/local_LLM/bin/icd`，setup.sh symlink 到 `~/.local/bin/icd`）：

```bash
icd 皮蛇                 # 先查皮膚科，沒有再自動查全部 CM
icd "herpes zoster eye"
icd L40                  # 代碼詳細：可否申報、下層碼、重大傷病、Excludes
icd 696.1                # ICD-9 → 2023
icd status | sync | update | offline | web | open
```

## 三個版本

| 版本 | 位置 | 產生 |
|---|---|---|
| 本機網頁 | `dist/`（`icd` 開的） | pipeline `pnpm build` |
| 線上網頁 | GitHub Pages | `update.yml`（每週）或 push 觸發 `deploy.yml` |
| 離線單檔 | `offline/icd10-tw-offline-YYYYMMDD.html` ＋ zip；GitHub Release | pipeline 最後一步 |

三者都從 `public/data/` 衍生，用 `data_fingerprint`（內容雜湊，排除 meta.json）綁在一起；
`etl/check_offline.py` 在 promote **之後**檢查（放進 validate 會每次誤報）。

**離線包是壓縮內嵌**：public/data 56 MB 原樣內嵌會讓單檔破 50 MB。每個 JSON gzip＋base64，
執行時用 `DecompressionStream` 懶解（需 Chrome/Edge 80+、Safari 16.4+；太舊的瀏覽器會顯示明確訊息）。

## 自動更新

- **每週**（`update.yml`，週二 05:00）：比對健保 6 個 CSV 的 **sha**（官方「不定期更新」，比 sha 不比日期）。
- **詞彙層每月**：`actions/cache` 以「年-月」為 key，同月沿用，免得每週因 Wikidata 小編輯就改版。
- 有變 → 完整 pipeline（16 道閘門 **＋搜尋回歸鎖**）→ commit → **Release 附離線包**。
- 沒變也重新部署，並把 `checked_at` 注入 dist 的 meta.json；網站上「最後自動檢查」超過 21 天會警告（= 排程壞了）。
- 失敗 → 開 issue、上傳 staging，網站維持上一版。gate 1（表頭契約）失敗通常代表**健保署轉版**，要人工處理。
- 重大傷病頁面有新版 → 開 issue，**不自動套用**（類別名稱要人工核對）。
- 使用者端：PWA 換版自動重整一次（`swUpdate.js`）；本機 `icd` 啟動時每天比一次線上指紋，不一致就自動 `git pull` 重建。

## 搜尋設計（MeSH 式）

每個 ICD 節點是一個「主題」，所有來源的同義詞是「入口詞」。查詢流程照 PubMed Automatic Term Mapping：

0. **先拼字修正**（原字與 stem 取距離較小者 → 子序列優先 → 長度差 → 常見度）
1. **代碼**：`L400`=`L40.0`、範圍 `L40.0-L40.4`、前綴；純數字加點或 `9:` 前綴 → ICD-9（**不進主索引**）
2. **整句 ATM**：查詢的「詞集合」等於某入口詞 → 對應主題；explode 帶出子孫；該入口詞直接給的碼標 ★**預設碼**
3. **切段 ATM**：中文用字典 DP 最長匹配切段（字典含所有名稱與入口詞的詞片），英文最長 5 詞片段；段與段 AND
4. **自由文字**：BM25（中文 bigram ＋ **跳一字字對**、英文 stem），每個候選以 bitmask 記命中的查詢詞
5. 合併；分數相近時**可申報碼優先**（標題碼 ×0.97）

UI：自動完成顯示「命中原因」、Search details、explode 開關、限定詞 facets（側別、就醫階段、病程、併發症、可否申報）、
代碼頁（＝MeSH Descriptor 頁：樹狀位置、依來源分組的入口詞、Excludes/Code first/Use additional、第 7 碼、重大傷病、舊碼反查、MeSH Scope Note）。

### 詞彙層（入口詞來源）

| 來源 | 條數（CM） | 權重 |
|---|---|---|
| CDC Index 路徑（倒裝＋自然語序） | 89,969 | 0.85 |
| CDC Index `see` 解析 | 12,845 | 0.80 |
| CDC Tabular inclusion terms | 10,740 | 0.85 |
| CDC Neoplasm Table | 9,012 | 0.60 |
| Disease Ontology（名稱＋EXACT/RELATED） | 10,548 | 0.75／0.5 |
| MeSH entry terms（經 DOID xref） | 20,802 | 0.70 |
| Wikidata 標籤／別名（簡體以 Big5 可編碼判定過濾） | 59,143 | 0.70／0.60 |
| 2014 舊中文名、ICD-9 中英文名（掛共同祖先） | 65,339＋10,221＋9,196 | 0.75／0.55／0.5 |
| 國教院醫學名詞 | 1,103 | 0.70 |
| 官方亂碼修復（?→瘻） | 8 | 0.95 |
| 人工策展俗稱／縮寫 | 核可後才收 | 0.95 |

## 基準測試與迭代

`node tests/bench/run.mjs`（`make bench`）。題組以查詢雜湊切 dev/test，調參只看 dev。

| 題組 | 內容 |
|---|---|
| clinical_derm（225） | 皮膚科實際查法：俗稱、縮寫、詞序亂、中英混、英式拼法 |
| general（181） | 門診常見 |
| index_heldout（1,500） | CDC 入口詞保留 20% 不進索引 → 英文泛化 |
| zh_heldout（1,000） | 2014／ICD-9 中文舊名保留 20% → 中文改寫召回 |
| default_code（600） | CDC 主詞 → 直接碼要第 1 |
| typo（199） | 固定 seed 單一編輯擾動 |

迭代紀錄（Hit@1／Hit@5，詳見 `bench_history.jsonl`）：

| 版本 | 改了什麼 | clinical | general | idx_held | zh_held | typo | p95 |
|---|---|---|---|---|---|---|---|
| v0 | 初版 | 86.2／87.1 | 84.5／90.1 | 70.9／84.6 | 27.7／49.1 | 80.4／92.5 | 431 ms |
| v1 | 覆蓋率分母排除 df=0、切段覆蓋率懲罰 | 88.0／89.8 | 86.2／91.7 | 71.3／85.8 | 28.0／51.1 | 75.9／94.5 | 278 ms |
| v2 | **資料加 Wikidata** | 92.4／94.7 | 92.3／97.2 | 71.2／86.4 | 28.2／51.1 | 76.4／95.0 | 319 ms |
| v3 | 量測修正：保留集 gold 收同文字所有碼 | 〃 | 〃 | 73.9／86.7 | 65.7／77.1 | 〃 | — |
| v4 | 先修正再 ATM、bitmask、片語表存整數 | 92.0／94.7 | 92.8／97.2 | 73.8／86.4 | 65.6／76.9 | 92.0／97.0 | **7.8 ms** |
| v5 | angioedema 英式規則 bug、拼字候選排序 | 〃 | 〃 | 〃 | 〃 | **95.5／99.5** | 7.6 ms |
| v6 | 中文跳一字字對 | 92.0／94.7 | **93.4／97.8** | 73.6／86.4 | 66.1／77.1 | 95.5／99.5 | 8.6 ms |
| ~~v7~~ | 標題碼的預設子碼以**同分**帶上 → **退回** | 92.0／94.7 | 92.8／97.8 | **67.3**／86.4 | **62.8**／77.1 | 96.0／99.5 | 8.4 ms |
| v8 | 預設子碼改 ICD 慣例 H.9／直接子碼 unspecified，排在標題碼**後**（×0.96）；★ 只給可申報碼 | 92.0／94.7 | 93.4／97.8 | 73.6／86.4 | 66.1／77.1 | 95.5／99.5 | 8.0 ms |
| v9 | 直接命中節點改用明確 `nodeSet`（v1–v8 以權重 ≥1.0 推論，官方名稱來源的 explode 子孫被誤當節點、★ 標錯） | 92.0／94.7 | 93.4／97.8 | 73.6／86.4 | 66.1／77.1 | 95.5／99.5 | 8.3 ms |
| v10 | 俗稱 42＋縮寫 38 條經醫師全部核可 | 98.2／99.6 | 95.6／100 | 73.6／86.4 | 66.1／77.1 | 95.5／99.5 | 8.4 ms |
| **v11** | **換一批跨科別新題（diverse 177 題）反覆測**：Big5 判定簡體（原字集法擋掉「川崎病」）、CDC 主詞首字變體（"Stenosis, stenotic"）、see 只退一層、★ 只給 CDC 直接碼（+8%）、表現碼 ×0.9（目前 baseline） | 98.2／99.6 | **96.7／100** | **78.3／89.8** | 66.0／77.0 | **96.5／99.5** | 8.8 ms |

| v12 | 多字查詢展開已核可縮寫（「BCC nose」→ basal cell carcinoma nose）、「主動脈瓣狹窄」策展、官方亂碼提示 | 98.2／99.6 | 96.7／100 | 78.3／89.8 | 66.0／77.0 | 96.5／99.5 | 8.6 ms |
| **v13** | **第三批新題 fresh（30 題）反覆測**：否定句降權（「未伴有敗血性休克」、"without septic shock"）、骨盆腔發炎／手汗症策展（目前 baseline） | 98.2／99.6 | 96.7／100 | 78.3／89.8 | 66.0／77.0 | 96.5／99.5 | 8.4 ms |

fresh（第三批新題，含否定句）：首測 Hit@1 27/30 → v13 **31/31**。

diverse（跨科別、從未拿來調參的新題）：v10 首測 Hit@1 93.2／Hit@5 98.9 → v11 97.2／100 → v12 **97.8／100**（180 題）、零結果 0。
剩下 4 題都是「標題碼第 1、可申報子碼第 2」（突發性耳聾、dog bite、bee sting、nicotine dependence），正解仍在前 2。

線上實測（2026-09-11，全部診斷範圍，20 個跨科別疾病名稱逐一查）：皮蛇→B02.9、川崎病→M30.3、aortic stenosis→I35.0★、
pyelonephritis→N12、勃起功能障礙→N52.9、糖尿病腎病變→E11.21、退化性膝關節炎→M17.9、狹心症→I20.9、
herpes zoster eye→B02.39★、psoraisis→L40.9★、hypertensoin→I10★、思覺失調症→F20.9★、登革熱→A90、恙蟲病→A75.3、
中暑→T67.0、L400→L40.0、696.1→7 碼對應；v12 再修正 主動脈瓣狹窄→I35.0、BCC nose→C44.311。

v7 退回的原因：保留集的正解常是標題碼本身，子碼同分搶到第一就讓 Hit@1 掉 6 點；而且「CDC 英文名比對」
與「子孫含 unspecified」兩條規則都把 B02 的預設碼選成 B02.30（帶狀疱疹眼病）。v8 排名與 v6 完全相同，
只改善呈現（標題碼後面緊接 ★ 可申報碼）。baseline（`baseline.json`）為 v6＝v8；`make verify` 任一指標比 baseline 掉超過 1 點即失敗。
clinical 剩下的失分幾乎全是俗稱／縮寫（皮蛇、香港腳、BCC、SJS…）→ 等[策展核可](#策展核可俗稱縮寫)。

## 踩過的坑（不要再踩一次）

**資料**
- **重大傷病 ods 對 curl 一律 403**（WAF 看 TLS 指紋／JS，連完整 Chrome 標頭都擋）。Playwright headless 也 403，
  **拿掉三個自動化指紋才 200**：`--disable-blink-features=AutomationControlled`、UA 去掉 `HeadlessChrome`、`navigator.webdriver`。
- 重大傷病 ods 的碼**不帶小數點**（`C4321`）；官方說 30 大項但 ods 只編 1–29；第 14 類在 odt 只有「十四」兩字無標題。
- 健保署 API 的 CSV **比網頁上的 xls 新**（含 115.08.27 修正）→ 以 API 為準。
- 官方 CSV 有 **7,625 個 CJK 相容字** → NFC 後歸零（gate 5）。
- 官方 **8 個中文名的「瘻」變成「?」**（K50.013…，同檔 K50.113 正確）→ 顯示原樣＋修復入口詞（gate 16 鎖名單）。
- 對應檔用 **`NoDx`／空白**表示「無對應」，不是碼（gate 7）。ICD-9 對應要排除「刪除對應」1,199 列。
- **ICD-9 V/E 碼與 ICD-10 撞號**（`E800.0` 是 ICD-9 鐵路事故；ICD-10 `E80.0` 無點寫法也是 `E800`）→ ICD-9 不進主索引。
- `U00.0REH`（住院為復健治療）是台灣特有碼，沒有上層節點（gate 4 白名單）。
- CDC 字母索引**不寫第 7 碼**（T14.8、S00.512 需補 A/D/S）→ gate 12 豁免第 7 碼類目。

**抓取**
- 本機 uv Python 的 urllib **SSL 憑證驗證失敗**（CI 沒事）→ 一律 curl（`etl/lib/http.py`）。
- CDC 伺服器約 **12 KB/s**，zip 21.7 MB 大半是 PDF → **HTTP range 只抓 XML 成員**，約 60 秒。
- NLM 對未發布的 `desc2027.gz` 回 **302 → 200 + text/html**（soft-404）→ 判斷存在要看型別與大小。
- 管線寫法 `curl ... > /dev/stdout | python` 會截斷串流、看起來像 API 回壞 UTF-8 —— 是自己的錯；fetch 仍保留 strict UTF-8。

**詞彙層**
- CDC 主詞本身有逗號（"Wound, open"）→ **see 目標不能按逗號拆**，用 ", " 串接整條路徑比對（第一版 55% see 解析失敗）。
- ICD-9 一個碼對到幾十個新碼 → 名稱掛在**目標碼的共同祖先**，不是每個都掛（MeSH 的做法）。
- Wikidata `zh` 語系混簡體 → **以 Big5（cp950）能否編碼判定**（擋 3,290 條）。v2–v10 用「每個字都要出現在
  台灣醫學語料」太嚴，「川崎病」的「崎」語料沒有就被擋，而官方 M30.3 中文名是「皮膚粘膜淋巴結綜合症(Kawasaki)」→ 查無結果。
- CDC 主詞常帶變形清單（"Stenosis, stenotic"、"Tuberculosis, tubercular, tuberculous"）→ 詞集合多了變形字，
  永遠對不到「aortic stenosis」→ 另收只用主詞首字的版本（v11，index_heldout Hit@1 +4.7）。
- 「in diseases classified elsewhere」表現碼不能當主診斷 → 排序 ×0.9；★ 預設碼只給 CDC 字母索引直接給的碼。
- **否定句**：「敗血性休克」第一名曾是 R65.20「**未伴有**敗血性休克的嚴重敗血症」（標題含查詢字串、意思相反）→
  查詢整段緊接在 未伴有／無／未／非 之後、或全部落在英文 "without …" 子句裡時 ×0.6（v13，`negated()`）。
- DOID 只覆蓋 12% 可申報碼（S 章 0%）→ 只能當輔助層，主幹是 ICD 樹＋CDC Index。
- 國教院「醫學名詞」3 萬詞但只對上 41/1,914 類目（連 psoriasis 都沒有）→ 小補充。

**搜尋**
- **英式規則 `oedema→edema` 把 angioedema 改成 angiedema** → 打對打錯都查不到 T78.3（lookbehind 修正）。
- 拼字只比 df 會 hiev→hiv、cest→cyst；stem 會先砍尾巴讓 gastroenterits 離正解變遠（見 `correct()`）。
- 切段路徑的「全庫沒有的詞」曾被當成「已滿足」→ breat cancer 變成 cancer→C80.1（先修正再 ATM）。
- 保留集若直接從詞彙表刪掉，**正式站也會少 20% 入口詞** → 改成旗標，只在基準測試排除。
- 片語表值存 `[[code,src,flags]]` 吃 114 MB → 改存整數列號。
- 保留集 gold 只收一個碼是量錯（舊名常拆成多個新碼）→ v3 修正後 zh_heldout 51→77。

**部署**
- GitHub runner（Ubuntu 24.04）系統 Python 是 externally-managed，`uv pip install --system` 被拒 →
  update.yml 先 `actions/setup-python`（首次上線那次自動更新就死在這步）。
- **資料快取不能用 NetworkFirst＋逾時**：v12 以前 `data/*.json` 走 NetworkFirst（3 秒逾時），vocab_cm.json 在慢網路
  超過 3 秒就回舊快取 → 線上實測「新程式＋舊詞彙」（縮寫展開失效）。改成資料網址帶 `?v=<指紋>`＋CacheFirst，
  只有 meta.json 網路優先；舊的 `icd-data-v1` 快取在 swUpdate 刪掉。
- **健保署會間歇性擋 GitHub runner**（nhi-drug-rules 2026-09-05 月更也失敗）→ update.yml 下載失敗時
  soft-fail：不更新資料、照常部署、不注入 checked_at、只開一張 issue；急用在本機 `icd update`（台灣 IP）。
- **健保署會 reset 連續大量下載**：第一版 update.yml 先 `--check` 抓 6 個 CSV、pipeline 又抓一次（約 240 MB），
  第二輪 `curl 56 Connection reset by peer` → 改成只下載一次、pipeline 用 `rebuild`，curl 加 `--retry-all-errors`。
- 代碼詳細頁原本載 cm.json＋vocab_cm.json（原始 24 MB），線上首次開 `#/c/L40.0` 實測 **56 秒** →
  改成依首字母的 `detail/<字母>.json` 分片；離線包不內嵌分片，前端改從全庫切（`useData.loadDetail`）。

**前端**
- **同一元件跨路由重用會拿到上一頁的 state**（ICD-9 頁→2014 頁 crash），而**沒有 ErrorBoundary 時整站白畫面** → 路由當 key ＋ ErrorBoundary。
- dev server 沒有 sw.js，硬註冊會噴 MIME 錯誤；離線包用 http 開也會 404 → 兩種情況都不註冊。
- `toSorted()` 需要 Chrome 110+ → **不用**（離線版要給醫院舊電腦），oxlint 關掉 `no-array-sort`。
- 其餘沿用 nhi-drug-rules：不 precache index.html、`navigateFallback: null`、內嵌 script 放 `</body>` 前、`_embed()` 跳脫 `</script>`、CSP 只加線上版。

## 驗證清單

`make verify`：oxlint `--deny-warnings` → 線上＋離線兩種 build → `tests/verify_codes.py`（逐碼比對原始 CSV）→
`tests/search.test.mjs`（13 項，每項對應一個坑）→ 搜尋回歸鎖 → `check_offline.py`。

瀏覽器手動看（`pnpm dev`）：`#/q/shingles`（★預設碼、Search details）、`#/q/糖尿病腎病變`（切段 AND）、
`#/c/L40`（標題碼警示、下層碼、入口詞、MeSH）、`#/m9/696.1`、`#/m14/A04.7`、`#/cat/5`、手機寬度、console 零錯誤。

## 策展核可（俗稱、縮寫）

`curation/synonyms_zh.yaml`、`curation/abbrev.yaml` 由 Claude 草擬、全部 `approved: false`，**pipeline 只收 `approved: true`**。
醫師逐條看過後改 true（或整份 `sed -i '' 's/approved: false/approved: true/'`），`make rebuild`，再 `make bench-accept` 更新基準。
刻意不收高度歧義縮寫（BP、PV、MM、AA、PE）。

## 已知取捨

- **public/data 進版控**（沿用 nhi-drug-rules：CI 與本機讀同一份、可回溯）。代價是每次資料更新都會重寫
  cm.json（14.5 MB）、pcs.json（11.7 MB）、vocab_cm.json、以及詳細頁分片（合計原始約 98 MB），
  git 歷史每次約增加數十 MB（JSON 壓縮率高，實際較少）。
  詞彙層刻意每月才更新一次就是為了壓低這個成長。若日後 repo 太大，可改成 CI 從 raw 重建、public/data 不進版控。
- 首次載入只建皮膚科子集的索引；切「全部診斷」要在瀏覽器建全庫索引（桌機約 2 秒、記憶體約 110 MB）。

## 安全與隱私

- 公開 repo：一鍵更新與 CI 只 `git add` 資料管線路徑，推送前跑 `bin/pre_push_check.py`（路徑白名單＋個資樣式掃描）。
- 常用碼、最近查詢只存 localStorage，不含病人資訊；本站不收集任何資料（CSP `connect-src 'self'`）。
- 資料授權與顯名見 `DATA_LICENSE.md`。
