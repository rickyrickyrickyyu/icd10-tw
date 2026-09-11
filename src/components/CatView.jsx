import { useEffect, useState } from 'react';
import { load, namesFor } from '../hooks/useData.js';
import { href } from '../lib/routes.js';

/** 重大傷病：類別清單（無參數）或某一類的所有 2023 碼。 */
export default function CatView({ n }) {
  const [st, setSt] = useState(null);
  useEffect(() => {
    load('cat.json').then(async (cat) => {
      const k = Number(n);
      // 類別清單頁不需要名稱；類別頁只載該類碼所在的首字母分片
      const codes = k ? Object.entries(cat.codes).filter(([, a]) => a.some(([c]) => c === k)).map(([c]) => c) : [];
      const rows = await namesFor(codes);
      setSt({ cat, names: new Map([...rows].map(([c, r]) => [c, r[1]])) });
    }).catch(() => setSt({ error: true }));
  }, [n]);
  if (!st) return <p className="text-slate-500">載入中…</p>;
  if (st.error) return <p className="text-red-700">載入失敗</p>;
  const { cat, names } = st;
  const k = Number(n);
  const counts = {};
  for (const arr of Object.values(cat.codes)) for (const [c] of arr) counts[c] = (counts[c] ?? 0) + 1;

  if (!k) {
    return (
      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <h1 className="font-semibold mb-2">重大傷病範圍（對照表 {cat.version} 版）</h1>
        <ul className="divide-y divide-slate-100 text-sm">
          {Object.entries(cat.categories).map(([i, name]) => (
            <li key={i} className="py-1.5"><a className="hover:underline" href={href.cat(i)}>第 {i} 類 {name ?? '（未命名）'}</a> <span className="text-slate-500">{counts[i] ?? 0} 碼</span></li>
          ))}
        </ul>
      </section>
    );
  }
  const list = Object.entries(cat.codes).filter(([, arr]) => arr.some(([c]) => c === k)).map(([code, arr]) => [code, arr.find(([c]) => c === k)[1]]).sort((a, b) => a[0].localeCompare(b[0]));
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <p className="text-xs"><a className="underline" href="#/cat/">所有類別</a></p>
      <h1 className="font-semibold">第 {k} 類 {cat.categories[k]}</h1>
      <p className="text-sm text-slate-600 mb-2">{list.length} 碼（依健保署 2014↔2023 重大傷病對照表 {cat.version} 版）</p>
      <ul className="divide-y divide-slate-100 text-sm">
        {list.map(([code, ni]) => (
          <li key={code} className="py-1.5">
            <a className="flex gap-3 hover:underline" href={href.c(code)}><span className="code text-brand-700 w-24 shrink-0">{code}</span><span>{names.get(code)}</span></a>
            {cat.notes[ni] && cat.notes[ni] !== '本次不受轉版影響' && <span className="block pl-[6.75rem] text-xs text-rose-700">{cat.notes[ni]}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}
