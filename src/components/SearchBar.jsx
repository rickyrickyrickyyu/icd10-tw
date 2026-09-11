import { useEffect, useMemo, useRef, useState } from 'react';
import { go, href } from '../lib/routes.js';
import { SRC_LABEL } from './labels.js';

/**
 * 搜尋框＋自動完成（仿 MeSH Browser）：邊打字邊顯示前 6 筆命中與「為什麼命中」，
 * 例：shingles → B02.9 帶狀疱疹未伴有併發症（CDC 索引 see）。Enter 看完整結果。
 */
export default function SearchBar({ core, initial }) {
  const [q, setQ] = useState(initial ?? '');
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(-1);
  const box = useRef(null);

  useEffect(() => { setQ(initial ?? ''); }, [initial]);

  const sugg = useMemo(() => {
    if (!open || !core.eng || q.trim().length < 1) return [];
    try { return core.eng.search(q, { limit: 6 }).items; } catch { return []; }
  }, [q, open, core.eng]);

  const submit = (text) => {
    const t = (text ?? q).trim();
    setOpen(false);
    if (t) go(href.q(t));
  };
  const pick = (it) => {
    setOpen(false);
    go(core.scope === 'pcs' ? href.p(it.code) : href.c(it.code));
  };

  return (
    <div className="relative" ref={box}>
      <form onSubmit={(e) => { e.preventDefault(); if (sel >= 0 && sugg[sel]) pick(sugg[sel]); else submit(); }}>
        <input
          type="search"
          value={q}
          onChange={(e) => { setQ(e.target.value); setOpen(true); setSel(-1); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, sugg.length - 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, -1)); }
            if (e.key === 'Escape') setOpen(false);
          }}
          placeholder="疾病中文／英文、俗稱、縮寫、代碼（L40.0、L400）、舊碼、ICD-9（696.1）"
          aria-label="搜尋 ICD-10"
          autoComplete="off"
          className="w-full rounded-xl border border-slate-300 px-3 py-2 shadow-sm focus:outline-none focus:ring-2 focus:ring-brand-600"
        />
      </form>
      {open && sugg.length > 0 && (
        <ul className="absolute left-0 right-0 mt-1 bg-white border border-slate-200 rounded-xl shadow-lg overflow-hidden z-30" role="listbox">
          {sugg.map((it, i) => (
            <li key={it.code} role="option" aria-selected={i === sel}>
              <button
                type="button"
                onMouseDown={(e) => { e.preventDefault(); pick(it); }}
                className={`w-full text-left px-3 py-2 text-sm flex gap-2 items-baseline ${i === sel ? 'bg-brand-50' : 'hover:bg-slate-50'}`}
              >
                <span className="code text-brand-700 w-20 shrink-0">{it.code}</span>
                <span className="flex-1 min-w-0">
                  <span className="block truncate">{it.zh}</span>
                  {it.why?.text && it.why.src !== 'title' && (
                    <span className="block truncate text-xs text-slate-500">
                      {it.why.text}（{SRC_LABEL[it.why.src] ?? it.why.src}）
                    </span>
                  )}
                </span>
                {it.def && <span className="text-amber-600 text-xs" title="預設碼">★</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
