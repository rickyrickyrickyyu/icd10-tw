import { useEffect, useState } from 'react';
import { load, loadPcsDetail } from '../hooks/useData.js';
import { href } from '../lib/routes.js';
import { ST_LABEL } from './labels.js';

/** PCS 碼：7 碼無階層。顯示 section 與同表格（前 4 碼）的其他碼。 */
export default function PcsDetail({ code }) {
  const [st, setSt] = useState({ loading: true });
  useEffect(() => {
    let alive = true;
    Promise.all([loadPcsDetail(code), load('tree.json')]).then(([rows, tree]) => {
      const r = rows.rows.find((x) => x[0] === code);
      const same = rows.rows.filter((x) => x[0] !== code && x[0].startsWith(code.slice(0, 4))).slice(0, 80);
      if (alive) setSt({ loading: false, r, same, section: tree.pcs?.[code[0]] });
    }).catch((e) => alive && setSt({ loading: false, error: e.message }));
    return () => { alive = false; };
  }, [code]);
  if (st.loading) return <p className="text-slate-500">載入中…</p>;
  if (st.error) return <p className="text-red-700">{st.error}</p>;
  if (!st.r) return <p><span className="code">{code}</span> 不是 2023 年版 ICD-10-PCS 的碼。<a className="underline ml-2" href={href.m14(code)}>查 2014 對應</a></p>;
  const [c, zh, en, , stt, rev] = st.r;
  return (
    <article className="space-y-4">
      <header className="rounded-xl border border-slate-200 bg-white p-4">
        <p className="text-xs text-slate-500">ICD-10-PCS｜Section {c[0]} {st.section}</p>
        <h1 className="code text-2xl font-semibold text-brand-900">{c}</h1>
        <p className="text-lg">{zh}</p>
        <p className="text-slate-600">{en}</p>
        {stt && <p className="mt-2 text-xs text-slate-500">本版：{ST_LABEL[stt] ?? stt}{rev ? `（${rev}）` : ''}</p>}
        <button type="button" onClick={() => navigator.clipboard?.writeText(c).catch(() => {})} className="mt-3 px-2.5 py-1 text-sm rounded-lg border border-slate-300 hover:bg-slate-50">複製代碼</button>
      </header>
      {st.same.length > 0 && (
        <section className="rounded-xl border border-slate-200 bg-white p-4">
          <h2 className="font-medium mb-2">同表格（{c.slice(0, 4)}）的其他碼</h2>
          <ul className="divide-y divide-slate-100 text-sm">
            {st.same.map((x) => (
              <li key={x[0]} className="py-1.5"><a className="flex gap-3 hover:underline" href={href.p(x[0])}><span className="code text-brand-700 w-24 shrink-0">{x[0]}</span><span>{x[1]}</span></a></li>
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}
