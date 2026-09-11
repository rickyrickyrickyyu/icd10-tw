import { useEffect, useState } from 'react';

/** 複製成功的短暫提示（clip.js 發 icd-toast 事件）。 */
export default function Toast() {
  const [msg, setMsg] = useState(null);
  useEffect(() => {
    let t;
    const on = (e) => { setMsg(e.detail); clearTimeout(t); t = setTimeout(() => setMsg(null), 1600); };
    window.addEventListener('icd-toast', on);
    return () => { window.removeEventListener('icd-toast', on); clearTimeout(t); };
  }, []);
  if (!msg) return null;
  return (
    <div role="status" className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 rounded-lg bg-slate-900/90 text-white text-sm px-3 py-1.5 shadow-lg" data-testid="toast">
      {msg}
    </div>
  );
}
