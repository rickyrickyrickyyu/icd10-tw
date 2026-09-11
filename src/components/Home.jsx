import { useState } from 'react';
import { getPrefs } from '../lib/storage.js';
import { href } from '../lib/routes.js';
import DataFreshness from './DataFreshness.jsx';

const EXAMPLES = ['皮蛇', '異位性皮膚炎', 'shingles', 'psoraisis', 'BCC nose', '糖尿病腎病變', 'L400', '696.1', 'L40.0-L40.4'];

export default function Home({ core }) {
  const [prefs] = useState(getPrefs);
  const m = core.meta;
  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-slate-200 bg-white p-4 text-sm leading-6">
        <p>
          以<b>健保署 2023 年版中文版 ICD-10-CM/PCS</b> 為準（健保自 114/1/1 起全面採用）。
          搜尋仿 PubMed MeSH：中文、英文、俗稱、縮寫、錯字、代碼（有沒有小數點都可以）、
          2014 舊碼與 ICD-9 都能查，結果上方的 <i>Search details</i> 會說明你的查詢被對應到哪些主題。
        </p>
        <p className="mt-2 flex flex-wrap gap-2">
          {EXAMPLES.map((e) => <a key={e} href={href.q(e)} className="px-2 py-0.5 rounded-full bg-brand-50 text-brand-700 hover:bg-brand-100">{e}</a>)}
        </p>
      </section>
      {prefs.recent.length > 0 && (
        <section className="text-sm">
          <h2 className="text-slate-500 text-xs mb-1">最近查詢</h2>
          <p className="flex flex-wrap gap-2">{prefs.recent.map((r) => <a key={r} href={href.q(r)} className="underline text-slate-700">{r}</a>)}</p>
        </section>
      )}
      {m && (
        <p className="text-xs text-slate-500">
          CM {m.counts.cm.toLocaleString()} 碼（可申報 {m.counts.cm_billable.toLocaleString()}）｜PCS {m.counts.pcs.toLocaleString()} 碼｜
          入口詞 {m.counts.vocab_cm.toLocaleString()}｜重大傷病 {m.counts.catastrophic.toLocaleString()} 碼｜
          <a className="underline" href="#/cat/">重大傷病類別</a>
        </p>
      )}
      <DataFreshness meta={m} />
    </div>
  );
}
