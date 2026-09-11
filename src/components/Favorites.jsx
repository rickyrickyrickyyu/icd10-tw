import { useEffect, useState } from 'react';
import { namesFor } from '../hooks/useData.js';
import { getPrefs, importFav, toggleFav } from '../lib/storage.js';
import { cmCode } from '../lib/search/query.js';
import { href } from '../lib/routes.js';

const PREFIX = 'ICDTW1:';

/**
 * 常用碼：只存在這台裝置的瀏覽器。跨裝置用「匯出碼」搬（一段純文字，貼到 LINE／email 給自己），
 * 匯入時只收 2023 版真的存在的碼（不讓打錯的字串混進常用清單）。
 */
export default function Favorites() {
  const [fav, setFav] = useState(() => getPrefs().fav);
  const [names, setNames] = useState(null);
  const [imp, setImp] = useState('');
  const [msg, setMsg] = useState('');
  useEffect(() => { namesFor(fav).then(setNames).catch(() => setNames(new Map())); }, [fav]);

  const exportText = `${PREFIX}${fav.join(',')}`;
  const copy = (t, ok) => navigator.clipboard?.writeText(t).then(() => setMsg(ok), () => setMsg('複製失敗，請手動選取文字'));
  const copyAll = () => copy(fav.map((c) => `${c}\t${names?.get(c)?.[1] ?? ''}`).join('\n'), '已複製（Tab 分隔，可貼進 Excel）');

  const doImport = async () => {
    const tokens = [...new Set(imp.replace(PREFIX, '').split(/[\s,，;；、]+/).map((x) => x.trim()).filter(Boolean))];
    const uniq = [...new Set(tokens.map((x) => cmCode(x)).filter(Boolean))];
    const have = await namesFor(uniq).catch(() => new Map());
    const ok = uniq.filter((c) => have.has(c));
    const n = importFav(ok);
    const skipped = tokens.length - ok.length;
    setFav(getPrefs().fav);
    setImp('');
    setMsg(`匯入 ${n} 個新碼${skipped > 0 ? `；${skipped} 個不是 2023 版的碼已略過` : ''}`);
  };

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
      <div className="flex items-baseline justify-between gap-2">
        <h1 className="font-semibold">常用碼（{fav.length}）</h1>
        {fav.length > 0 && <button type="button" onClick={copyAll} className="text-xs underline">全部複製（Tab 分隔，可貼進 Excel）</button>}
      </div>
      <p className="text-xs text-slate-500">只存在這台裝置的瀏覽器裡。換電腦請用下方「匯出／匯入」。</p>
      {fav.length === 0 ? <p className="text-sm text-slate-600">在代碼頁或「皮膚科常用」清單按「☆ 加入常用」。</p> : (
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

      <div className="rounded-lg bg-slate-50 border border-slate-200 p-3 space-y-2 text-sm" data-testid="fav-transfer">
        <h2 className="font-medium">匯出／匯入（跨裝置）</h2>
        {fav.length > 0 && (
          <div className="flex gap-2 items-start">
            <code className="flex-1 min-w-0 break-all text-xs bg-white border border-slate-200 rounded px-2 py-1" data-testid="fav-export">{exportText}</code>
            <button type="button" onClick={() => copy(exportText, '已複製匯出碼，貼到另一台裝置的「匯入」')} className="shrink-0 text-xs px-2 py-1 rounded-lg border border-slate-300 bg-white hover:bg-slate-50">複製匯出碼</button>
          </div>
        )}
        <div className="flex gap-2 items-start">
          <textarea
            value={imp}
            onChange={(e) => setImp(e.target.value)}
            rows={2}
            placeholder="貼上匯出碼（ICDTW1:…），或直接貼一串代碼（逗號、空白、換行分隔皆可）"
            className="flex-1 min-w-0 text-xs rounded border border-slate-300 px-2 py-1"
            data-testid="fav-import"
          />
          <button type="button" onClick={doImport} disabled={!imp.trim()} className="shrink-0 text-xs px-2 py-1 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 disabled:opacity-50">匯入</button>
        </div>
        {msg && <p className="text-xs text-emerald-700" role="status">{msg}</p>}
      </div>
    </section>
  );
}
