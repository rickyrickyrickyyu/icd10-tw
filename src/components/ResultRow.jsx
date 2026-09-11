import { href } from '../lib/routes.js';
import { copyCode } from '../lib/clip.js';
import { SRC_LABEL } from './labels.js';
import Hl from './Hl.jsx';

export default function ResultRow({ it, pcs, cat, q, fav }) {
  const link = pcs ? href.p(it.code) : href.c(it.code);
  const catCats = cat?.codes?.[it.code];
  return (
    <li className="py-2.5 border-b border-slate-100 last:border-0 flex gap-2 items-start">
      <a href={link} className="flex-1 min-w-0 flex gap-3 items-baseline group">
        <span className={`code font-medium w-24 shrink-0 group-hover:underline ${it.use === 0 ? 'text-slate-400' : 'text-brand-700'}`}>{it.code}</span>
        <span className="flex-1 min-w-0">
          <span className="block">
            <Hl text={it.zh} q={q} />
            {it.use === 0 && (
              <span className="ml-2 text-[11px] px-1.5 py-0.5 rounded bg-slate-200 text-slate-700 align-middle">標題碼・不可申報</span>
            )}
            {it.def && (
              <span className="ml-2 text-[11px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 align-middle" title="CDC 字母索引中，這個詞未特指時使用的碼">★ 預設碼</span>
            )}
            {fav?.has(it.code) && (
              <span className="ml-2 text-[11px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 align-middle">常用</span>
            )}
            {catCats && (
              <span className="ml-2 text-[11px] px-1.5 py-0.5 rounded bg-rose-100 text-rose-800 align-middle">重大傷病</span>
            )}
          </span>
          <span className="block text-sm text-slate-500"><Hl text={it.en} q={q} /></span>
          {it.zh.includes('?') && (
            <span className="block text-xs text-amber-700">官方中文名含亂碼：「?」在健保署原始檔即如此（應為「瘻」）</span>
          )}
          {it.why?.text && it.why.src !== 'title' && (
            <span className="block text-xs text-slate-400 mt-0.5">
              命中：{it.why.text}（{SRC_LABEL[it.why.src] ?? it.why.src}）
            </span>
          )}
        </span>
      </a>
      <button
        type="button"
        onClick={() => copyCode(it, it.code, pcs)}
        className="shrink-0 mt-0.5 text-xs px-2 py-1 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 hover:text-brand-700"
        aria-label={`複製 ${it.code}`}
      >
        複製
      </button>
    </li>
  );
}
