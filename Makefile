# 本機與 CI 共用同一組入口（步驟清單只在 bin/pipeline.sh）。
.PHONY: refresh rebuild gates verify bench bench-accept offline dev build clean catas

refresh:            ## 抓最新資料 → 建置 → 驗證 → promote → 本機網頁 → 離線包
	bin/pipeline.sh fetch

rebuild:            ## 用既有 raw 重跑（不下載）
	bin/pipeline.sh rebuild

gates:              ## 只跑驗證閘門
	python3 etl/validate.py

bench:              ## 搜尋基準測試（印報告、記 history）
	node tests/bench/run.mjs

bench-accept:       ## 把目前結果定為新 baseline（有意改變搜尋行為時才用）
	node tests/bench/run.mjs --accept --note "bench-accept"

catas:              ## 用 Playwright 下載健保署重大傷病對照表（WAF 擋 curl）
	node bin/fetch_catastrophic.mjs

verify:             ## lint + 兩種 build + 逐碼核對 + 搜尋回歸 + 離線包一致
	# ★ lint 一定要能擋：no-undef 這種「跑起來才炸」的錯 build 與 node 測試都抓不到
	pnpm exec oxlint --deny-warnings src
	# ★ 線上與離線兩種 build 都要跑：offline 關掉 PWA，只跑它會漏驗 workbox 設定
	pnpm build
	pnpm exec vite build --mode offline
	python3 tests/verify_codes.py
	node tests/search.test.mjs
	node tests/bench/run.mjs --check --note "make verify"
	python3 etl/check_offline.py

offline:            ## 產生可帶進封閉網路的單檔 HTML 與 zip
	pnpm exec vite build --mode offline
	python3 etl/build_offline.py
	python3 etl/check_offline.py

dev:
	pnpm dev

build:
	pnpm build

clean:
	rm -rf data/build/.staging dist dist-offline
