import { href } from '../lib/routes.js';
import { SRC_LABEL } from './labels.js';

export default function ResultRow({ it, pcs, cat }) {
  const link = pcs ? href.p(it.code) : href.c(it.code);
  const catCats = cat?.codes?.[it.code];
  return (
    <li className="py-2.5 border-b border-slate-100 last:border-0">
      <a href={link} className="flex gap-3 items-baseline group">
        <span className="code text-brand-700 font-medium w-24 shrink-0 group-hover:underline">{it.code}</span>
        <span className="flex-1 min-w-0">
          <span className="block">
            {it.zh}
            {it.use === 0 && (
              <span className="ml-2 text-[11px] px-1.5 py-0.5 rounded bg-slate-200 text-slate-700 align-middle">標題碼</span>
            )}
            {it.def && (
              <span className="ml-2 text-[11px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 align-middle" title="CDC 字母索引中，這個詞未特指時使用的碼">★ 預設碼</span>
            )}
            {catCats && (
              <span className="ml-2 text-[11px] px-1.5 py-0.5 rounded bg-rose-100 text-rose-800 align-middle">重大傷病</span>
            )}
          </span>
          <span className="block text-sm text-slate-500">{it.en}</span>
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
    </li>
  );
}
