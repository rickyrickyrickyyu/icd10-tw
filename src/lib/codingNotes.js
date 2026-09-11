/**
 * 撰碼規則（CDC Tabular 的 Code first／Use additional code／Code also／Excludes1）的純函式。
 * 資料在 nodes/<首字母>.json 的 n；上層類目的規則適用於所有下層碼，所以要沿祖先鏈合併。
 * 不依賴瀏覽器（node 測試直接 import），載入分片由呼叫端負責。
 */

// 結尾的「-」（E08.- 表示整個類目）只在後面不是另一個碼時才算碼的一部分，
// 否則「N18.1-N18.6」的連字號會被第一個碼吃掉，範圍變成兩個單碼。
const CODE = String.raw`[A-Z]\d[0-9A-Z](?:\.[0-9A-Z]{0,4})?(?:-(?!\s*[A-Z]\d))?`;
const SPEC = new RegExp(`(${CODE})(?:\\s*-\\s*(${CODE}))?`, 'g');

const clean = (c) => c.replace(/\.?-$/, '').replace(/\.$/, '');

/**
 * 從規則文字抽出碼的範圍。只看括號內（CDC 慣例把碼寫在括號裡），避免把「T1D」這類詞當碼。
 *   "(N18.1-N18.6)" → [{from:'N18.1', to:'N18.6'}]
 *   "(E08.-)"       → [{prefix:'E08'}]
 *   "(C00-C96)"     → [{from:'C00', to:'C96'}]
 *   "(Z79.4)"       → [{prefix:'Z79.4'}]
 */
export function codesIn(text) {
  const out = [];
  for (const [, inner] of String(text).matchAll(/\(([^()]*)\)/g)) {
    for (const m of inner.matchAll(SPEC)) {
      if (m[2]) out.push({ from: clean(m[1]), to: clean(m[2]) });
      else out.push({ prefix: clean(m[1]) });
    }
  }
  return out;
}

export function matches(code, spec) {
  if (spec.prefix) return code.startsWith(spec.prefix);
  return code >= spec.from && (code <= spec.to || code.startsWith(spec.to));
}

/** 本碼＋所有祖先（L40.51 → L40.51、L40.5、L40）。 */
export function lineage(code) {
  const out = [code];
  let x = code;
  while (x.length > 3) {
    x = x.slice(0, -1).replace(/\.$/, '');
    out.push(x);
  }
  return out;
}

export const NOTE_KEYS = ['codeFirst', 'useAdd', 'codeAlso', 'excl1'];

/**
 * 合併本碼與祖先的規則 → {codeFirst:[{text, from, specs}], useAdd, codeAlso, excl1}。
 * 「code to identify control using:」這種引言行本身沒有碼，後面的清單行才有 —— 兩者都保留，
 * 顯示時把引言接在第一個清單行前面。
 */
export function mergeNotes(code, nodes) {
  const out = Object.fromEntries(NOTE_KEYS.map((k) => [k, []]));
  for (const c of lineage(code)) {
    const n = nodes?.[c]?.n;
    if (!n) continue;
    for (const k of NOTE_KEYS) {
      for (const text of n[k] ?? []) out[k].push({ text, from: c, specs: codesIn(text) });
    }
  }
  return out;
}

/**
 * 提醒行（複製時的 toast、批次頁）：只取 codeFirst／useAdd／codeAlso。
 * 「code to identify control using:」這種引言與其後的清單項併成**一行**
 * （E11 的 insulin／oral antidiabetic／oral hypoglycemic 原本拆三行，toast 只顯示 3 行時
 *  會把本碼自己更重要的「CKD 分期 (N18.1-N18.6)」擠掉）。
 */
export function reminders(notes) {
  const LABEL = { codeFirst: '須先編', useAdd: '須另加編碼', codeAlso: '亦編' };
  const out = [];
  for (const k of ['codeFirst', 'useAdd', 'codeAlso']) {
    let group = null;
    for (const x of notes[k]) {
      if (!x.specs.length && /:\s*$/.test(x.text)) {
        // 引言行：後面同一個來源碼的清單項都併進來
        group = { kind: k, label: LABEL[k], lead: x.text.replace(/:\s*$/, ''), from: x.from, items: [], specs: [] };
        out.push(group);
        continue;
      }
      if (group && x.from === group.from) {
        group.items.push(x.text);
        group.specs.push(...x.specs);
        continue;
      }
      group = null;
      out.push({ kind: k, label: LABEL[k], text: x.text, specs: x.specs });
    }
  }
  return out
    .filter((r) => !r.items || r.items.length)
    .map((r) => (r.items ? { kind: r.kind, label: r.label, text: `${r.lead}：${r.items.join('／')}`, specs: r.specs } : r));
}

/** 提醒行要求的碼是否已在清單裡（批次頁「已包含」）。 */
export function satisfied(rem, codes) {
  return rem.specs.length > 0 && codes.some((c) => rem.specs.some((s) => matches(c, s)));
}

/**
 * Excludes1 衝突：a 的 Excludes1 範圍包含 b（或反之）→ 依規定不可同時編。
 * notesOf: code → mergeNotes 結果。回傳 [{a, b, text}]，每對只報一次。
 */
export function excludes1Conflicts(codes, notesOf) {
  const out = [];
  for (let i = 0; i < codes.length; i += 1) {
    for (let j = i + 1; j < codes.length; j += 1) {
      const [a, b] = [codes[i], codes[j]];
      const hit = (x, y) => notesOf(x)?.excl1.find((e) => e.specs.some((s) => matches(y, s)));
      const e = hit(a, b) ?? hit(b, a);
      if (e) out.push({ a, b, text: e.text });
    }
  }
  return out;
}
