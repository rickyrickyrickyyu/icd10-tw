/**
 * 批次查碼的切行（純函式，node 測試直接 import）。完全不用 LLM：切好的每一行交給 Engine.search。
 *
 *   "1. Type 2 DM\n2) r/o cellulitis；③ 異位性皮膚炎\nDx: L400"
 *   → [{text:'Type 2 DM'}, {text:'cellulitis', tag:'r/o'}, {text:'異位性皮膚炎'}, {text:'L400'}]
 */
const LEAD = /^\s*(?:(?:\(\d{1,2}\)|\d{1,2}[.)、]|[①-⑳]|[-•*·‧])\s*)+/;
const DX = /^(?:dx|diagnos[ie]s|impression|診斷)\s*[:：]\s*/i;
const TAG = /^(r\/o|s\/p|suspect(?:ed)?|疑似)\s*[:：]?\s*/i;

export function parseLines(text) {
  const out = [];
  for (const raw of String(text).split(/\r?\n|[;；]/)) {
    let t = raw.trim();
    if (!t) continue;
    t = t.replace(DX, '').replace(LEAD, '').replace(DX, '');
    let tag = null;
    const m = t.match(TAG);
    if (m) {
      tag = /^s\/p/i.test(m[1]) ? 's/p' : 'r/o';
      t = t.slice(m[0].length);
    }
    t = t.trim();
    if (t) out.push({ raw: raw.trim(), text: t, tag });
  }
  return out.slice(0, 60);
}
