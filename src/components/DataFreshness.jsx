import { useState } from 'react';
import { isOffline, offlineMeta } from '../hooks/useData.js';

const BASE = `${import.meta.env.BASE_URL}data`;
const CHECK_STALE_DAYS = 21;    // 每週自動檢查；超過 3 週沒檢查 = 排程可能壞了
const OFFLINE_STALE_DAYS = 60;

/**
 * 資料新鮮度。代碼表不定期更新，所以看的是「最後一次自動檢查」（checked_at，
 * 每週部署時注入），不是「資料內容最後改變」—— 前者停了才代表有問題。
 */
async function hardReload() {
  try {
    const regs = await navigator.serviceWorker?.getRegistrations?.() ?? [];
    await Promise.all(regs.map((r) => r.unregister()));
    if (window.caches) await Promise.all((await caches.keys()).map((k) => caches.delete(k)));
  } catch { /* 清不掉也要重載 */ }
  window.location.replace(`${window.location.pathname}?fresh=${Date.now()}${window.location.hash}`);
}

const days = (iso) => (iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 86400000) : null);

export default function DataFreshness({ meta }) {
  const [st, setSt] = useState({ checking: false, msg: null, outdated: false });
  const offline = isOffline();
  const checked = meta?.checked_at ?? meta?.built;
  const age = days(checked);
  const om = offlineMeta();
  const offAge = offline ? days(om?.packed_at) : null;
  const stale = offline ? offAge > OFFLINE_STALE_DAYS : age != null && age > CHECK_STALE_DAYS;

  const check = async () => {
    setSt({ checking: true, msg: null, outdated: false });
    try {
      const fresh = await (await fetch(`${BASE}/meta.json?t=${Date.now()}`, { cache: 'reload' })).json();
      const outdated = fresh.data_fingerprint !== meta?.data_fingerprint;
      setSt({ checking: false, outdated, msg: outdated ? `伺服器有新版資料（快照 ${fresh.built}）。` : `已是最新（快照 ${fresh.built}，最後檢查 ${fresh.checked_at ?? fresh.built}）。` });
    } catch {
      setSt({ checking: false, outdated: false, msg: '無法連線，目前顯示的是離線快取。' });
    }
  };

  return (
    <div className={`rounded-xl border p-3 text-sm ${stale ? 'border-amber-300 bg-amber-50' : 'border-slate-200 bg-white'}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span>資料快照 {meta?.built ?? '—'}{!offline && checked && <span className="text-xs text-slate-500 ml-2">最後自動檢查 {checked}（{age} 天前）</span>}</span>
        {!offline && (
          <button type="button" onClick={check} disabled={st.checking} className="text-xs px-2.5 py-1 rounded-lg border border-slate-300 hover:bg-slate-50 disabled:opacity-50">
            {st.checking ? '檢查中…' : '檢查更新'}
          </button>
        )}
      </div>
      {offline && <p className="mt-1 text-xs text-slate-600">離線版（{om?.packed_at} 打包），不會自動更新。{offAge > OFFLINE_STALE_DAYS && '已超過 60 天，請到 GitHub Releases 下載新版。'}</p>}
      {!offline && stale && <p className="mt-1 text-amber-900">⚠️ 已超過 {CHECK_STALE_DAYS} 天沒有自動檢查，更新排程可能故障，資料可能不是最新。</p>}
      {st.msg && (
        <p className={`mt-1 ${st.outdated ? 'text-amber-900' : 'text-slate-700'}`}>
          {st.msg}
          {st.outdated && <button type="button" onClick={hardReload} className="ml-2 text-xs px-2 py-0.5 rounded-lg border border-amber-400 bg-white">立即套用最新版</button>}
        </p>
      )}
    </div>
  );
}
