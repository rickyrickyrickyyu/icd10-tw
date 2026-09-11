import { useEffect, useState } from 'react';

/**
 * 複製成功的短暫提示（clip.js 發 icd-toast 事件）。
 * detail 可以是字串，或 {text, lines}（撰碼規則提醒：顯示較久，點一下關閉）。
 */
export default function Toast() {
  const [msg, setMsg] = useState(null);
  useEffect(() => {
    let t;
    const on = (e) => {
      const m = typeof e.detail === 'string' ? { text: e.detail, lines: [] } : e.detail;
      setMsg(m);
      clearTimeout(t);
      t = setTimeout(() => setMsg(null), m.lines?.length ? 8000 : 1600);
    };
    window.addEventListener('icd-toast', on);
    return () => { window.removeEventListener('icd-toast', on); clearTimeout(t); };
  }, []);
  if (!msg) return null;
  return (
    <div
      role="status"
      onClick={() => setMsg(null)}
      className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 w-max max-w-[92vw] rounded-lg bg-slate-900/90 text-white text-sm px-3 py-1.5 shadow-lg cursor-pointer"
      data-testid="toast"
    >
      <p>{msg.text}</p>
      {msg.lines?.length > 0 && (
        <ul className="mt-1 text-xs text-amber-200 space-y-0.5" data-testid="toast-notes">
          {msg.lines.map((l) => <li key={l}>⚠ {l}</li>)}
        </ul>
      )}
    </div>
  );
}
