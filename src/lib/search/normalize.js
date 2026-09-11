/**
 * 查詢與文件共用的正規化。瀏覽器、CLI（node）、基準測試都 import 這一份 ——
 * 搜尋只有一份實作，索引端與查詢端不可能走鐘。
 *
 * 規則（改任何一條都要跑 pnpm bench，看各題組有沒有掉分）：
 *   1. NFKC + 小寫：全形英數、相容字統一。
 *   2. 中文異體字小表：臺→台 等，使用者兩種都會打。
 *   3. 英式拼法 → 美式：CDC/NHI 英文名全是美式，使用者（尤其讀英國教科書的）會打英式。
 *   4. 英文輕量 stemmer：只處理複數與所有格，保守 —— 過度 stem 會把 lupus/lupi 以外的詞弄壞。
 *   5. 中文切字元 bigram：中文沒有空格，bigram 讓「膝 退化 關節炎」命中「膝部…骨關節炎」。
 */

const ZH_VARIANT = {
  臺: '台', 裏: '裡', 着: '著', 綫: '線', 峯: '峰', 衞: '衛', 爲: '為', 啓: '啟',
  痺: '痹', 疱: '皰', 菸: '煙', 麪: '麵', 羣: '群', 歎: '嘆', 眞: '真', 脣: '唇',
};
const ZH_VARIANT_RE = new RegExp(`[${Object.keys(ZH_VARIANT).join('')}]`, 'g');

// 英式 → 美式（只列醫學常見；順序有關，長的在前）
const BRIT = [
  [/oesophag/g, 'esophag'], [/haemorrh/g, 'hemorrh'], [/haemat/g, 'hemat'], [/haem/g, 'hem'],
  [/anaem/g, 'anem'], [/aemia/g, 'emia'], [/leukaem/g, 'leukem'], [/paediatr/g, 'pediatr'],
  // ★ (?<!angi)：美式拼法 angioedema 本身就含 "oedema"，v4 以前被改成 "angiedema"，
  //   索引裡沒有 angioedema 這個詞，打對打錯都查不到 T78.3。
  [/paed/g, 'ped'], [/(?<!angi)oedema/g, 'edema'], [/foet/g, 'fet'], [/tumour/g, 'tumor'],
  [/colour/g, 'color'], [/behaviour/g, 'behavior'], [/diarrhoea/g, 'diarrhea'],
  [/gynaecol/g, 'gynecol'], [/orthopaed/g, 'orthoped'], [/ischaem/g, 'ischem'],
  [/coeliac/g, 'celiac'], [/caesarean/g, 'cesarean'], [/aetiolog/g, 'etiolog'],
  [/sulph/g, 'sulf'], [/fibre/g, 'fiber'], [/centre/g, 'center'], [/litre/g, 'liter'],
];

const STOP = new Set(['of', 'the', 'a', 'an', 'and', 'or', 'in', 'on', 'to', 'by', 'for', 'as',
  'at', 'from', 'into', 'nos', 'nec']);

export const CJK = /[㐀-鿿豈-﫿]/;
const CJK_RUN = /[㐀-鿿豈-﫿]+/g;

export function norm(s) {
  if (!s) return '';
  let t = s.normalize('NFKC').toLowerCase().replace(ZH_VARIANT_RE, (c) => ZH_VARIANT[c]);
  t = t.replace(/['’]s\b/g, '');                       // athlete's → athlete
  for (const [re, to] of BRIT) t = t.replace(re, to);
  // 中文標點、英文標點 → 空白；保留代碼裡的點（L40.0）交給 query.js 先處理
  t = t.replace(/[^\p{L}\p{N}\s.]/gu, ' ').replace(/(?<!\d)\.|\.(?!\d)/g, ' ');
  return t.replace(/\s+/g, ' ').trim();
}

export function stem(w) {
  if (w.length <= 3 || /\d/.test(w)) return w;
  if (w.endsWith('ies') && w.length > 4) return `${w.slice(0, -3)}y`;
  if (/(ss|us|is|as|os)$/.test(w)) return w;
  if (w.endsWith('es') && /(ch|sh|x|z)es$/.test(w)) return w.slice(0, -2);
  if (w.endsWith('s')) return w.slice(0, -1);
  return w;
}

/** 英文詞（stem 後、去停用詞）與中文連續字串。 */
export function parts(s) {
  const t = norm(s);
  const en = [];
  const zh = [];
  for (const raw of t.split(' ')) {
    if (!raw) continue;
    if (CJK.test(raw)) {
      // 中英混在同一段（"HSV感染"）：拆開
      for (const m of raw.matchAll(CJK_RUN)) zh.push(m[0]);
      for (const w of raw.replace(CJK_RUN, ' ').split(' ')) {
        if (w && !STOP.has(w)) en.push(stem(w));
      }
    } else if (!STOP.has(raw)) {
      en.push(stem(raw));
    }
  }
  return { en, zh };
}

export function bigrams(run) {
  if (run.length < 2) return [run];
  const out = [];
  for (let i = 0; i < run.length - 1; i += 1) out.push(run.slice(i, i + 2));
  return out;
}

/** 由 parts() 結果產生 token（建索引時同一字串只正規化一次）。 */
export function tokensOf({ en, zh }) {
  const out = [...en];
  for (const r of zh) out.push(...bigrams(r));
  return out;
}

/** 由 parts() 結果產生片語鍵。 */
export function keyOf({ en, zh }) {
  return [...new Set([...en, ...zh])].sort().join(' ');
}

/** 索引／查詢用 token：英文詞 + 中文 bigram。 */
export function tokens(s) {
  return tokensOf(parts(s));
}

/**
 * 片語鍵：與語序無關的「詞集合」。ATM 用它做入口詞精確比對，
 * 所以 "atopic dermatitis" 與 "Dermatitis, atopic" 是同一個鍵。
 * 中文段不拆 bigram，整段當一個詞（中文語序本身有意義）。
 */
export function phraseKey(s) {
  return keyOf(parts(s));
}
