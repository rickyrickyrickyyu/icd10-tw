import { pushUsed } from './storage.js';

/**
 * 複製代碼：寫剪貼簿＋記入「最近用過」＋發 toast。
 * 醫師查碼的終點幾乎都是貼進 HIS，所以結果列、下拉清單、詳細頁都走這一個入口。
 * ★ 醫院舊版瀏覽器／非 https 內網鏡像沒有 navigator.clipboard，或會拒絕 → 退回 execCommand。
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

export function copyCode(it, text = it.code, pcs = false) {
  pushUsed(it.code, it.zh, it.en, pcs);
  const done = (ok) => window.dispatchEvent(new CustomEvent('icd-toast', { detail: ok ? `已複製 ${text}` : '複製失敗：請手動選取代碼' }));
  if (!navigator.clipboard) { done(legacyCopy(text)); return; }
  navigator.clipboard.writeText(text).then(() => done(true), () => done(legacyCopy(text)));
}
