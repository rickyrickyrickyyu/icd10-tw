#!/bin/zsh
# 一鍵更新：抓最新健保 ICD 資料與詞彙層 → 驗證（閘門＋搜尋回歸）→ 更新本機 → 推上 GitHub（連動網頁版）
#
# 雙擊即可執行。fail-closed：任何閘門沒過就中止，不 commit、不推，本機既有資料維持原狀。
#   --vocab   強制重抓詞彙層（CDC/CMS/DOID/MeSH/國教院/Wikidata）
set -uo pipefail
cd "${0:A:h:h}" || exit 1

VENV="$HOME/Developer/vibe-coding/.venv/bin"
[[ -x "$VENV/python3" ]] || { osascript -e 'display alert "找不到 Python 環境" message "預期路徑 ~/Developer/vibe-coding/.venv"'; exit 1; }
export PATH="$VENV:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

echo "════════════════════════════════════════"
echo "  ICD-10 健保診斷碼查詢 · 一鍵更新   $(date '+%Y-%m-%d %H:%M')"
echo "════════════════════════════════════════"
pause() { [[ -t 0 ]] && read -k 1 -s "?按任意鍵關閉..." || true; }

bash bin/pipeline.sh fetch "${1:-}"
rc=$?
if [[ $rc -eq 2 ]]; then
  echo "❌ 驗證閘門或搜尋回歸擋下，正式資料未更新（staging 保留在 data/build/.staging）"; pause; exit 1
elif [[ $rc -eq 3 ]]; then
  echo "⚠️  資料已更新，但離線包產生失敗 —— icd offline 可單獨重產"
elif [[ $rc -ne 0 ]]; then
  echo "❌ 更新失敗"; pause; exit 1
fi

git remote get-url origin >/dev/null 2>&1 || { echo "ℹ️  尚未設定 GitHub remote，只更新了本機"; pause; exit 0; }

# ★ 公開 repo 的隱私閘門：只允許資料管線路徑、掃個資樣式（沿用 nhi-drug-rules）
if ! python3 bin/pre_push_check.py; then
  echo "❌ 推送前檢查未通過，已停在本機"; pause; exit 1
fi
git add public/data snapshots offline/MANIFEST.txt tests/bench/bench_history.jsonl curation
git diff --cached --quiet || git commit -q -m "chore(data): $(date +%F) 資料更新"
git pull --rebase -q || { echo "⚠️  自動合併失敗，請手動 git status"; pause; exit 1; }
for i in 1 2 3 4 5; do git push -q 2>/dev/null && break; echo "   推送失敗 ${i}/5，重試…"; sleep 6; done

# 等 GitHub Actions 部署完，比對線上指紋（push 成功 ≠ 網站已更新）
LOCAL_FP=$(python3 -c "import json;print(json.load(open('public/data/meta.json'))['data_fingerprint'])")
SITE="https://rickyrickyrickyyu.github.io/icd10-tw/data/meta.json"
echo "⏳ 等待部署（約 1–3 分鐘）"
for i in $(seq 1 40); do
  sleep 15
  R=$(curl -sS -m 10 "${SITE}?t=$RANDOM" 2>/dev/null | python3 -c "import json,sys;print(json.load(sys.stdin).get('data_fingerprint',''))" 2>/dev/null || echo "")
  if [[ "$R" == "$LOCAL_FP" ]]; then
    echo "✅ 本機、線上、離線包三者一致（指紋 $LOCAL_FP）"
    osascript -e 'display notification "本機與網頁版都已更新" with title "ICD 資料更新完成"' 2>/dev/null
    pause; exit 0
  fi
done
echo "⚠️  10 分鐘內未看到網頁版更新，請到 GitHub Actions 確認"; pause
