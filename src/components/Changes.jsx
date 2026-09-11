import { useEffect, useState } from 'react';
import { load } from '../hooks/useData.js';
import { href } from '../lib/routes.js';
import { ST_LABEL } from './labels.js';

/** 本版異動：官方檔的「狀態／修訂日期」欄（相對於 2014 版的新增、名稱修改，及後續修正）。 */
export default function Changes() {
  const [st, setSt] = useState(null);
  const [tab, setTab] = useState('rev');
  useEffect(() => { load('cm.json').then((r) => setSt(r.rows)).catch(() => setSt([])); }, []);
  if (!st) return <p className="text-slate-500">載入中…</p>;
  const revised = st.filter((r) => r[5]);
  const byStatus = (k) => st.filter((r) => r[4] === k);
  const list = tab === 'rev' ? revised : byStatus(tab);
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <h1 className="font-semibold">本版異動（ICD-10-CM）</h1>
      <div className="flex flex-wrap gap-1 text-xs my-2">
        {[['rev', `官方修訂紀錄 ${revised.length}`], ...Object.entries(ST_LABEL).map(([k, v]) => [k, `${v} ${byStatus(k).length}`])].map(([k, label]) => (
          <button key={k} type="button" onClick={() => setTab(k)} className={`px-2 py-0.5 rounded-full border ${tab === k ? 'bg-brand-700 text-white border-brand-700' : 'border-slate-300'}`}>{label}</button>
        ))}
      </div>
      <ul className="divide-y divide-slate-100 text-sm">
        {list.slice(0, 500).map((r) => (
          <li key={r[0]} className="py-1.5">
            <a className="flex gap-3 hover:underline" href={href.c(r[0])}><span className="code text-brand-700 w-24 shrink-0">{r[0]}</span><span className="flex-1">{r[1]}</span></a>
            {r[5] && <span className="block pl-[6.75rem] text-xs text-slate-500">{r[5]}</span>}
          </li>
        ))}
      </ul>
      {list.length > 500 && <p className="text-xs text-slate-500 mt-2">只顯示前 500 筆。</p>}
    </section>
  );
}
