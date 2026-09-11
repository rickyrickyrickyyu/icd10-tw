import { useEffect, useMemo, useRef, useState } from 'react';
import { go, href } from '../lib/routes.js';
import { getPrefs } from '../lib/storage.js';
import { copyCode } from '../lib/clip.js';
import { SRC_LABEL } from './labels.js';
import Hl from './Hl.jsx';

const LIMIT = 8;

/**
 * 搜尋框＋自動完成（仿 MeSH Browser）。為了讓醫師最少步驟拿到碼：
 * - 每列中文＋英文（同名碼如 L20／L20.9「異位性皮膚炎」靠英文 unspecified 才分得出來）
 * - 查詢詞標亮、標題碼（不可申報）灰色＋標記、★ 預設碼、常用碼標記
 * - 每列「複製」不必進詳細頁；⌘/Ctrl+Enter 複製選取列、Alt/Option+1–8 複製第 N 列
 *   （不用純數字鍵：代碼本身有數字，會跟打 L40.0 衝突）
 * - 空白聚焦：最近用過的碼；沒有就列皮膚科常用碼第一類。任何頁面按「/」回搜尋框
 */
export default function SearchBar({ core, initial }) {
  const [q, setQ] = useState(initial ?? '');
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(-1);
  const input = useRef(null);
  const pcs = core.scope === 'pcs';

  useEffect(() => { setQ(initial ?? ''); }, [initial]);

  // 「/」從任何地方跳回搜尋框（GitHub／Gmail 慣例）
  useEffect(() => {
    const on = (e) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target;
      if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      e.preventDefault();
      input.current?.focus();
      input.current?.select();
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);

  const { sugg, head } = useMemo(() => {
    if (!open) return { sugg: [], head: null };
    if (!q.trim()) {
      const used = getPrefs().used.filter((u) => Boolean(u.p) === pcs).slice(0, LIMIT).map((u) => ({ code: u.c, zh: u.zh, en: u.en }));
      if (used.length) return { sugg: used, head: '最近用過的碼' };
      const g = !pcs && core.common?.groups?.[0];
      return g
        ? { sugg: g.codes.slice(0, LIMIT).map(([code, zh, en, use]) => ({ code, zh, en, use })), head: `皮膚科常用：${g.name}（更多在「皮膚科常用」）` }
        : { sugg: [], head: null };
    }
    if (!core.eng) return { sugg: [], head: core.building ? '載入全部診斷中…' : null };
    try { return { sugg: core.eng.search(q, { limit: LIMIT }).items, head: null }; } catch { return { sugg: [], head: null }; }
  }, [q, open, core.eng, core.common, core.building, pcs]);
  const fav = useMemo(() => new Set(open ? getPrefs().fav : []), [open]);

  const submit = (text) => {
    const t = (text ?? q).trim();
    setOpen(false);
    if (t) go(href.q(t));
  };
  const pick = (it) => {
    setOpen(false);
    go(pcs ? href.p(it.code) : href.c(it.code));
  };

  return (
    <div className="relative">
      <form onSubmit={(e) => { e.preventDefault(); if (sel >= 0 && sugg[sel]) pick(sugg[sel]); else submit(); }}>
        <input
          ref={input}
          type="search"
          value={q}
          onChange={(e) => { setQ(e.target.value); setOpen(true); setSel(-1); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, sugg.length - 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, -1)); }
            if (e.key === 'Escape') setOpen(false);
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              const it = sugg[sel >= 0 ? sel : 0];
              if (it) copyCode(it, it.code, pcs);
            }
            // Alt/Option+1–8：用 e.code 判斷（Mac 的 Option+1 會產生「¡」，e.key 不是數字）
            const d = e.altKey && /^Digit([1-8])$/.exec(e.code);
            if (d && open) {
              e.preventDefault();
              const it = sugg[Number(d[1]) - 1];
              if (it) copyCode(it, it.code, pcs);
            }
          }}
          placeholder="疾病中文／英文、俗稱、縮寫、代碼（L40.0、L400）、舊碼、ICD-9（696.1）"
          aria-label="搜尋 ICD-10"
          autoComplete="off"
          className="w-full rounded-xl border border-slate-300 px-3 py-2 shadow-sm focus:outline-none focus:ring-2 focus:ring-brand-600"
        />
      </form>
      {open && (sugg.length > 0 || head) && (
        <div className="absolute left-0 right-0 mt-1 bg-white border border-slate-200 rounded-xl shadow-lg overflow-hidden z-30" data-testid="suggest">
          {head && <p className="px-3 pt-2 pb-1 text-[11px] text-slate-400" data-testid="suggest-head">{head}</p>}
          <ul role="listbox">
            {sugg.map((it, i) => (
              <li key={it.code} role="option" aria-selected={i === sel} className={`flex items-stretch ${i === sel ? 'bg-brand-50' : 'hover:bg-slate-50'}`}>
                <button
                  type="button"
                  onMouseDown={(e) => { e.preventDefault(); pick(it); }}
                  className="flex-1 min-w-0 text-left pl-2 pr-1 py-1.5 flex gap-2 items-baseline"
                >
                  <span className="hidden sm:inline w-3 shrink-0 text-[10px] text-slate-300" aria-hidden="true">{i + 1}</span>
                  <span className={`code w-20 shrink-0 ${it.use === 0 ? 'text-slate-400' : 'text-brand-700'}`}>{it.code}</span>
                  <span className="flex-1 min-w-0">
                    <span className="block sm:flex sm:items-baseline sm:gap-2 min-w-0">
                      <span className="flex items-baseline gap-1.5 min-w-0 sm:shrink-0 sm:max-w-[55%]">
                        <span className="truncate text-sm"><Hl text={it.zh} q={q} /></span>
                        <Badges it={it} fav={fav} />
                      </span>
                      {it.en && (
                        <span className="block truncate text-xs text-slate-500 sm:flex-1 sm:min-w-0" data-testid="sugg-en">
                          <Hl text={it.en} q={q} />
                        </span>
                      )}
                    </span>
                    {it.why?.text && it.why.src !== 'title' && (
                      <span className="block truncate text-[11px] text-slate-400">
                        命中：{it.why.text}（{SRC_LABEL[it.why.src] ?? it.why.src}）
                      </span>
                    )}
                  </span>
                </button>
                <button
                  type="button"
                  onMouseDown={(e) => { e.preventDefault(); copyCode(it, it.code, pcs); }}
                  className="shrink-0 px-3 text-xs text-slate-400 hover:text-brand-700 hover:bg-brand-50"
                  aria-label={`複製 ${it.code}`}
                  title="複製代碼"
                >
                  複製
                </button>
              </li>
            ))}
          </ul>
          <p className="hidden sm:block px-3 py-1 text-[11px] text-slate-400 border-t border-slate-100 bg-slate-50">
            ↑↓ 選擇　Enter 開詳細頁　⌘/Ctrl+Enter 複製選取列　Alt/Option+數字 複製第 N 列　任何頁面按 / 回到搜尋框
          </p>
        </div>
      )}
    </div>
  );
}

function Badges({ it, fav }) {
  return (
    <>
      {it.use === 0 && <span className="shrink-0 text-[10px] px-1 rounded bg-slate-200 text-slate-600" title="標題碼，不可申報，需選下層碼">標題碼</span>}
      {it.def && <span className="shrink-0 text-[10px] px-1 rounded bg-amber-100 text-amber-800" title="CDC 字母索引中未特指時使用的碼">★預設</span>}
      {fav.has(it.code) && <span className="shrink-0 text-[10px] px-1 rounded bg-emerald-100 text-emerald-800">常用</span>}
    </>
  );
}
