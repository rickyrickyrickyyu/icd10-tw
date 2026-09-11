import { pushUsed } from './storage.js';
import { notesFor } from './notesLoader.js';
import { reminders } from './codingNotes.js';

/**
 * 複製：寫剪貼簿＋發 toast。醫師查碼的終點幾乎都是貼進 HIS，所以結果列、下拉清單、
 * 詳細頁、常用清單、批次頁都走這裡。
 * ★ 醫院舊版瀏覽器／非 https 內網鏡像沒有 navigator.clipboard，或會拒絕 → 退回 execCommand。
 * ★ clipboard.writeText 要在使用者手勢內「同步」呼叫：先寫剪貼簿，才去 await 撰碼規則。
 */
function legacyCopy(text) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

function writeClip(text) {
  if (!navigator.clipboard) return Promise.resolve(legacyCopy(text));
  return navigator.clipboard.writeText(text).then(() => true, () => legacyCopy(text));
}

const toast = (detail) => window.dispatchEvent(new CustomEvent('icd-toast', { detail }));

export async function copyText(text, msg) {
  const ok = await writeClip(text);
  toast(ok ? msg : '複製失敗：請手動選取');
  return ok;
}

/** 複製一個碼；CM 碼另外查撰碼規則，有「須先編／須另加編碼／亦編」就在 toast 提醒。 */
export async function copyCode(it, text = it.code, pcs = false) {
  pushUsed(it.code, it.zh, it.en, pcs);
  const pending = writeClip(text);
  const ok = await pending;
  if (!ok) { toast('複製失敗：請手動選取代碼'); return; }
  let lines = [];
  if (!pcs) {
    try { lines = reminders(await notesFor(it.code)).slice(0, 3).map((r) => `${r.label}：${r.text}`); } catch { /* 規則載入失敗不影響複製 */ }
  }
  toast(lines.length ? { text: `已複製 ${text}`, lines } : `已複製 ${text}`);
}
