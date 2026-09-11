#!/usr/bin/env node
/**
 * 搜尋單元測試：每一條都對應一個踩過的坑（見 README「踩過的坑」）。
 * 用真實的皮膚科子集資料跑，不用假資料。
 */
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { norm, phraseKey, stem } from '../src/lib/search/normalize.js';
import { cmCode, parseQuery } from '../src/lib/search/query.js';
import { Engine } from '../src/lib/search/engine.js';
import { facetsOf } from '../src/lib/search/facets.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let n = 0;
const t = (name, fn) => { fn(); n += 1; console.log(`  ✓ ${name}`); };

t('代碼有無小數點都收', () => {
  assert.equal(cmCode('L400'), 'L40.0');
  assert.equal(cmCode('l40.0'), 'L40.0');
  assert.equal(cmCode('S72001A'), 'S72.001A');
  assert.equal(cmCode('C4A'), 'C4A');
});

t('ICD-9 V/E 碼不會被當成 ICD-10（E800 = E80.0，不是 ICD-9 E800）', () => {
  assert.equal(parseQuery('696.1').codes[0].kind, 'icd9');
  assert.equal(parseQuery('E800').codes[0].kind, 'cm');
  assert.equal(parseQuery('E800').codes[0].code, 'E80.0');
  assert.equal(parseQuery('9:E800.0').codes[0].kind, 'icd9');
});

t('片語鍵與語序無關（MeSH 倒裝）', () => {
  assert.equal(phraseKey('atopic dermatitis'), phraseKey('Dermatitis, atopic'));
});

t('英式規則不可改壞 angioedema', () => {
  assert.ok(norm('angioedema').includes('angioedema'));
  assert.ok(norm('oedema').includes('edema'));
  assert.equal(norm('haemangioma'), 'hemangioma');
});

t('stem 保守：lupus、diabetes 形式一致', () => {
  assert.equal(stem('lupus'), 'lupus');
  assert.equal(stem('warts'), 'wart');
});

t('facets：側別與就醫階段', () => {
  const f = facetsOf({ en: 'Displaced fracture of right femoral neck, initial encounter', use: 1 });
  assert.equal(f.lat, '右側');
  assert.equal(f.enc, '初次照護');
});

const derm = join(ROOT, 'public/data/derm.json');
if (existsSync(derm)) {
  const d = JSON.parse(readFileSync(derm, 'utf8'));
  const e = new Engine(d.rows, d.vocab);
  const top = (q) => e.search(q, { limit: 5 }).items.map((x) => x.code);
  t('整句 ATM：shingles → B02.9（CDC see 解析）', () => assert.ok(top('shingles').slice(0, 2).includes('B02.9')));
  t('拼字先修正再 ATM：psoraisis → L40', () => assert.ok(top('psoraisis')[0].startsWith('L40')));
  t('子序列優先：hievs → hives（不是 HIV）', () => assert.equal(e.correctText('hievs').text, 'hive'));
  t('angioedema 可查到 T78.3', () => assert.ok(top('angioedema').some((c) => c.startsWith('T78.3'))));
  t('同分時可申報碼優先：乾癬 → L40.9 在 L40 前', () => {
    const r = top('乾癬');
    assert.ok(r.indexOf('L40.9') >= 0 && r.indexOf('L40.9') < r.indexOf('L40'));
  });
  t('中文錯切防呆：異位性皮膚炎 → L20', () => assert.ok(top('異位性皮膚炎')[0].startsWith('L20')));
  t('範圍查詢', () => assert.deepEqual(top('L40.0-L40.4').slice(0, 5), ['L40.0', 'L40.1', 'L40.2', 'L40.3', 'L40.4']));
} else {
  console.log('  － 沒有 public/data（先 make rebuild），略過資料測試');
}
console.log(`✅ ${n} 項通過`);
