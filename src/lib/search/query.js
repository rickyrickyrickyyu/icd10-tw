/**
 * 查詢語法與代碼偵測。
 *
 * 語法（輕量，仿 PubMed）：
 *   空白隔開 = AND        -詞 = 排除        "片語" = 必須連續出現
 *   [mh] 只看主題對應    [noexp] 不 explode   [code] 只查代碼
 *   9:696.1  強制 ICD-9   14:L400  強制 2014 舊碼
 *
 * ★ ICD-9 不進主索引：ICD-9 的 V/E 碼與 ICD-10 同形（E800.0 是 ICD-9 的鐵路事故，
 *   ICD-10 的 E80.0 無點寫法也是 E800）。只有「純數字加點」或明確前綴才判成 ICD-9。
 */

const RE_CM = /^([A-Z])(\d)([0-9A-Z])(?:\.?([0-9A-Z]{1,4}))?$/;
const RE_PCS = /^[0-9A-HJ-NP-Z]{7}$/;
const RE_ICD9 = /^(\d{3})(?:\.(\d{1,2}))?$|^(\d{2})\.(\d{1,2})$/;   // 診斷 696.1 / 處置 86.3

export function cmCode(s) {
  const t = s.trim().toUpperCase().replace(/\s+/g, '');
  const m = t.match(RE_CM);
  if (!m) return null;
  return m[4] ? `${m[1]}${m[2]}${m[3]}.${m[4]}` : `${m[1]}${m[2]}${m[3]}`;
}

export function parseQuery(raw) {
  let q = (raw ?? '').trim();
  const flags = { mh: false, noexp: false, code: false, ns: null };
  q = q.replace(/\[(mh|noexp|code)\]/gi, (_, f) => { flags[f.toLowerCase()] = true; return ' '; });
  const ns = q.match(/^(9|14)\s*:\s*/);
  if (ns) { flags.ns = ns[1] === '9' ? 'icd9' : 'icd14'; q = q.slice(ns[0].length); }

  const phrases = [];
  q = q.replace(/"([^"]+)"/g, (_, p) => { phrases.push(p); return ` ${p} `; });
  const neg = [];
  q = q.replace(/(^|\s)-(\S+)/g, (_, sp, w) => { neg.push(w); return sp; });
  q = q.replace(/\s+/g, ' ').trim();

  // 代碼偵測：整串或任一段像代碼
  const codes = [];
  const range = q.toUpperCase().match(/^([A-Z]\d[0-9A-Z](?:\.?[0-9A-Z]{1,4})?)\s*[-–~]\s*([A-Z]\d[0-9A-Z](?:\.?[0-9A-Z]{1,4})?)$/);
  let rest = q;
  if (range) {
    codes.push({ kind: 'range', from: cmCode(range[1]), to: cmCode(range[2]) });
    rest = '';
  } else if (flags.ns === 'icd9' || (RE_ICD9.test(q) && !/[A-Za-z]/.test(q))) {
    codes.push({ kind: 'icd9', code: q });
    rest = '';
  } else {
    const keep = [];
    for (const w of q.split(' ')) {
      const c = cmCode(w);
      if (c && /\d/.test(w)) codes.push({ kind: flags.ns === 'icd14' ? 'icd14' : 'cm', code: c, raw: w });
      else if (RE_PCS.test(w.toUpperCase()) && /\d/.test(w)) codes.push({ kind: 'pcs', code: w.toUpperCase() });
      else keep.push(w);
    }
    rest = keep.join(' ');
  }
  return { text: rest, codes, phrases, neg, flags };
}
