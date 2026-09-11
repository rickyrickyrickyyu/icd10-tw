/**
 * 把查詢詞在名稱裡標亮，眼睛直接落在「為什麼是這筆」。
 * 英文：以空白切詞，≥2 字元、不分大小寫子字串比對。
 * 中文：沒有空白，對每段 CJK 做貪婪最長匹配（≥2 字），例：「糖尿病腎病變」在
 *       「第二型糖尿病伴有糖尿病腎病變」裡整段標亮；「左膝骨關節炎」→ 標「骨關節炎」。
 */
const CJK = /[㐀-鿿]/;

function ranges(text, q) {
  if (!text || !q) return [];
  const low = text.toLowerCase();
  const out = [];
  for (const tok of q.toLowerCase().split(/[\s,;/]+/).filter(Boolean)) {
    if (CJK.test(tok)) {
      let i = 0;
      while (i < tok.length - 1) {
        let j = tok.length;
        while (j - i >= 2 && !low.includes(tok.slice(i, j))) j -= 1;
        if (j - i >= 2) {
          const sub = tok.slice(i, j);
          for (let k = low.indexOf(sub); k >= 0; k = low.indexOf(sub, k + sub.length)) out.push([k, k + sub.length]);
          i = j;
        } else i += 1;
      }
    } else if (tok.length >= 2) {
      const t = tok.replace(/[^\w.-]/g, '');
      if (t.length < 2) continue;
      for (let k = low.indexOf(t); k >= 0; k = low.indexOf(t, k + t.length)) out.push([k, k + t.length]);
    }
  }
  out.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const r of out) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r]);
  }
  return merged;
}

export default function Hl({ text, q }) {
  const rs = ranges(text, q);
  if (!rs.length) return text;
  const parts = [];
  let p = 0;
  for (const [a, b] of rs) {
    if (a > p) parts.push(text.slice(p, a));
    parts.push(<mark key={a} className="bg-amber-100 text-inherit rounded-sm px-px">{text.slice(a, b)}</mark>);
    p = b;
  }
  if (p < text.length) parts.push(text.slice(p));
  return parts;
}
