/**
 * 限定詞 facets（對應 MeSH subheadings）：從英文標題與第 7 碼解析，純規則、可測。
 * 結果頁用它產生篩選 chips；解析不到的碼不歸任何 chip（不硬猜）。
 */
const LAT = [
  [/\bbilateral\b/i, '雙側'],
  [/\bright\b/i, '右側'],
  [/\bleft\b/i, '左側'],
  [/\bunspecified (side|eye|ear|arm|leg|hand|foot|knee|hip|shoulder|elbow|wrist|ankle|thigh|lower leg|upper arm|forearm|finger|toe|kidney|ovary|breast|lung|limb|upper limb|lower limb)\b/i, '未明示側'],
  // 「單側」放最後：M17.11「Unilateral …, right knee」先被 right 判成右側；只有 K40.90 這種不分左右的才是單側
  [/\bunilateral\b/i, '單側'],
];
const ENC = [
  [/\binitial encounter\b/i, '初次照護'],
  [/\bsubsequent encounter\b/i, '後續照護'],
  [/\bsequela\b/i, '後遺症'],
];
const ACU = [
  [/\bacute on chronic\b/i, '慢性急性發作'],
  [/\bacute\b/i, '急性'],
  [/\bchronic\b/i, '慢性'],
  [/\brecurrent\b/i, '復發'],
];
const CMP = [
  [/\bwithout (complication|complications)\b/i, '未伴有併發症'],
  [/\bwith (complication|complications)\b/i, '伴有併發症'],
];

// 骨折（v15 代碼頁快速選碼）：S72.0 選「右側＋初次照護」後仍有 36 碼，差在開放／閉鎖、有無移位
const FX = [
  [/\bopen fracture\b/i, '開放性'],
  [/\bclosed fracture\b/i, '閉鎖性'],
];
const DSP = [
  [/\bnondisplaced\b/i, '無移位'],
  [/\bdisplaced\b/i, '移位'],
];

const first = (rules, s) => rules.find(([re]) => re.test(s))?.[1] ?? null;

export function facetsOf(item) {
  const en = item.en ?? '';
  return {
    use: item.use === 1 ? '可申報' : '標題碼',
    lat: first(LAT, en),
    enc: first(ENC, en),
    acu: first(ACU, en),
    cmp: first(CMP, en),
    fx: first(FX, en),
    dsp: first(DSP, en),
  };
}

export const FACET_LABEL = { use: '申報', lat: '側別', enc: '就醫階段', acu: '病程', cmp: '併發症', fx: '骨折型態', dsp: '移位' };

/** 統計目前結果的各 facet 值 → {key: [[值, 筆數], ...]}，只回傳至少兩個值的 facet。 */
export function facetCounts(items) {
  const out = {};
  for (const it of items) {
    const f = facetsOf(it);
    for (const [k, v] of Object.entries(f)) {
      if (!v) continue;
      out[k] ??= new Map();
      out[k].set(v, (out[k].get(v) ?? 0) + 1);
    }
  }
  return Object.fromEntries(Object.entries(out)
    .filter(([, m]) => m.size >= 2 || [...m.values()][0] < items.length)
    .map(([k, m]) => [k, [...m.entries()].sort((a, b) => b[1] - a[1])]));
}

export function applyFacets(items, sel) {
  const keys = Object.entries(sel).filter(([, v]) => v);
  if (!keys.length) return items;
  return items.filter((it) => { const f = facetsOf(it); return keys.every(([k, v]) => f[k] === v); });
}
