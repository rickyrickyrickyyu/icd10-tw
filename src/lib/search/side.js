/**
 * 側別與部位（v16）：醫師會打「右膝退化性關節炎」「cellulitis of left leg」，正解是
 * 側別＋部位都對的可申報最末碼（M17.11、L03.116），不是標題碼或「未明示側」。
 * v15 實測：precise 題組 Hit@1 只有 47%（左小腿蜂窩性組織炎 → L03.90、右膝 → M47 退化性脊椎炎）。
 *
 * ★ 中文的「左／右／雙」後面要接部位字才算側別：「雙極性情感疾患」「左心室肥大」「右束支」不是側別。
 */

// 部位字（接在左／右／雙後面才算側別）
const ZH_SITE_CH = '膝腳腿手臂眼耳肺腎乳肩髖踝腕肘足趾指腋小大上下頸胸背臀股脛腓鎖肱橈尺跟';
const ZH_SIDE = new RegExp(`(雙|兩|左|右)(側|邊)|(雙|兩|左|右)(?=[${ZH_SITE_CH}])`, 'g');
const EN_SIDE = /\b(bilateral|both|bilat|left|lt|right|rt)\b/gi;

const zhLat = (ch) => (ch === '左' ? '左側' : ch === '右' ? '右側' : '雙側');
const enLat = (w) => (/^(left|lt)$/i.test(w) ? '左側' : /^(right|rt)$/i.test(w) ? '右側' : '雙側');

/**
 * 部位：q＝查詢端，zh／en＝碼的官方名稱端。任一部位對上就算部位相符。
 * 只收肢體與成對器官（側別只對這些有意義）；鎖骨、橈骨這類細部交給 BM25。
 */
export const SITES = [
  { q: /\b(legs?|calf|shin|thighs?)\b|小腿|大腿|下肢|腿|腳(?![趾跟踝掌底])/i, zh: /下肢|小腿|大腿|腿/, en: /\blower (limb|extremit|leg)|\blegs?\b|\bthigh\b/i },
  { q: /\b(arms?|forearm)\b|\bupper (limb|extremity)\b|手臂|上肢|前臂/i, zh: /上肢|手臂|前臂/, en: /\bupper (limb|extremit|arm)|\barm\b|forearm/i },
  { q: /\baxilla(ry)?\b|腋/i, zh: /腋/, en: /axilla/i },
  { q: /\bknees?\b|膝/i, zh: /膝/, en: /\bknee/i },
  // 髖部骨折在 ICD 是「股骨頸」（S72.0-，名稱沒有 hip）→ 髖也接受 femur／股骨（v16 fresh4：right hip fracture）
  { q: /\bhips?\b|髖/i, zh: /髖|股骨/, en: /\bhip\b|femur|femoral/i },
  { q: /\bshoulders?\b|肩/i, zh: /肩/, en: /shoulder/i },
  { q: /\belbows?\b|肘/i, zh: /肘/, en: /elbow/i },
  { q: /\bwrists?\b|腕/i, zh: /腕/, en: /wrist/i },
  { q: /\bankles?\b|踝/i, zh: /踝/, en: /ankle/i },
  // 手、足也接受「上肢／下肢」：ICD 的手部、足部蜂窩組織炎歸在 L03.11-「上肢／下肢」
  // （v16 第五批新題：right foot cellulitis 原本因名稱沒有 foot 被濾掉）
  { q: /\bhands?\b|手(?![臂指術])/i, zh: /手部|手(?![臂指])|上肢/, en: /\bhand\b|upper (limb|extremit)/i },
  { q: /\b(foot|feet)\b|足(?!跟)/i, zh: /足|下肢/, en: /\bfoot\b|lower (limb|extremit)/i },
  { q: /\beyes?\b|眼/i, zh: /眼/, en: /\beye\b/i },
  { q: /\bears?\b|耳/i, zh: /耳/, en: /\bear\b/i },
  { q: /\bbreasts?\b|乳(?!糜)/i, zh: /乳/, en: /breast/i },
  { q: /\blungs?\b|肺/i, zh: /肺/, en: /lung/i },
  // 手指、腳趾：主要用來判斷「部位衝突」（問手臂卻是手指 → 大幅降）
  { q: /\b(fingers?|thumbs?)\b|手指|拇指/i, zh: /指(?!甲)/, en: /finger|thumb/i },
  { q: /\btoes?\b|趾/i, zh: /趾/, en: /\btoes?\b/i },
];

/**
 * 同類目挑碼時的預設（醫師沒講就不要選的細分）：
 * 乳癌沒寫男性 → 不選男性乳房（「female breast」不會被 \bmale 誤中）。
 */
export const AVOID = [
  { unless: /\bmale\b|男/i, en: /\bmale breast/i },
  // 沒講近端／遠端就不要選近端／遠端細分（DVT of right leg → I82.401，不是 I82.4Y1 近端）
  { unless: /\b(proximal|distal)\b|近端|遠端/i, en: /\b(proximal|distal)\b/i },
  // 骨折預設是外傷性：沒寫病理性／壓力性／骨質疏鬆就不要選 M84 病理性骨折（v16 fresh4：right hip fracture）
  { unless: /patholog|病理|stress|壓力性|疲勞性|osteopor|骨質疏鬆|neoplas|腫瘤/i, en: /pathological fracture|stress fracture/i },
];

/**
 * 細部提示：醫師用語 ↔ ICD 官方用語不同（distal radius ↔ lower end of radius）。
 * 同類目挑碼時，名稱符合提示者加分（v16：right distal radius fracture 原本挑到骨幹 S52.301A）。
 */
export const HINTS = [
  { q: /\bdistal\b|遠端/i, zh: /下端|遠端/, en: /lower end|distal/i },
  { q: /\bproximal\b|近端/i, zh: /上端|近端/, en: /upper end|proximal/i },
  { q: /\bshaft\b|骨幹/i, zh: /骨幹/, en: /shaft/i },
];

// 形容詞 → 官方名詞（只影響 ATM 用的 strip 字串）：「axillary abscess」要對到入口詞「Abscess, axilla」
const ADJ = [[/\baxillary\b/gi, 'axilla']];

/**
 * 從查詢抽出側別與部位。沒有側別 → null（不動任何排序）。
 * strip：去掉側別字的查詢（給 ATM 用，「cellulitis of left leg」→「cellulitis of leg」才對得到入口詞）
 */
export function sideOf(text) {
  const t = String(text);
  let lat = null;
  let strip = t;
  const zh = [...t.matchAll(ZH_SIDE)];
  const en = [...t.matchAll(EN_SIDE)];
  // 同一句同時有左與右（「左側眼失明，右側眼低視力」）→ 側別各有所指，不套用（保留集實測會挑反）
  const lats = new Set([...zh.map((m) => zhLat(m[1] ?? m[3])), ...en.map((m) => enLat(m[1]))]);
  if (lats.has('左側') && lats.has('右側')) return null;
  if (zh.length) {
    lat = zhLat(zh[0][1] ?? zh[0][3]);
    strip = strip.replace(ZH_SIDE, '');
    // 側別後面的部位字若在後文重複出現就一起去掉：「左耳外耳炎」→「外耳炎」才對得到主題
    // （「右膝退化性關節炎」的膝後文沒有 → 保留「膝退化性關節炎」，部位資訊不能丟）
    const m = strip.match(new RegExp(`^([${ZH_SITE_CH}])(.+)$`));
    if (m && m[2].includes(m[1])) strip = m[2];
  }
  if (en.length) {
    lat = lat ?? enLat(en[0][1]);
    strip = strip.replace(EN_SIDE, ' ');
  }
  if (!lat) return null;
  for (const [re, to] of ADJ) strip = strip.replace(re, to);
  strip = strip.replace(/\s+/g, ' ').replace(/\b(of|the|on|side|sided)\s*$/i, '').trim();
  const sites = SITES.filter((s) => s.q.test(t));
  return {
    lat,
    strip: strip || t,
    sites,
    hints: HINTS.filter((h) => h.q.test(t)),
    avoid: AVOID.filter((a) => !a.unless.test(t)),
    later: /subsequent|sequela|後續|後遺症/i.test(t),   // 查詢自己講了後續照護／後遺症才不降
    open: /\bopen\b|開放性/i.test(t),                     // 沒講開放性 → 預設閉鎖性
    fbody: /foreign|異物/i.test(t),                       // 沒講異物 → 撕裂傷預設「未伴有異物」
  };
}

/** 碼的官方名稱是否符合查詢裡的任一部位（查詢沒有部位 → 一律 true）。 */
export function siteOk(side, zh, en) {
  return !side.sites.length || side.sites.some((s) => s.zh.test(zh) || s.en.test(en));
}

/** 碼的名稱是「另一個」部位（問手臂、名稱卻是手指）→ 比單純對不上更該降。 */
export function siteConflict(side, zh, en) {
  return side.sites.length > 0 && SITES.some((s) => !side.sites.includes(s) && (s.zh.test(zh) || s.en.test(en)));
}
