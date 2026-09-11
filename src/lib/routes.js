/** 極簡 hash router（GitHub Pages 沒有 SPA fallback，BrowserRouter 重整必 404）。 */
import { useEffect, useState } from 'react';

export function parseHash(h = window.location.hash) {
  const path = h.replace(/^#\/?/, '');
  const [kind, ...rest] = path.split('/');
  const arg = decodeURIComponent(rest.join('/'));
  switch (kind) {
    case 'q': return { view: 'search', q: arg };
    case 'h': return { view: 'heading', key: arg };       // 主題頁（MeSH Descriptor 式）
    case 'c': return { view: 'code', key: arg };          // CM 碼詳細頁
    case 'p': return { view: 'pcs', key: arg };
    case 'm14': return { view: 'map14', key: arg };       // 2014 舊碼
    case 'm9': return { view: 'map9', key: arg };         // ICD-9
    case 'cat': return { view: 'cat', key: arg };         // 重大傷病類別
    case 'changes': return { view: 'changes' };
    case 'about': return { view: 'about' };
    case 'fav': return { view: 'fav' };
    case 'derm': return { view: 'derm', key: arg };       // 皮膚科常用碼清單（key = 類別序號，捲動到該類）
    case 'batch': return { view: 'batch' };               // 批次貼上查碼（純本機）
    default: return { view: 'home' };
  }
}

export function useHashRoute() {
  const [route, setRoute] = useState(() => parseHash());
  useEffect(() => {
    const on = () => setRoute(parseHash());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

export const go = (hash) => { window.location.hash = hash; };
export const href = {
  q: (s) => `#/q/${encodeURIComponent(s)}`,
  h: (c) => `#/h/${encodeURIComponent(c)}`,
  c: (c) => `#/c/${encodeURIComponent(c)}`,
  p: (c) => `#/p/${encodeURIComponent(c)}`,
  m14: (c) => `#/m14/${encodeURIComponent(c)}`,
  m9: (c) => `#/m9/${encodeURIComponent(c)}`,
  cat: (n) => `#/cat/${n}`,
};
