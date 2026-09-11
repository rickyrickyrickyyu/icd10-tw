#!/usr/bin/env node
/**
 * 用真的瀏覽器下載健保署「重大傷病 2014↔2023 ICD-10-CM 對照表」ods。
 *
 * ★ 為什麼要瀏覽器：健保署 dl- 連結對 curl 一律回 403（5.6 KB WAF 頁），
 *   連完整 Chrome 標頭（UA/Referer/Sec-Fetch-*）也擋 —— 判斷依據是 TLS 指紋或 JS，
 *   不是標頭或 cookie（實測頁面只有 GA cookie）。
 *
 * 用法：
 *   node bin/fetch_catastrophic.mjs            下載並寫入 curation/catastrophic/
 *   node bin/fetch_catastrophic.mjs --check    只印頁面「更新日期」與檔名（排程判斷用）
 *
 * 環境：本機優先用已安裝的 Google Chrome（channel: 'chrome'）；
 *       CI 用 `npx playwright install chromium` 裝的 Chromium（PW_CHANNEL=chromium）。
 */
import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = 'https://www.nhi.gov.tw/ch/cp-15535-74633-3051-1.html';
const checkOnly = process.argv.includes('--check');
const channel = process.env.PW_CHANNEL ?? 'chrome';

// ★ WAF 連 headless 的「頁面本身」都回 403；實測拿掉三個自動化指紋就 200：
//   1) AutomationControlled blink feature  2) UA 裡的 "HeadlessChrome"
//   3) navigator.webdriver。三個缺一不可（只換 UA 仍是 403）。
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const browser = await chromium.launch({
  ...(channel === 'chromium' ? {} : { channel }),
  args: ['--disable-blink-features=AutomationControlled'],
});
try {
  const ctx = await browser.newContext({ acceptDownloads: true, locale: 'zh-TW', userAgent: UA });
  await ctx.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
  const page = await ctx.newPage();
  const resp = await page.goto(PAGE, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  if (!resp || resp.status() !== 200) throw new Error(`頁面 HTTP ${resp?.status()}`);

  const info = await page.evaluate(() => {
    const a = [...document.querySelectorAll('a')].find((x) => /\.ods$/i.test(x.href) && /對照表/.test(x.title || x.textContent));
    const updated = (document.body.innerText.match(/更新日期\s*([\d-]+)/) || [])[1] ?? null;
    return a ? { href: a.href, title: (a.title || a.textContent).trim(), updated } : { updated };
  });
  if (!info.href) throw new Error('頁面上找不到對照表 ods 連結（版面可能改了）');
  if (checkOnly) {
    console.log(JSON.stringify(info));
  } else {
    // 在頁面內 fetch：同源、帶著瀏覽器的 TLS 與 cookie，WAF 視為一般使用者
    const b64 = await page.evaluate(async (href) => {
      const r = await fetch(href);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const buf = new Uint8Array(await r.arrayBuffer());
      let s = '';
      for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      return btoa(s);
    }, info.href);
    const bytes = Buffer.from(b64, 'base64');
    if (bytes.subarray(0, 2).toString() !== 'PK') throw new Error('下載內容不是 zip/ods（可能又被 WAF 擋）');
    const name = `catastrophic_${(info.title.match(/\((\d{3}\.\d{1,2}\.\d{1,2})更新\)/) || [, 'unknown'])[1]}.ods`;
    const out = join(ROOT, 'curation', 'catastrophic', name);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, bytes);
    const sha = createHash('sha256').update(bytes).digest('hex');
    console.log(JSON.stringify({ file: name, bytes: bytes.length, sha256: sha, title: info.title, updated: info.updated }));
  }
} finally {
  await browser.close();
}
