import { useEffect, useMemo, useState } from 'react';
import { load, loadMap14, loadMap9 } from '../hooks/useData.js';
import { pushRecent } from '../lib/storage.js';
import { href } from '../lib/routes.js';
import { applyFacets, facetCounts, FACET_LABEL } from '../lib/search/facets.js';
import { parseQuery } from '../lib/search/query.js';
import ResultRow from './ResultRow.jsx';
import { SRC_LABEL } from './labels.js';

/**
 * 結果頁：Search details（PubMed 式翻譯說明）＋ facets ＋ 結果列。
 * ICD-9 與 2014 舊碼不進主索引，另外查對應檔分片，放在獨立區塊。
 */
export default function Results({ core, q }) {
  const [explode, setExplode] = useState(true);
  const [sel, setSel] = useState({});
  const [cat, setCat] = useState(null);
  const [old, setOld] = useState(null);           // {kind, code, data}

  useEffect(() => { setSel({}); pushRecent(q); }, [q]);
  useEffect(() => { load('cat.json').then(setCat).catch(() => {}); }, []);

  const res = useMemo(() => {
    if (!core.eng) return null;
    const t0 = performance.now();
    const r = core.eng.search(q, { limit: 200, explode });
    return { ...r, ms: Math.round(performance.now() - t0) };
  }, [core.eng, q, explode]);

  // ICD-9／舊碼：query.js 判成 icd9、或 CM 碼在 2023 版查無 → 查對應檔
  useEffect(() => {
    setOld(null);
    const pq = parseQuery(q);
    const c9 = pq.codes.find((c) => c.kind === 'icd9');
    const cm = pq.codes.find((c) => c.kind === 'cm' || c.kind === 'icd14');
    const kind = core.scope === 'pcs' ? 'pcs' : 'cm';
    if (c9) {
      loadMap9(kind, c9.code).then((m) => setOld({ kind: 'icd9', code: c9.code, data: m[c9.code] ?? null }));
    } else if (cm && (cm.kind === 'icd14' || !res?.items.some((x) => x.code === cm.code))) {
      loadMap14(kind, cm.code).then((m) => setOld({ kind: 'icd14', code: cm.code, data: m[cm.code] ?? null }));
    }
  }, [q, core.scope, res]);

  if (!res) return null;
  const items = applyFacets(res.items, sel);
  const facets = facetCounts(res.items);
  const d = res.details;

  return (
    <div className="space-y-4">
      <SearchDetails d={d} res={res} explode={explode} setExplode={setExplode} scope={core.scope} />

      {old && <OldCodeBox old={old} />}

      {Object.keys(facets).length > 0 && (
        <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs">
          {Object.entries(facets).map(([k, vals]) => (
            <div key={k} className="flex flex-wrap items-center gap-1">
              <span className="text-slate-500">{FACET_LABEL[k]}</span>
              {vals.map(([v, n]) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setSel((s) => ({ ...s, [k]: s[k] === v ? null : v }))}
                  className={`px-2 py-0.5 rounded-full border ${sel[k] === v ? 'bg-brand-700 text-white border-brand-700' : 'border-slate-300 bg-white hover:bg-slate-50'}`}
                >
                  {v} <span className="opacity-60">{n}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}

      {items.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-700">
          查無結果。
          {core.scope === 'derm' && (
            <button type="button" className="ml-2 underline text-brand-700" onClick={() => core.setScope('cm')}>
              改查全部診斷
            </button>
          )}
        </div>
      ) : (
        <ul className="rounded-xl border border-slate-200 bg-white px-3">
          {items.map((it) => <ResultRow key={it.code} it={it} pcs={core.scope === 'pcs'} cat={cat} />)}
        </ul>
      )}
      {core.scope === 'derm' && items.length > 0 && (
        <p className="text-xs text-slate-500">
          目前只查皮膚科子集。
          <button type="button" className="underline text-brand-700 ml-1" onClick={() => core.setScope('cm')}>查全部診斷</button>
        </p>
      )}
    </div>
  );
}

function SearchDetails({ d, res, explode, setExplode, scope }) {
  const parts = [];
  for (const m of d.mapped) {
    parts.push(
      <span key={`m-${m.text}`} className="inline-flex flex-wrap items-baseline gap-1">
        「{m.text}」→ 主題
        {m.concepts.slice(0, 4).map((c) => (
          <a key={c.code} href={href.c(c.code)} className="code text-brand-700 underline" title={SRC_LABEL[c.src] ?? c.src}>
            {c.code}{c.incomplete ? '-' : ''}
          </a>
        ))}
        {m.concepts.length > 4 && <span>等 {m.concepts.length} 個</span>}
        {explode && <span className="text-slate-500">（explode 共 {m.explodeCount} 碼）</span>}
      </span>,
    );
  }
  for (const f of d.free) parts.push(<span key={`f-${f}`}>「{f}」[全文]</span>);
  return (
    <details className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm" open={d.mapped.length > 0 || d.corrections.length > 0 || d.expansions?.length > 0}>
      <summary className="cursor-pointer select-none text-slate-600">
        {res.total.toLocaleString()} 筆｜{res.ms} ms｜{scope === 'derm' ? '皮膚科' : scope === 'pcs' ? 'PCS' : '全部 CM'}
        <span className="ml-2 text-slate-400">Search details</span>
      </summary>
      <div className="mt-2 space-y-1.5">
        {d.corrections.length > 0 && (
          <p className="text-amber-800">已修正拼字：{d.corrections.map(([a, b]) => `${a} → ${b}`).join('、')}</p>
        )}
        {d.expansions?.length > 0 && (
          <p className="text-sky-800">縮寫展開：{d.expansions.map(([a, b]) => `${a.toUpperCase()} → ${b}`).join('、')}</p>
        )}
        {parts.length > 0 && <p className="flex flex-wrap gap-x-2 gap-y-1">{parts.reduce((acc, p, i) => (i ? [...acc, <span key={`and-${i}`} className="text-slate-400">AND</span>, p] : [p]), [])}</p>}
        {d.whole && <p className="text-xs text-slate-500">整句命中入口詞：主題與其下層碼排在最前。</p>}
        <label className="inline-flex items-center gap-1.5 text-xs text-slate-600">
          <input type="checkbox" checked={explode} onChange={(e) => setExplode(e.target.checked)} className="w-4 h-4" />
          Explode（連同下層碼）
        </label>
      </div>
    </details>
  );
}

function OldCodeBox({ old }) {
  const title = old.kind === 'icd9' ? `ICD-9-CM ${old.code}` : `2014 年版 ${old.code}`;
  if (!old.data) {
    return old.kind === 'icd9'
      ? <p className="text-sm rounded-xl border border-slate-200 bg-white p-3">{title}：對應檔中查無此碼。</p>
      : null;
  }
  const targets = old.kind === 'icd9' ? old.data.t : old.data;
  return (
    <div className="rounded-xl border border-sky-200 bg-sky-50 p-3 text-sm">
      <p className="font-medium">
        {title}
        {old.kind === 'icd9' && old.data.n && <span className="ml-2 font-normal">{old.data.n[0]}</span>}
        <span className="ml-2 text-xs text-slate-600">→ 2023 年版 {targets.length} 碼</span>
      </p>
      <ul className="mt-1.5 flex flex-wrap gap-2">
        {targets.map(([c]) => (
          <li key={c}><a className="code underline text-brand-700" href={href.c(c)}>{c}</a></li>
        ))}
      </ul>
      <a className="mt-1 inline-block text-xs underline text-slate-600" href={old.kind === 'icd9' ? href.m9(old.code) : href.m14(old.code)}>
        看完整對應說明
      </a>
    </div>
  );
}
