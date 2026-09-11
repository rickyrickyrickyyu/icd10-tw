import { useState } from 'react';
import { getPrefs } from '../lib/storage.js';
import { href } from '../lib/routes.js';
import { copyCode } from '../lib/clip.js';
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
      {core.common && (
        <section className="rounded-xl border border-slate-200 bg-white p-4 text-sm" data-testid="home-derm">
          <div className="flex items-baseline justify-between gap-2">
            <h2 className="font-medium">皮膚科常用碼{core.common.draft && <span className="ml-2 text-[11px] px-1.5 rounded bg-amber-100 text-amber-800">草擬、待醫師審閱</span>}</h2>
            <a href="#/derm" className="text-xs underline text-brand-700">看全部</a>
          </div>
          <p className="mt-2 flex flex-wrap gap-1.5">
            {core.common.groups.map((g, i) => (
              <a key={g.name} href={`#/derm/${i}`} className="px-2 py-0.5 rounded-full border border-slate-200 hover:bg-slate-50">
                {g.name}<span className="ml-1 text-slate-400">{g.codes.length}</span>
              </a>
            ))}
          </p>
          <p className="mt-2 text-xs text-slate-500">
            要一次查很多診斷？用 <a href="#/batch" className="underline text-brand-700">批次查碼</a>（貼上多行，完全在本機處理、不用 AI）。
          </p>
        </section>
      )}
      {prefs.used.length > 0 && (
        <section className="text-sm">
          <h2 className="text-slate-500 text-xs mb-1">最近用過的碼<span className="ml-1 text-slate-400">（搜尋框空白時也會列出；任何頁面按 / 回到搜尋框）</span></h2>
          <ul className="rounded-xl border border-slate-200 bg-white px-3 divide-y divide-slate-100">
            {prefs.used.map((u) => (
              <li key={u.c} className="py-1.5 flex gap-3 items-baseline">
                <a className="code text-brand-700 w-24 shrink-0 underline" href={u.p ? href.p(u.c) : href.c(u.c)}>{u.c}</a>
                <span className="flex-1 min-w-0 truncate">{u.zh}<span className="ml-2 text-xs text-slate-500">{u.en}</span></span>
                <button
                  type="button"
                  onClick={() => copyCode({ code: u.c, zh: u.zh, en: u.en }, u.c, Boolean(u.p))}
                  className="shrink-0 text-xs px-2 py-0.5 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 hover:text-brand-700"
                >
                  複製
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
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
