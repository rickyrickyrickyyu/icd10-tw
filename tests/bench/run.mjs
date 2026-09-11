#!/usr/bin/env node
/**
 * 搜尋基準測試。
 *
 *   node tests/bench/run.mjs                 跑全部題組，印報告並附加 bench_history.jsonl
 *   node tests/bench/run.mjs --note "說明"   本輪改了什麼（寫進 history）
 *   node tests/bench/run.mjs --accept        把本輪結果寫成 baseline.json（make bench-accept）
 *   node tests/bench/run.mjs --check         與 baseline 比較，任一指標掉 >1 點就 exit 1（make verify）
 *   node tests/bench/run.mjs --show clinical_derm   列出該題組失分題（迭代時看）
 *
 * 題組：
 *   clinical_derm / general   人寫的實際查法（yaml）
 *   index_heldout             CDC Index 入口詞保留 20%，建索引時排除 → 測英文泛化
 *   zh_heldout                2014／ICD-9 中文舊名保留 20% → 測中文改寫召回
 *   default_code              CDC 主詞（不含逗號）→ 其直接碼要排第 1
 *   typo                      從 en 題目以固定 seed 做單一編輯擾動
 *   codes                     代碼查詢
 * 每組以查詢字串雜湊切成 dev / test：調參只看 dev，test 只看不調，防過擬合。
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine, CONFIG } from '../../src/lib/search/engine.js';
import { phraseKey } from '../../src/lib/search/normalize.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const has = (k) => process.argv.includes(k);

// 資料：預設讀 staging/site（剛建好、還沒 promote 的），沒有就讀 public/data
const SITE = [join(ROOT, 'data/build/.staging/site'), join(ROOT, 'public/data')].find((p) => existsSync(join(p, 'cm.json')));
const J = (f) => JSON.parse(readFileSync(join(SITE, f), 'utf8'));

// ── 極簡 yaml（只支援本專案題組的 flow mapping 格式）──
function loadItems(file) {
  const out = [];
  for (const line of readFileSync(join(HERE, file), 'utf8').split('\n')) {
    const m = line.match(/^\s*-\s*\{(.*)\}\s*$/);
    if (!m) continue;
    const q = m[1].match(/q:\s*("([^"]*)"|[^,]+)/);
    const g = m[1].match(/gold:\s*\[([^\]]*)\]/);
    const tag = m[1].match(/tag:\s*([\w-]+)/);
    out.push({
      q: (q[2] ?? q[1]).trim(),
      gold: g[1].split(',').map((s) => s.trim().replace(/^"|"$/g, '')).filter(Boolean),
      tag: tag?.[1] ?? null,
    });
  }
  return out;
}

const h8 = (s) => createHash('sha1').update(s).digest()[0];
const split = (q) => (h8(q) % 2 === 0 ? 'dev' : 'test');
const goldHit = (code, gold) => gold.some((g) => (g.endsWith('*') ? code.startsWith(g.slice(0, -1)) : code === g));

function sample(arr, n, salt) {
  return [...arr].sort((a, b) => h8(salt + a.q + a.code) - h8(salt + b.q + b.code) || (a.q < b.q ? -1 : 1)).slice(0, n);
}

// 單一編輯擾動（固定 seed）：刪一字、換相鄰、或重複一字
function typo(s, seed) {
  const words = s.split(' ');
  const wi = words.reduce((best, w, i) => (w.length > words[best].length ? i : best), 0);
  const w = words[wi];
  if (w.length < 5) return null;
  const k = 1 + (seed % (w.length - 2));
  const op = seed % 3;
  const nw = op === 0 ? w.slice(0, k) + w.slice(k + 1)
    : op === 1 ? w.slice(0, k) + w[k + 1] + w[k] + w.slice(k + 2)
      : w.slice(0, k) + w[k] + w.slice(k);
  words[wi] = nw;
  return words.join(' ');
}

function main() {
  const t0 = Date.now();
  const cm = J('cm.json').rows;
  const vocab = J('vocab_cm.json');
  const valid = new Set(cm.map((r) => r[0]));
  // ★ 兩個索引：
  //   prod  = 正式站的索引（全部入口詞）→ 人寫題組、預設碼、錯字、代碼
  //   held  = 排除保留集（旗標 2）→ 只給 *_heldout 題組，題目才不會「自己查到自己」
  //   v0 曾全部用 held 跑，等於拿「被砍掉 20% 入口詞的站」考人寫題，分數失真。
  const prod = new Engine(cm, vocab);
  const heldEng = new Engine(cm, vocab, { exclude: (v) => (v[3] & 2) !== 0 });
  const buildMs = prod.buildMs;
  const engineFor = (name) => (name.endsWith('_heldout') ? heldEng : prod);

  const held = JSON.parse(readFileSync(join(HERE, 'data', 'heldout.json'), 'utf8')).cm;
  // ★ 保留集的 gold = 「同一段文字在全詞彙表（含官方名稱）指向的所有碼」。
  //   v0–v2 只收一個碼，但 2014 舊名常被拆成好幾個新碼（「產科手術傷口感染」同時是
  //   O86.0／O86.00／O86.01 的名稱）—— 查詢本身就有多個同樣正確的答案，只認一個是量錯。
  const sameText = new Map();
  const addSame = (text, code) => {
    const k = phraseKey(text);
    if (!k) return;
    if (!sameText.has(k)) sameText.set(k, new Set());
    sameText.get(k).add(code);
  };
  for (const r of cm) { addSame(r[1], r[0]); addSame(r[2], r[0]); }
  for (const v of vocab.t) addSame(v[0], v[1]);
  const goldOf = (x) => [...(sameText.get(phraseKey(x.q)) ?? new Set([x.code]))];
  const sets = {
    clinical_derm: loadItems('clinical_derm.yaml'),
    general: loadItems('general.yaml'),
    diverse: loadItems('diverse.yaml'),        // 跨科別、未拿來調參的新題（v11 起）
    index_heldout: sample(held.filter((x) => x.src === 'cdc-idx' || x.src === 'cdc-see'), 1500, 'i')
      .map((x) => ({ q: x.q, gold: goldOf(x) })),
    zh_heldout: sample(held.filter((x) => x.src === 'zh14' || x.src === 'zh9'), 1000, 'z')
      .map((x) => ({ q: x.q, gold: goldOf(x) })),
    default_code: sample(vocab.t.filter((v) => vocab.src[v[2]] === 'cdc-idx' && !(v[3] & 3) && !v[0].includes(','))
      .map((v) => ({ q: v[0], code: v[1] })), 600, 'd').map((x) => ({ q: x.q, gold: [x.code], top1: true })),
    codes: [
      { q: 'L400', gold: ['L40.0'] }, { q: 'l40.0', gold: ['L40.0'] }, { q: 'L40', gold: ['L40'] },
      { q: 'B02.9', gold: ['B02.9'] }, { q: 'e119', gold: ['E11.9'] }, { q: 'S72.001A', gold: ['S72.001A'] },
      { q: 'L40.0-L40.4', gold: ['L40.0'] }, { q: 'C4A', gold: ['C4A'] },
    ],
  };
  const en = [...sets.clinical_derm, ...sets.general].filter((x) => !x.tag && /^[a-z ]+$/i.test(x.q));
  sets.typo = en.map((x, i) => ({ q: typo(x.q.toLowerCase(), 7 * i + 3), gold: x.gold })).filter((x) => x.q);

  // gold 必須存在於 2023 版（寫錯的 gold 會讓分數永遠失真）
  const badGold = [];
  for (const [name, items] of Object.entries(sets)) {
    for (const it of items) {
      for (const g of it.gold) {
        const ok = g.endsWith('*') ? cm.some((r) => r[0].startsWith(g.slice(0, -1))) : valid.has(g);
        if (!ok) badGold.push(`${name}: ${it.q} → ${g}`);
      }
    }
  }
  if (badGold.length) {
    console.error(`❌ gold 碼不存在於 2023 版（${badGold.length}）：\n  ${badGold.join('\n  ')}`);
    process.exit(2);
  }

  const report = { sets: {}, buildMs, heapMB: Math.round(process.memoryUsage().heapUsed / 1e6) };
  const lat = [];
  const fails = {};
  for (const [name, items] of Object.entries(sets)) {
    const agg = { dev: [], test: [] };
    fails[name] = [];
    const eng = engineFor(name);
    for (const it of items) {
      const t = performance.now();
      const r = eng.search(it.q, { limit: 20 });
      lat.push(performance.now() - t);
      const rank = r.items.findIndex((x) => goldHit(x.code, it.gold));
      agg[split(it.q)].push(rank);
      if (rank !== 0) fails[name].push({ q: it.q, gold: it.gold, rank, top: r.items.slice(0, 3).map((x) => `${x.code} ${x.zh}`) });
    }
    const m = (arr) => ({
      n: arr.length,
      hit1: pct(arr.filter((r) => r === 0).length, arr.length),
      hit5: pct(arr.filter((r) => r >= 0 && r < 5).length, arr.length),
      hit10: pct(arr.filter((r) => r >= 0 && r < 10).length, arr.length),
      mrr: Math.round(1000 * arr.reduce((a, r) => a + (r >= 0 ? 1 / (r + 1) : 0), 0) / Math.max(1, arr.length)) / 10,
      zero: pct(arr.filter((r) => r < 0).length, arr.length),
    });
    report.sets[name] = { dev: m(agg.dev), test: m(agg.test), all: m([...agg.dev, ...agg.test]) };
  }
  lat.sort((a, b) => a - b);
  report.p50 = round(lat[Math.floor(lat.length * 0.5)]);
  report.p95 = round(lat[Math.floor(lat.length * 0.95)]);
  report.totalMs = Date.now() - t0;

  // ── 輸出 ──
  const pad = (s, n) => String(s).padEnd(n);
  console.log(`\n資料 ${SITE.replace(ROOT, '.')}｜建索引 ${buildMs} ms｜heap ${report.heapMB} MB｜p50 ${report.p50} ms｜p95 ${report.p95} ms`);
  console.log(pad('題組', 16) + pad('n', 6) + pad('Hit@1', 8) + pad('Hit@5', 8) + pad('Hit@10', 8) + pad('MRR', 7) + pad('零結果', 8) + '（dev / test Hit@5）');
  for (const [name, s] of Object.entries(report.sets)) {
    const a = s.all;
    console.log(pad(name, 16) + pad(a.n, 6) + pad(a.hit1, 8) + pad(a.hit5, 8) + pad(a.hit10, 8) + pad(a.mrr, 7) + pad(a.zero, 8) + `${s.dev.hit5} / ${s.test.hit5}`);
  }

  const show = arg('--show');
  if (show) {
    console.log(`\n── ${show} 失分題（rank -1 = 前 20 名沒有）──`);
    for (const f of fails[show] ?? []) console.log(`  [${f.rank}] ${f.q}  gold=${f.gold.join('|')}  → ${f.top.join(' ; ')}`);
  }

  let git = null;
  try { git = execSync('git rev-parse --short HEAD', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { /* 尚未 commit */ }
  const entry = { at: new Date().toISOString(), git, note: arg('--note'), config: CONFIG, ...report };
  // --dry：只看不記（查失分題用），history 只留真正的迭代輪次
  if (!has('--dry')) appendFileSync(join(HERE, 'bench_history.jsonl'), `${JSON.stringify(entry)}\n`);

  const basePath = join(HERE, 'baseline.json');
  if (has('--accept')) {
    writeFileSync(basePath, JSON.stringify({ at: entry.at, git, sets: report.sets, p95: report.p95 }, null, 1));
    console.log('\n✅ 已寫入 baseline.json');
  }
  if (has('--check')) {
    if (!existsSync(basePath)) { console.log('－ 尚無 baseline，略過回歸檢查'); return 0; }
    const base = JSON.parse(readFileSync(basePath, 'utf8'));
    const drops = [];
    for (const [name, s] of Object.entries(base.sets)) {
      for (const k of ['hit1', 'hit5', 'mrr']) {
        const now = report.sets[name]?.all?.[k];
        if (now !== undefined && now < s.all[k] - 1) drops.push(`${name}.${k} ${s.all[k]} → ${now}`);
      }
    }
    if (drops.length) { console.error(`\n❌ 搜尋品質回歸：\n  ${drops.join('\n  ')}`); return 1; }
    console.log('\n✅ 無回歸（與 baseline 相比各指標掉幅 ≤ 1 點）');
  }
  return 0;
}

function pct(a, b) { return b ? Math.round(1000 * a / b) / 10 : 0; }
function round(x) { return Math.round(x * 100) / 100; }

process.exit(main());
