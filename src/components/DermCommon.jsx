import { useEffect, useState } from 'react';
import { href } from '../lib/routes.js';
import { getPrefs, toggleFav } from '../lib/storage.js';
import { copyCode } from '../lib/clip.js';

/**
 * 皮膚科常用碼清單（v15 取代「皮膚科子集範圍」）。資料 derm_common.json，名稱由 pipeline 從官方列帶入。
 * 草擬中（curation/derm_common.yaml 的 draft: true）時頁首標示「待醫師審閱」。
 */
export default function DermCommon({ core, group }) {
  const c = core.common;
  const [fav, setFav] = useState(() => new Set(getPrefs().fav));
  const [f, setF] = useState('');

  useEffect(() => {
    if (group === undefined || group === '' || !c) return;
    document.getElementById(`g-${group}`)?.scrollIntoView({ block: 'start' });
  }, [group, c]);

  if (!c) return <p className="text-slate-500">常用碼清單載入失敗，請重新整理。</p>;
  const needle = f.trim().toLowerCase();
  const hit = (r) => !needle || r[0].toLowerCase().includes(needle) || r[1].includes(needle) || r[2].toLowerCase().includes(needle);
  const total = c.groups.reduce((n, g) => n + g.codes.length, 0);

  return (
    <article className="space-y-4">
      <header className="rounded-xl border border-slate-200 bg-white p-4 space-y-2">
        <h1 className="font-semibold text-lg">皮膚科常用碼（{total}）</h1>
        {c.draft && (
          <p className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-900" data-testid="draft">
            此清單由 Claude 草擬，<b>待皮膚科醫師審閱</b>；代碼與是否可申報以健保署公告為準。
          </p>
        )}
        <nav className="flex flex-wrap gap-1.5 text-xs">
          {c.groups.map((g, i) => (
            <a key={g.name} href={`#/derm/${i}`} className="px-2 py-0.5 rounded-full bg-brand-50 text-brand-700 hover:bg-brand-100">{g.name}</a>
          ))}
        </nav>
        <input
          value={f}
          onChange={(e) => setF(e.target.value)}
          placeholder="在本清單內篩選（代碼、中文、英文）"
          className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
        />
      </header>
      {c.groups.map((g, i) => {
        const rows = g.codes.filter(hit);
        if (!rows.length) return null;
        return (
          <section key={g.name} id={`g-${i}`} className="rounded-xl border border-slate-200 bg-white px-4 py-3 scroll-mt-40">
            <h2 className="font-medium mb-1">{g.name}<span className="ml-1 text-xs text-slate-400">（{rows.length}）</span></h2>
            <ul className="divide-y divide-slate-100">
              {rows.map(([code, zh, en]) => (
                <li key={code} className="py-1.5 flex gap-2 items-baseline">
                  <a href={href.c(code)} className="code text-brand-700 w-20 shrink-0 hover:underline">{code}</a>
                  <span className="flex-1 min-w-0">
                    <span className="block sm:inline">{zh}</span>
                    <span className="block sm:inline sm:ml-2 text-xs text-slate-500">{en}</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => setFav(new Set(toggleFav(code).fav))}
                    className={`shrink-0 text-xs ${fav.has(code) ? 'text-amber-600' : 'text-slate-400 hover:text-amber-600'}`}
                    aria-label={fav.has(code) ? `從常用移除 ${code}` : `加入常用 ${code}`}
                    title={fav.has(code) ? '已加入常用' : '加入常用'}
                  >
                    {fav.has(code) ? '★' : '☆'}
                  </button>
                  <button
                    type="button"
                    onClick={() => copyCode({ code, zh, en })}
                    className="shrink-0 text-xs px-2 py-0.5 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 hover:text-brand-700"
                    aria-label={`複製 ${code}`}
                  >
                    複製
                  </button>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </article>
  );
}
