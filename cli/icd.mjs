#!/usr/bin/env node
/**
 * 終端機查 ICD-10（門診當下打一行就有答案）。
 *
 * ★ 直接 import 網頁版的 src/lib/search/ —— 搜尋只有一份實作，CLI 與網頁不可能結果不同
 *   （nhi-drug-rules 當年是 JS/Python 雙實作，得靠 39 組 parity test 綁住）。
 *
 *   node cli/icd.mjs 皮蛇                先查皮膚科子集（快），沒結果自動改查全部 CM
 *   node cli/icd.mjs psoriasis --all     直接查全部 CM
 *   node cli/icd.mjs 0DTJ4ZZ --pcs       查 PCS
 *   node cli/icd.mjs L40                 代碼：印詳細（名稱、可否申報、下層碼、重大傷病、Excludes）
 *   node cli/icd.mjs 696.1               ICD-9 → 2023
 *   node cli/icd.mjs --json psoriasis    JSON 輸出（給其他腳本用）
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from '../src/lib/search/engine.js';
import { cmCode, parseQuery } from '../src/lib/search/query.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'public', 'data');
const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const q = argv.filter((a) => !a.startsWith('--')).join(' ').trim();
const tty = process.stdout.isTTY;
const c = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const J = (f) => JSON.parse(readFileSync(join(DATA, f), 'utf8'));
const shard = (code) => (/^[0-9A-Z]/i.test(code) ? code[0].toUpperCase() : '_');

if (!existsSync(join(DATA, 'meta.json'))) {
  console.error('✗ 找不到 public/data，請先 make rebuild');
  process.exit(1);
}
if (!q) {
  console.error('用法：icd <關鍵字|代碼|ICD-9> [--all] [--pcs] [--json]');
  process.exit(1);
}

const pq = parseQuery(q);
const icd9 = pq.codes.find((x) => x.kind === 'icd9');
if (icd9) {
  const kind = flag('--pcs') ? 'pcs' : 'cm';
  const p = join(DATA, 'map9', kind, `${shard(icd9.code)}.json`);
  const m = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8'))[icd9.code] : null;
  if (!m) { console.log(`ICD-9 ${icd9.code}：對應檔查無此碼`); process.exit(0); }
  const rows = new Map(J(kind === 'pcs' ? 'pcs.json' : 'cm.json').rows.map((r) => [r[0], r]));
  console.log(`${c('36', `ICD-9 ${icd9.code}`)} ${m.n?.[0] ?? ''}  →  2023 年版 ${m.t.length} 碼`);
  for (const [code, fl] of m.t) console.log(`  ${c('33', code.padEnd(9))} ${rows.get(code)?.[1] ?? ''}${fl?.[0] === '1' ? c('2', '（近似）') : ''}`);
  process.exit(0);
}

// 單一代碼 → 詳細
const one = pq.codes.length === 1 && !pq.text ? pq.codes[0] : null;
if (one && (one.kind === 'cm' || one.kind === 'icd14') && !flag('--pcs')) {
  const rows = J('cm.json').rows;
  const byCode = new Map(rows.map((r) => [r[0], r]));
  const code = cmCode(one.code);
  const r = byCode.get(code);
  if (!r) {
    const p = join(DATA, 'map14', 'cm', `${shard(code)}.json`);
    const m = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8'))[code] : null;
    if (m) {
      console.log(`${c('36', `2014 年版 ${code}`)} → 2023 年版 ${m.length ? m.map((x) => x[0]).join('、') : '（無對應）'}`);
      for (const [t] of m) console.log(`  ${c('33', t.padEnd(9))} ${byCode.get(t)?.[1] ?? ''}`);
    } else {
      console.log(`${code}：不是 2023 年版 ICD-10-CM 的碼，對應檔也查無`);
    }
    process.exit(0);
  }
  const cat = J('cat.json');
  const nodes = (() => { const p = join(DATA, 'nodes', `${shard(code)}.json`); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {}; })();
  const kids = rows.filter((x) => x[0] !== code && x[0].startsWith(code));
  console.log(`${c('1;33', code)}  ${r[1]}\n        ${c('2', r[2])}`);
  console.log(r[3] === 1 ? c('32', '  ✓ 可申報') : c('31', `  ⚠ 標題碼，不可申報（下層 ${kids.length} 碼）`));
  for (const [n, ni] of cat.codes[code] ?? []) console.log(c('35', `  重大傷病 第 ${n} 類 ${cat.categories[n]}${cat.notes[ni] && cat.notes[ni] !== '本次不受轉版影響' ? `｜${cat.notes[ni]}` : ''}`));
  const nn = nodes[code]?.n ?? {};
  for (const [k, label] of [['excl1', 'Excludes1'], ['excl2', 'Excludes2'], ['codeFirst', 'Code first'], ['useAdd', 'Use additional']]) {
    if (nn[k]?.length) console.log(`  ${c('36', label)}：${nn[k].slice(0, 4).join('；')}${nn[k].length > 4 ? '…' : ''}`);
  }
  for (const k of kids.slice(0, 15)) console.log(`    ${c('33', k[0].padEnd(9))} ${k[1]}${k[3] === 0 ? c('2', '（標題）') : ''}`);
  if (kids.length > 15) console.log(c('2', `    …另 ${kids.length - 15} 碼`));
  process.exit(0);
}

// 一般查詢
function engineFor(scope) {
  if (scope === 'pcs') { const v = J('vocab_pcs.json'); return new Engine(J('pcs.json').rows, v, { kind: 'pcs' }); }
  if (scope === 'derm') { const d = J('derm.json'); return new Engine(d.rows, d.vocab); }
  return new Engine(J('cm.json').rows, J('vocab_cm.json'));
}
let scope = flag('--pcs') ? 'pcs' : flag('--all') ? 'cm' : 'derm';
let res = engineFor(scope).search(q, { limit: 10 });
if (scope === 'derm' && (res.items.length === 0 || (!res.items[0].atm && res.items[0].score < 5))) {
  scope = 'cm';
  res = engineFor(scope).search(q, { limit: 10 });
}
if (flag('--json')) { console.log(JSON.stringify({ scope, ...res }, null, 1)); process.exit(0); }

const d = res.details;
const bits = [];
if (d.corrections.length) bits.push(c('33', `拼字修正 ${d.corrections.map(([a, b]) => `${a}→${b}`).join(' ')}`));
if (d.expansions?.length) bits.push(c('34', `縮寫展開 ${d.expansions.map(([a, b]) => `${a.toUpperCase()}→${b}`).join(' ')}`));
for (const m of d.mapped) bits.push(`「${m.text}」→ 主題 ${m.concepts.slice(0, 3).map((x) => x.code).join('/')}`);
console.log(c('2', `${res.total} 筆｜${scope === 'derm' ? '皮膚科' : scope === 'pcs' ? 'PCS' : '全部 CM'}${bits.length ? `｜${bits.join('｜')}` : ''}`));
for (const it of res.items.slice(0, 8)) {
  const tag = `${it.def ? c('33', '★') : ' '}${it.use === 0 ? c('2', '標') : ' '}`;
  const why = it.why?.text && it.why.src !== 'title' ? c('2', `  ← ${it.why.text}`) : '';
  console.log(`${tag} ${c('36', it.code.padEnd(9))} ${it.zh}${why}`);
}
if (!res.items.length) console.log('（查無結果）');
