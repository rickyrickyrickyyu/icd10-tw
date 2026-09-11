import { useEffect, useMemo, useState } from 'react';
import { load, loadDetail, loadNodes } from '../hooks/useData.js';
import { href } from '../lib/routes.js';
import { getPrefs, pushUsed, toggleFav } from '../lib/storage.js';
import { copyCode } from '../lib/clip.js';
import { cmCode } from '../lib/search/query.js';
import { NOTE_LABEL, SRC_LABEL, ST_LABEL } from './labels.js';

/**
 * CM 碼詳細頁 ＝ MeSH Descriptor 頁：樹狀位置、入口詞（依來源分組）、撰碼注意、
 * 預設碼、下層碼、重大傷病、反查（2014 舊碼／ICD-9）、MeSH。
 */
export default function CodeDetail({ code: raw }) {
  const code = cmCode(raw) ?? raw;
  const [st, setSt] = useState({ loading: true });
  const [fav, setFav] = useState(() => getPrefs().fav.includes(code));

  useEffect(() => {
    let alive = true;
    setSt({ loading: true });
    setFav(getPrefs().fav.includes(code));
    (async () => {
      const [vocab, tree, nodes, cat] = await Promise.all([
        loadDetail(code), load('tree.json'), loadNodes(code), load('cat.json'),
      ]);
      const all = vocab.rows;          // 同首字母的列：祖先、子孫都在裡面
      const i = all.findIndex((r) => r[0] === code);
      if (i < 0) { if (alive) setSt({ loading: false, missing: true }); return; }
      const have = new Set(all.map((r) => r[0]));
      const parentOf = (c) => { let x = c; while (x.length > 3) { x = x.slice(0, -1).replace(/\.$/, ''); if (have.has(x)) return x; } return null; };
      const byCode = new Map(all.map((r) => [r[0], r]));
      const ancestors = [];
      for (let p = parentOf(code); p; p = parentOf(p)) ancestors.unshift(byCode.get(p));
      const children = all.filter((r) => r[0] !== code && r[0].startsWith(code) && parentOf(r[0]) === code);
      const nDesc = all.filter((r) => r[0] !== code && r[0].startsWith(code)).length;
      const entries = vocab.t.filter((v) => v[1] === code).map((v) => ({ text: v[0], src: vocab.src[v[2]], inc: v[3] & 1 }));
      const cat3 = code.slice(0, 3);
      const ch = tree.chapters.find((c) => cat3 >= c.first && cat3 <= c.last);
      const sec = ch?.sections.find((s) => cat3 >= s[2] && cat3 <= s[3]);
      let mesh = null;
      const uis = nodes[code]?.mesh;
      if (uis?.length) { const m = await load('mesh.json').catch(() => ({})); mesh = uis.map((u) => [u, m[u]]).filter((x) => x[1]); }
      const inherited = ancestors.map((a) => [a[0], nodes[a[0]]?.n]).filter((x) => x[1]);
      if (alive) {
        setSt({ loading: false, row: all[i], ancestors, children, nDesc, entries, ch, sec, node: nodes[code] ?? {}, inherited, cat: cat.codes[code], catInfo: cat, mesh });
      }
    })().catch((e) => alive && setSt({ loading: false, error: e.message }));
    return () => { alive = false; };
  }, [code]);

  const grouped = useMemo(() => {
    const g = {};
    for (const e of st.entries ?? []) (g[e.src] ??= []).push(e);
    return Object.entries(g).sort((a, b) => b[1].length - a[1].length);
  }, [st.entries]);

  // 開過的可申報碼記入「最近用過」（標題碼只是瀏覽路過，不記）
  useEffect(() => {
    if (st.row && st.row[3] !== 0) pushUsed(st.row[0], st.row[1], st.row[2]);
  }, [st.row]);

  if (st.loading) return <p className="text-slate-500">載入中…</p>;
  if (st.error) return <p className="text-red-700">載入失敗：{st.error}</p>;
  if (st.missing) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <p><span className="code">{code}</span> 不是 2023 年版 ICD-10-CM 的碼。</p>
        <p className="mt-2 text-sm">可能是 2014 年版舊碼：<a className="underline text-brand-700" href={href.m14(code)}>查 2014→2023 對應</a></p>
      </div>
    );
  }
  const [c, zh, en, use, stt, rev] = st.row;
  const copy = (text) => copyCode({ code: c, zh, en }, text);

  return (
    <article className="space-y-4">
      <nav className="text-xs text-slate-500 flex flex-wrap gap-1 items-center">
        {st.ch && <span>第 {st.ch.n} 章 {st.ch.zh ?? st.ch.en}</span>}
        {st.sec && <><span>›</span><span>{st.sec[1]}（{st.sec[0]}）</span></>}
        {st.ancestors.map((a) => (
          <span key={a[0]} className="inline-flex gap-1"><span>›</span><a className="underline" href={href.c(a[0])}><span className="code">{a[0]}</span> {a[1]}</a></span>
        ))}
      </nav>

      <header className="rounded-xl border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="code text-2xl font-semibold text-brand-900">{c}</h1>
          <span className="text-lg">{zh}</span>
        </div>
        <p className="text-slate-600">{en}</p>
        {zh.includes('?') && (
          <p className="mt-1 text-xs text-amber-700">官方中文名含亂碼：「?」在健保署原始檔即如此（對照英文名，應為「瘻」）。本站照原樣顯示，但搜尋「瘻管」也找得到。</p>
        )}
        {use === 0 ? (
          <p className="mt-3 rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-800">
            ⚠️ 標題碼，<b>不可申報</b>。申報需選到下層的可申報碼（共 {st.nDesc} 個下層碼）。
          </p>
        ) : (
          <p className="mt-2 text-xs text-emerald-700">✓ 可申報碼</p>
        )}
        {st.cat && (
          <div className="mt-3 rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-900">
            {st.cat.map(([n, ni]) => (
              <p key={`${n}-${ni}`}>
                重大傷病範圍：<a className="underline" href={href.cat(n)}>第 {n} 類 {st.catInfo.categories[n]}</a>
                {st.catInfo.notes[ni] && st.catInfo.notes[ni] !== '本次不受轉版影響' && <span className="block text-xs mt-0.5">{st.catInfo.notes[ni]}</span>}
              </p>
            ))}
            <p className="text-[11px] text-rose-700 mt-1">依健保署對照表 {st.catInfo.version} 版；是否符合仍依重大傷病審查規定。</p>
          </div>
        )}
        {stt && <p className="mt-2 text-xs text-slate-500">本版：{ST_LABEL[stt] ?? stt}{rev ? `（${rev}）` : ''}</p>}
        <div className="mt-3 flex flex-wrap gap-2 text-sm">
          <button type="button" onClick={() => copy(c)} className="px-2.5 py-1 rounded-lg border border-slate-300 hover:bg-slate-50">複製代碼</button>
          <button type="button" onClick={() => copy(`${c} ${zh}`)} className="px-2.5 py-1 rounded-lg border border-slate-300 hover:bg-slate-50">複製代碼＋中文</button>
          <button type="button" onClick={() => setFav(toggleFav(c).fav.includes(c))} className="px-2.5 py-1 rounded-lg border border-slate-300 hover:bg-slate-50">
            {fav ? '★ 已加入常用' : '☆ 加入常用'}
          </button>
        </div>
      </header>

      {st.children.length > 0 && (
        <section className="rounded-xl border border-slate-200 bg-white p-4">
          <h2 className="font-medium mb-2">下層碼（{st.children.length}）</h2>
          <ul className="divide-y divide-slate-100">
            {st.children.map((r) => (
              <li key={r[0]} className="py-1.5">
                <a href={href.c(r[0])} className="flex gap-3 items-baseline hover:underline">
                  <span className="code text-brand-700 w-24 shrink-0">{r[0]}</span>
                  <span>{r[1]}{r[3] === 0 && <span className="ml-2 text-[11px] px-1.5 rounded bg-slate-200">標題碼</span>}</span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      {st.node.x7 && (
        <section className="rounded-xl border border-slate-200 bg-white p-4">
          <h2 className="font-medium mb-2">第 7 碼（就醫階段）</h2>
          <table className="text-sm"><tbody>
            {Object.entries(st.node.x7).map(([k, v]) => (
              <tr key={k}><td className="code pr-3 align-top">{k}</td><td>{v}</td></tr>
            ))}
          </tbody></table>
        </section>
      )}

      <Notes title="撰碼注意事項" notes={st.node.n} />
      {st.inherited.map(([a, n]) => <Notes key={a} title={`上層 ${a} 的撰碼注意事項（適用於本碼）`} notes={n} muted />)}

      {grouped.length > 0 && (
        <section className="rounded-xl border border-slate-200 bg-white p-4">
          <h2 className="font-medium mb-2">入口詞（{st.entries.length}）<span className="ml-2 text-xs font-normal text-slate-500">搜尋這些詞都會找到本碼</span></h2>
          <div className="space-y-2">
            {grouped.map(([src, list]) => (
              <div key={src}>
                <h3 className="text-xs text-slate-500">{SRC_LABEL[src] ?? src}</h3>
                <p className="text-sm leading-7">
                  {list.slice(0, 40).map((e, i) => (
                    <span key={`${e.text}-${i}`} className="inline-block mr-1.5 mb-1 px-1.5 rounded bg-slate-100">{e.text}{e.inc ? ' (-)' : ''}</span>
                  ))}
                  {list.length > 40 && <span className="text-xs text-slate-500">…另 {list.length - 40} 筆</span>}
                </p>
              </div>
            ))}
          </div>
        </section>
      )}

      {(st.node.m14 || st.node.m9) && (
        <section className="rounded-xl border border-slate-200 bg-white p-4 text-sm space-y-2">
          <h2 className="font-medium">舊碼對應到本碼</h2>
          {st.node.m14 && <p>2014 年版：{st.node.m14.map((o) => <a key={o} className="code underline text-brand-700 mr-2" href={href.m14(o)}>{o}</a>)}</p>}
          {st.node.m9 && <p>ICD-9-CM：{st.node.m9.slice(0, 30).map((o) => <a key={o} className="code underline text-brand-700 mr-2" href={href.m9(o)}>{o}</a>)}{st.node.m9.length > 30 && '…'}</p>}
        </section>
      )}

      {st.mesh?.length > 0 && (
        <section className="rounded-xl border border-slate-200 bg-white p-4 text-sm space-y-2">
          <h2 className="font-medium">MeSH</h2>
          {st.mesh.map(([ui, [name, trees, scope]]) => (
            <div key={ui}>
              <p><b>{name}</b> <span className="code text-xs text-slate-500">{ui}</span></p>
              {trees?.length > 0 && <p className="text-xs text-slate-500">Tree：{trees.join('、')}</p>}
              {scope && <p className="text-slate-700 mt-1">{scope}</p>}
            </div>
          ))}
          <p className="text-[11px] text-slate-400">MeSH 資料來自美國國家醫學圖書館（NLM），經 Disease Ontology 對應；NLM 未背書本站。</p>
        </section>
      )}
    </article>
  );
}

function Notes({ title, notes, muted }) {
  if (!notes) return null;
  const keys = Object.keys(NOTE_LABEL).filter((k) => notes[k]?.length);
  if (!keys.length) return null;
  const linkify = (s) => s.split(/([A-Z]\d[0-9A-Z](?:\.[0-9A-Z-]{1,4})?)/g).map((p, i) => (
    /^[A-Z]\d[0-9A-Z]/.test(p) ? <a key={i} className="code underline text-brand-700" href={href.c(p.replace(/-$/, ''))}>{p}</a> : p
  ));
  return (
    <section className={`rounded-xl border p-4 text-sm ${muted ? 'border-slate-200 bg-slate-50' : 'border-slate-200 bg-white'}`}>
      <h2 className="font-medium mb-2">{title}</h2>
      <dl className="space-y-2">
        {keys.map((k) => (
          <div key={k}>
            <dt className="text-xs text-slate-500">{NOTE_LABEL[k]}</dt>
            <dd><ul className="list-disc pl-5">{notes[k].map((n, i) => <li key={i}>{linkify(n)}</li>)}</ul></dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
