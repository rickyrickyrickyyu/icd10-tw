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
import { codesIn, excludes1Conflicts, matches, mergeNotes, reminders } from '../src/lib/codingNotes.js';
import { parseLines } from '../src/lib/batch.js';
import { queryCoverage } from '../src/lib/coverage.js';

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
  assert.equal(f.dsp, '移位');
  const g = facetsOf({ en: 'Nondisplaced fracture of neck of left femur, initial encounter for open fracture type I or II', use: 1 });
  assert.equal(g.dsp, '無移位');
  assert.equal(g.fx, '開放性');
  assert.equal(g.lat, '左側');
});

t('撰碼規則：只抽括號內的碼與範圍', () => {
  assert.deepEqual(codesIn('code to identify stage of chronic kidney disease (N18.1-N18.6)'), [{ from: 'N18.1', to: 'N18.6' }]);
  assert.deepEqual(codesIn('type 1 diabetes mellitus (E10.-)'), [{ prefix: 'E10' }]);
  assert.deepEqual(codesIn('T1D without parentheses'), []);
  assert.ok(matches('N18.30', { from: 'N18.1', to: 'N18.6' }));
  assert.ok(!matches('N18.9', { from: 'N18.1', to: 'N18.6' }));
  assert.ok(matches('C96.4', { from: 'C00', to: 'C96' }));
});

t('查不到的關鍵字：看覆蓋率不看分數（亂打的「qwxz怪皮病zz」L94.0 有 10.9 分）', () => {
  assert.ok(queryCoverage('qwxz怪皮病zz', '局限性硬皮病 Localized scleroderma [morphea]') < 0.5);
  assert.ok(queryCoverage('cellulitis of leg', '肢體其他部位蜂窩組織炎 Cellulitis of other parts of limb') >= 0.5);
  assert.equal(queryCoverage('異位性皮膚炎', '異位性皮膚炎 Atopic dermatitis'), 1);
});

t('批次查碼切行：編號、Dx:、r/o、分號', () => {
  const r = parseLines('1. Type 2 DM\n2) r/o cellulitis of left leg；③ 異位性皮膚炎\nDx: L400\n\n');
  assert.deepEqual(r.map((x) => x.text), ['Type 2 DM', 'cellulitis of left leg', '異位性皮膚炎', 'L400']);
  assert.equal(r[1].tag, 'r/o');
  assert.equal(parseLines('250.00')[0].text, '250.00');
});

const cmPath = join(ROOT, 'public/data/cm.json');
const nodesE = join(ROOT, 'public/data/nodes/E.json');
if (existsSync(nodesE)) {
  const nodes = JSON.parse(readFileSync(nodesE, 'utf8'));
  const of = (c) => mergeNotes(c, nodes);
  t('E11.22 須另加 N18.1-N18.6（CKD 分期）；E11 的用藥清單併成一行', () => {
    const rs = reminders(of('E11.22')).filter((x) => x.kind === 'useAdd');
    assert.ok(rs[0].specs.some((s) => s.from === 'N18.1'), '本碼自己的規則排第一');
    assert.equal(rs.length, 2);
    assert.ok(rs[1].text.includes('insulin (Z79.4)') && rs[1].text.includes('oral antidiabetic drugs (Z79.84)'));
  });
  t('E11.9＋E10.9 依 Excludes1 衝突；E11.9＋I10 不衝突', () => {
    assert.equal(excludes1Conflicts(['E11.9', 'E10.9'], of).length, 1);
    assert.equal(excludes1Conflicts(['E11.9', 'I10'], of).length, 0);
  });
}

// v15 起網站與 CLI 一律查全庫 → 測試也用全庫（v14 以前用皮膚科子集）
if (existsSync(cmPath)) {
  const e = new Engine(JSON.parse(readFileSync(cmPath, 'utf8')).rows, JSON.parse(readFileSync(join(ROOT, 'public/data/vocab_cm.json'), 'utf8')));
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
  t('全庫：非皮膚科疾病第 1 名正確（v14 以前在皮膚科子集 heart failure → A52.06 梅毒）', () => {
    assert.ok(top('heart failure')[0].startsWith('I50'));
    assert.ok(top('三叉神經痛')[0].startsWith('G50.0'));
  });
} else {
  console.log('  － 沒有 public/data（先 make rebuild），略過資料測試');
}
console.log(`✅ ${n} 項通過`);
