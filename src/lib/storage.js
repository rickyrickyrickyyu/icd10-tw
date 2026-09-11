/**
 * 版本化 localStorage：常用碼、最近查詢、最近用過的碼、查不到的關鍵字。寫入失敗靜默忽略
 * （私密模式、空間不足、瀏覽器封鎖站點資料時 accessor 本身會丟例外）。
 *
 * ⚠️ 只存代碼與查詢字串，不存任何病人資訊（批次查碼貼上的文字不寫入這裡）。
 *    iOS Safari 對未加入主畫面的網站，7 天未互動會清 localStorage —— 這類便利資料丟了可以接受。
 */
const KEY = 'icd10-tw.prefs.v1';
const arr = (v) => (Array.isArray(v) ? v : []);

function read() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    return v && typeof v === 'object'
      ? { fav: arr(v.fav), recent: arr(v.recent), used: arr(v.used).filter((x) => x?.c), misses: arr(v.misses) }
      : { fav: [], recent: [], used: [], misses: [] };
  } catch {
    return { fav: [], recent: [], used: [], misses: [] };
  }
}

function write(state) {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* 靜默 */ }
}

export const getPrefs = read;

export function toggleFav(code) {
  const s = read();
  s.fav = s.fav.includes(code) ? s.fav.filter((c) => c !== code) : [code, ...s.fav].slice(0, 200);
  write(s);
  return s;
}

/** 常用碼跨裝置搬移：合併（保留原有順序，新碼接在後面），回傳新增幾個。 */
export function importFav(codes) {
  const s = read();
  const add = codes.filter((c) => !s.fav.includes(c));
  s.fav = [...s.fav, ...add].slice(0, 200);
  write(s);
  return add.length;
}

export function addFavs(codes) {
  return importFav(codes);
}

/**
 * 最近用過的碼（複製過或開過可申報碼的詳細頁）：醫師重複用的碼很集中，
 * 搜尋框空白聚焦時直接列出，不必每次重打。連名稱一起存，下拉清單不必等分片載入。
 */
export function pushUsed(c, zh = '', en = '', pcs = false) {
  if (!c) return read();
  const s = read();
  s.used = [{ c, zh, en, ...(pcs ? { p: 1 } : {}) }, ...s.used.filter((x) => x.c !== c)].slice(0, 12);
  write(s);
  return s;
}

export function pushRecent(q) {
  const t = q.trim();
  if (!t) return read();
  const s = read();
  s.recent = [t, ...s.recent.filter((x) => x !== t)].slice(0, 12);
  write(s);
  return s;
}

/**
 * 查不到（或結果不可信）的關鍵字：只存在這台裝置，「關於」頁可複製給維護者，
 * 用來補俗稱與同義詞。不上傳任何地方。
 */
export function pushMiss(q) {
  const t = q.trim();
  if (!t || t.length > 80) return read();
  const s = read();
  s.misses = [t, ...s.misses.filter((x) => x !== t)].slice(0, 50);
  write(s);
  return s;
}

export function clearMisses() {
  const s = read();
  s.misses = [];
  write(s);
  return s;
}
