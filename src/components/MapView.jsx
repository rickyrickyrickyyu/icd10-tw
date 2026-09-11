import { useEffect, useState } from 'react';
import { load, loadMap14, loadMap9 } from '../hooks/useData.js';
import { href } from '../lib/routes.js';

// GEM 五碼旗標：approximate / no map / combination / scenario / choice list
const GEM = (f) => {
  if (!f || f.length !== 5) return null;
  const out = [];
  out.push(f[0] === '1' ? '近似對應' : '完全對應');
  if (f[2] === '1') out.push(`組合對應（情境 ${f[3]}、選項 ${f[4]}）`);
  return out.join('，');
};

/** 2014 舊碼 → 2023，或 ICD-9 → 2023。 */
export default function MapView({ kind, code }) {
  const [st, setSt] = useState({ loading: true });
  useEffect(() => {
    let alive = true;
    const pcs = /^[0-9A-HJ-NP-Z]{7}$/.test(code) || (kind === 'map9' && /^\d{2}\.\d/.test(code));
    const k = pcs ? 'pcs' : 'cm';
    const f = kind === 'map14' ? loadMap14(k, code) : loadMap9(k, code);
    Promise.all([f, load(pcs ? 'pcs.json' : 'cm.json')]).then(([m, rows]) => {
      const names = new Map(rows.rows.map((r) => [r[0], r[1]]));
      if (alive) setSt({ loading: false, data: m[code] ?? null, names, pcs });
    }).catch((e) => alive && setSt({ loading: false, error: e.message }));
    return () => { alive = false; };
  }, [kind, code]);

  if (st.loading) return <p className="text-slate-500">載入中…</p>;
  if (st.error) return <p className="text-red-700">{st.error}</p>;
  const title = kind === 'map14' ? `2014 年版 ICD-10-${st.pcs ? 'PCS' : 'CM'}` : 'ICD-9-CM（2001 年版）';
  if (!st.data) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <p>{title} <span className="code">{code}</span>：對應檔中沒有這個碼的異動紀錄。</p>
        {kind === 'map14' && <p className="text-sm text-slate-600 mt-1">2014 與 2023 版同碼同名的碼不列入對應檔，直接看 <a className="underline" href={href.c(code)}>{code}</a>。</p>}
      </div>
    );
  }
  const targets = kind === 'map9' ? st.data.t : st.data;
  return (
    <article className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
      <header>
        <p className="text-xs text-slate-500">{title}</p>
        <h1 className="code text-xl font-semibold">{code}</h1>
        {kind === 'map9' && st.data.n && <p>{st.data.n[0]}<span className="block text-sm text-slate-500">{st.data.n[1]}</span></p>}
      </header>
      <p className="text-sm">對應到 2023 年版 <b>{targets.length}</b> 碼{targets.length > 1 && '（一對多：依病歷內容擇一或組合）'}：</p>
      <ul className="divide-y divide-slate-100">
        {targets.map(([c, a, b]) => (
          <li key={c} className="py-1.5 text-sm">
            <a className="flex gap-3 hover:underline" href={st.pcs ? href.p(c) : href.c(c)}>
              <span className="code text-brand-700 w-24 shrink-0">{c}</span>
              <span className="flex-1">{st.names.get(c) ?? ''}</span>
            </a>
            <span className="block pl-[6.75rem] text-xs text-slate-500">
              {kind === 'map9' ? GEM(a) : [a, b].filter(Boolean).join('；')}
            </span>
          </li>
        ))}
      </ul>
      <p className="text-[11px] text-slate-400">資料：健保署 {kind === 'map9' ? 'ICD-9-CM 與 2023 年版對應檔' : '2014 與 2023 年版 ICD-10-CM/PCS 對應檔'}（正式版）。已排除官方標記「刪除對應」的列。</p>
    </article>
  );
}
