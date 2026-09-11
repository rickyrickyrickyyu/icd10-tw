import { useEffect, useState } from 'react';
import { namesFor } from '../hooks/useData.js';
import { getPrefs, toggleFav } from '../lib/storage.js';
import { href } from '../lib/routes.js';

export default function Favorites() {
  const [fav, setFav] = useState(() => getPrefs().fav);
  const [names, setNames] = useState(null);
  useEffect(() => { namesFor(getPrefs().fav).then(setNames).catch(() => setNames(new Map())); }, []);
  const copyAll = () => navigator.clipboard?.writeText(fav.map((c) => `${c}\t${names?.get(c)?.[1] ?? ''}`).join('\n')).catch(() => {});
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex items-baseline justify-between">
        <h1 className="font-semibold">常用碼（{fav.length}）</h1>
        {fav.length > 0 && <button type="button" onClick={copyAll} className="text-xs underline">全部複製（Tab 分隔，可貼進 Excel）</button>}
      </div>
      <p className="text-xs text-slate-500 mb-2">只存在這台裝置的瀏覽器裡。</p>
      {fav.length === 0 ? <p className="text-sm text-slate-600">在代碼頁按「☆ 加入常用」。</p> : (
        <ul className="divide-y divide-slate-100 text-sm">
          {fav.map((c) => (
            <li key={c} className="py-1.5 flex gap-3 items-baseline">
              <a className="code text-brand-700 w-24 shrink-0 underline" href={href.c(c)}>{c}</a>
              <span className="flex-1">{names?.get(c)?.[1] ?? ''}</span>
              <button type="button" className="text-xs text-slate-500 hover:text-red-700" onClick={() => setFav(toggleFav(c).fav)}>移除</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
