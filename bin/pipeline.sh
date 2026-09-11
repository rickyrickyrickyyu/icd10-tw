#!/usr/bin/env bash
# 資料管線的單一事實來源（Makefile、一鍵更新、CI 都呼叫這支，不可能分岔）。
#
# 用法：
#   bin/pipeline.sh fetch            抓健保 CSV + 詞彙層 → 建置 → 驗證 → promote → 本機網頁 → 離線包
#   bin/pipeline.sh fetch --vocab    同上，但詞彙層強制重抓（預設只在缺檔或每月前 7 天重抓）
#   bin/pipeline.sh rebuild          不下載，用既有 raw 重跑
#
# exit：0 成功｜1 步驟失敗｜2 閘門擋下（正式資料未動）｜3 資料已更新但離線包失敗
set -euo pipefail
cd "$(dirname "$0")/.."

MODE="${1:-fetch}"
VOCAB_FORCE="${2:-}"

steps=()
if [[ "$MODE" == "fetch" ]]; then
  steps+=("etl/fetch_csv.py:下載健保署 6 個 ICD CSV")
  # 詞彙層上游（CDC/CMS 靜態、DOID/Wikidata 會變）：缺檔、指定 --vocab、或每月前 7 天才重抓，
  # 免得每週都因 Wikidata 小編輯讓整站指紋變動、觸發一次發版。
  if [[ "$VOCAB_FORCE" == "--vocab" || ! -f data/raw/vocab/manifest.json || "$(date +%d)" -le 7 ]]; then
    steps+=("etl/fetch_vocab.py:下載詞彙層（CDC/CMS/DOID/MeSH/國教院/Wikidata）")
  fi
fi
steps+=(
  "etl/normalize_codes.py:正規化 CM／PCS"
  "etl/build_mappings.py:建置 2014／ICD-9 對應"
  "etl/build_catastrophic.py:解析重大傷病對照表"
  "etl/build_vocab.py:建置詞彙層（入口詞、預設碼、撰碼注意）"
  "etl/build_site_data.py:建置前端資料"
)

total=$(( ${#steps[@]} + 5 ))
i=0
for entry in "${steps[@]}"; do
  script="${entry%%:*}"; desc="${entry#*:}"
  i=$((i+1)); echo "▶ $i/$total $desc"
  python3 "$script" || { echo "❌ $script 失敗"; exit 1; }
done

i=$((i+1)); echo "▶ $i/$total 驗證閘門（fail-closed）"
python3 etl/validate.py ${OVERRIDE:+--override "$OVERRIDE"} || exit 2

i=$((i+1)); echo "▶ $i/$total 搜尋基準回歸（資料變動也可能讓搜尋退步）"
node tests/bench/run.mjs --check --note "pipeline $(date +%F)" || exit 2

i=$((i+1)); echo "▶ $i/$total promote 到 public/data"
python3 etl/promote.py || exit 1

i=$((i+1)); echo "▶ $i/$total 重建本機網頁（dist/）"
pnpm build >/dev/null 2>&1 || { echo "❌ 本機網頁建置失敗"; exit 1; }

i=$((i+1)); echo "▶ $i/$total 產生離線包"
if pnpm exec vite build --mode offline >/dev/null 2>&1 \
   && python3 etl/build_offline.py && python3 etl/check_offline.py; then
  echo "   📦 offline/ 已更新"
else
  echo "   ⚠️  離線包產生失敗（線上版不受影響）"; exit 3
fi
