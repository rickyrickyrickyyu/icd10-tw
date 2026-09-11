/**
 * 版本化 localStorage：常用碼、最近查詢。寫入失敗靜默忽略（私密模式、空間不足、
 * 瀏覽器封鎖站點資料時 accessor 本身會丟例外）。
 *
 * ⚠️ 只存代碼與查詢字串，不存任何病人資訊。iOS Safari 對未加入主畫面的網站，
 *    7 天未互動會清 localStorage —— 這類便利資料丟了可以接受。
 */
const KEY = 'icd10-tw.prefs.v1';

function read() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    return v && typeof v === 'object'
      ? { fav: v.fav ?? [], recent: v.recent ?? [], used: Array.isArray(v.used) ? v.used.filter((x) => x?.c) : [] }
      : { fav: [], recent: [], used: [] };
  } catch {
    return { fav: [], recent: [], used: [] };
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
