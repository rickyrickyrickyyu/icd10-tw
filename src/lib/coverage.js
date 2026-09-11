/**
 * 查詢有多少比例的字元出現在目標文字裡（0–1），用來判斷「查不到的關鍵字」。
 * 分數本身擋不住亂打的查詢：「qwxz怪皮病zz」只靠「皮病」兩字就讓 L94.0 拿到 10.9 分。
 *   中文：對每段做貪婪最長匹配（≥2 字）
 *   英文：整個詞，或去掉最後 2 字母的詞幹（≥6 字母時）出現在目標裡就算
 */
const CJK = /[㐀-鿿]/;

export function queryCoverage(q, target) {
  const low = String(target ?? '').toLowerCase();
  let tot = 0;
  let hit = 0;
  for (const tok of String(q).toLowerCase().split(/[\s,;/()]+/).filter(Boolean)) {
    tot += tok.length;
    if (CJK.test(tok)) {
      let i = 0;
      while (i < tok.length) {
        let j = tok.length;
        while (j - i >= 2 && !low.includes(tok.slice(i, j))) j -= 1;
        if (j - i >= 2) { hit += j - i; i = j; } else i += 1;
      }
    } else {
      const stem = tok.length >= 6 ? tok.slice(0, -2) : tok;
      if (low.includes(stem)) hit += tok.length;
    }
  }
  return tot ? hit / tot : 1;
}
