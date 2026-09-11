import { useEffect, useMemo, useState } from 'react';
import { href } from '../lib/routes.js';
import { addFavs } from '../lib/storage.js';
import { copyText } from '../lib/clip.js';
import { parseLines } from '../lib/batch.js';
import { notesFor } from '../lib/notesLoader.js';
import { excludes1Conflicts, reminders, satisfied } from '../lib/codingNotes.js';

const EXAMPLE = '1. Type 2 DM with diabetic nephropathy\n2. r/o cellulitis of left leg\n3. 異位性皮膚炎\n4. L400';

/**
 * 批次查碼：貼上多行診斷 → 每行用同一個搜尋引擎（Engine.search）查前 5 名。
 * ★ 不用 LLM、不連網、不儲存：貼上的文字只存在這個元件的 state，不寫 localStorage、不放網址。
 * 第一列 = 主診斷（可上下調整）；提醒標題碼、須另加編碼、Excludes1 衝突。
 */
export default function Batch({ core }) {
  const eng = core.engines.cm;
  const [text, setText] = useState('');
  const [rows, setRows] = useState([]);
  const [notes, setNotes] = useState(new Map());

  const find = (t) => (eng && t.trim() ? eng.search(t, { limit: 5 }).items : []);
  const run = () => setRows(parseLines(text).map((l, i) => ({ id: `${Date.now()}-${i}`, ...l, cands: find(l.text), pick: 0, on: true })));
  const upd = (i, patch) => setRows((rs) => rs.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  const move = (i, d) => setRows((rs) => {
    const j = i + d;
    if (j < 0 || j >= rs.length) return rs;
    const out = [...rs];
    [out[i], out[j]] = [out[j], out[i]];
    return out;
  });

  const picked = rows.filter((r) => r.on && r.cands[r.pick]).map((r) => r.cands[r.pick]);
  const codes = picked.map((p) => p.code);
  const key = codes.join(',');

  useEffect(() => {
    let alive = true;
    Promise.all([...new Set(codes)].map((c) => notesFor(c).then((n) => [c, n]).catch(() => [c, null])))
      .then((list) => alive && setNotes(new Map(list)));
    return () => { alive = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const conflicts = useMemo(() => excludes1Conflicts([...new Set(codes)], (c) => notes.get(c)), [key, notes]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-slate-200 bg-white p-4 space-y-2">
        <h1 className="font-semibold text-lg">批次查碼</h1>
        <p className="text-xs text-slate-600">
          一行一個診斷（也可用分號分隔），會自動去掉編號、Dx:、r/o、s/p。
          <b className="text-emerald-700">完全在這台裝置的瀏覽器處理：不用 AI、不上傳、不儲存。</b>
        </p>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={6}
          placeholder={EXAMPLE}
          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono"
          data-testid="batch-input"
        />
        <div className="flex flex-wrap gap-2 items-center text-sm">
          <button type="button" onClick={run} disabled={!eng || !text.trim()} className="px-3 py-1 rounded-lg bg-brand-700 text-white disabled:opacity-50" data-testid="batch-run">查碼</button>
          <button type="button" onClick={() => { setText(''); setRows([]); }} className="px-3 py-1 rounded-lg border border-slate-300">清除</button>
          {!text && <button type="button" onClick={() => setText(EXAMPLE)} className="text-xs underline text-slate-500">放入範例</button>}
          {!eng && <span className="text-xs text-slate-500">載入全部診斷中…</span>}
        </div>
      </section>

      {rows.length > 0 && (
        <section className="rounded-xl border border-slate-200 bg-white p-4 space-y-3" data-testid="batch-result">
          <div className="flex flex-wrap gap-2 items-baseline justify-between">
            <h2 className="font-medium">結果：納入 {picked.length}／{rows.length} 行<span className="ml-2 text-xs font-normal text-slate-500">第 1 列為主診斷，可用 ↑↓ 調整</span></h2>
            <div className="flex flex-wrap gap-2 text-sm">
              <button type="button" disabled={!codes.length} onClick={() => copyText(codes.join('\n'), `已複製 ${codes.length} 個代碼`)} className="px-2.5 py-1 rounded-lg border border-slate-300 hover:bg-slate-50 disabled:opacity-50" data-testid="batch-copy">複製代碼</button>
              <button type="button" disabled={!codes.length} onClick={() => copyText(picked.map((p) => `${p.code}\t${p.zh}`).join('\n'), '已複製代碼＋中文（Tab 分隔）')} className="px-2.5 py-1 rounded-lg border border-slate-300 hover:bg-slate-50 disabled:opacity-50">複製代碼＋中文</button>
              <button type="button" disabled={!codes.length} onClick={() => { const n = addFavs(codes); window.dispatchEvent(new CustomEvent('icd-toast', { detail: `已加入常用 ${n} 個` })); }} className="px-2.5 py-1 rounded-lg border border-slate-300 hover:bg-slate-50 disabled:opacity-50">全部加入常用</button>
            </div>
          </div>

          {conflicts.length > 0 && (
            <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-800" data-testid="batch-conflict">
              {conflicts.map((x) => (
                <p key={`${x.a}-${x.b}`}>⛔ <span className="code">{x.a}</span> 與 <span className="code">{x.b}</span> 依 Excludes1 不可同時編（{x.text}）</p>
              ))}
            </div>
          )}

          <ol className="divide-y divide-slate-100">
            {rows.map((r, i) => {
              const top = r.cands[r.pick];
              const rems = top && r.on ? reminders(notes.get(top.code) ?? { codeFirst: [], useAdd: [], codeAlso: [], excl1: [] }) : [];
              return (
                <li key={r.id} className={`py-2 flex gap-2 items-start ${r.on ? '' : 'opacity-50'}`} data-testid="batch-row">
                  <input type="checkbox" checked={r.on} onChange={(e) => upd(i, { on: e.target.checked })} className="mt-1.5 w-4 h-4" aria-label="納入" />
                  <span className="w-5 mt-1 text-xs text-slate-400 text-right">{i + 1}</span>
                  <div className="flex-1 min-w-0 space-y-1">
                    <div className="flex gap-2 items-center">
                      <input
                        value={r.text}
                        onChange={(e) => upd(i, { text: e.target.value, cands: find(e.target.value), pick: 0 })}
                        className="flex-1 min-w-0 text-sm rounded border border-slate-200 px-2 py-0.5"
                        aria-label="診斷文字"
                      />
                      {r.tag && <span className="shrink-0 text-[11px] px-1.5 rounded bg-violet-100 text-violet-800" title="疑似／術後：請確認是否該編這個碼">{r.tag}</span>}
                    </div>
                    {top ? (
                      <select
                        value={r.pick}
                        onChange={(e) => upd(i, { pick: Number(e.target.value) })}
                        className="w-full text-sm rounded border border-slate-300 px-1 py-0.5 bg-white"
                        data-testid="batch-pick"
                      >
                        {r.cands.map((c, k) => (
                          <option key={c.code} value={k}>
                            {c.code}　{c.zh}　— {c.en}{c.use === 0 ? '（標題碼，不可申報）' : ''}{c.def ? ' ★' : ''}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <p className="text-sm text-slate-500">查無結果 <a className="underline text-brand-700" href={href.q(r.text)}>到搜尋頁查</a></p>
                    )}
                    {top?.use === 0 && r.on && (
                      <p className="text-xs text-red-700">⚠ {top.code} 是標題碼，不可申報；請改選或到 <a className="underline" href={href.c(top.code)}>代碼頁</a> 選下層碼</p>
                    )}
                    {rems.map((rm) => {
                      const ok = satisfied(rm, codes);
                      return (
                        <p key={`${rm.kind}-${rm.text}`} className={`text-xs ${ok ? 'text-emerald-700' : 'text-amber-800'}`} data-testid="batch-note">
                          {ok ? '✓' : '⚠'} {rm.label}：{rm.text}{ok ? '（清單中已包含）' : ''}
                        </p>
                      );
                    })}
                  </div>
                  <div className="flex flex-col text-xs text-slate-500">
                    <button type="button" onClick={() => move(i, -1)} disabled={i === 0} className="px-1 disabled:opacity-30" aria-label="上移">↑</button>
                    <button type="button" onClick={() => move(i, 1)} disabled={i === rows.length - 1} className="px-1 disabled:opacity-30" aria-label="下移">↓</button>
                    <button type="button" onClick={() => setRows((rs) => rs.filter((_, k) => k !== i))} className="px-1 hover:text-red-700" aria-label="刪除">✕</button>
                  </div>
                </li>
              );
            })}
          </ol>
        </section>
      )}
    </div>
  );
}
