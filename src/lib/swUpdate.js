/**
 * Service Worker 換版後強制重新載入一次。
 *
 * ★ 要解決的問題：
 *   vite-plugin-pwa 的 registerType: 'autoUpdate' 會設 skipWaiting + clientsClaim，
 *   新的 SW 確實會立刻接管 —— 但「已經渲染出來的那一頁」還是舊的 JS 與舊的
 *   app shell，要等使用者自己再重整一次才會看到新版。
 *
 *   對不定期改版的代碼表來說，這代表醫師更新後第一次打開看到的是
 *   上個月的版本，而且畫面上沒有任何線索告訴他這件事 —— 比查不到更危險。
 *
 * ★ 為什麼要判斷「原本就有 controller」：
 *   clientsClaim 會讓首次造訪（原本沒有 SW）也觸發 controllerchange。
 *   那次不是換版，是第一次安裝，重整只會讓首開閃一下。
 *   只有「本來就有舊 SW、現在被新的取代」才需要重整。
 *
 * ★ 為什麼用 sessionStorage 上鎖：
 *   萬一 SW 反覆接管（安裝失敗重試），無條件 reload 會變成無限重整迴圈，
 *   在門診電腦上等同當機。一個分頁最多只自動重整一次。
 */
const ONCE_KEY = 'icd.sw-reloaded';

export function watchSwUpdate() {
  const sw = navigator.serviceWorker;
  // dev server 沒有 sw.js（vite-plugin-pwa 只在 build 產生），硬註冊會拿到 index.html
  // → console 出現 "unsupported MIME type ('text/html')"，看起來像壞掉。
  // 離線包沒有 sw.js；用 http 開（例如本機 http.server 預覽）時硬註冊會 404
  if (!sw || import.meta.env.DEV || window.__ICD_OFFLINE__) return;

  // v12 以前的資料快取（NetworkFirst、無版本網址）會回舊資料，換成 icd-data-v2 後刪掉
  window.caches?.delete('icd-data-v1').catch(() => {});

  // 註冊當下就有 controller = 這台裝置已經裝過舊版
  const hadController = Boolean(sw.controller);

  // ★ 自己註冊而不是用 vite-plugin-pwa 產生的 registerSW.js：那支沒有 .catch()，
  //   在不支援 SW 的環境（本機預覽伺服器、file://）會丟未捕捉的 promise
  //   rejection。SW 只是加速用的，註冊失敗不該讓畫面看起來像壞了。
  window.addEventListener('load', () => {
    const base = import.meta.env.BASE_URL;
    sw.register(`${base}sw.js`, { scope: base }).catch(() => {
      // 本機預覽或 file:// 註冊不了 —— 這是預期內的，靜默略過。
      // 少了 SW 只代表沒有離線快取，頁面照常運作（而且永遠是最新的）。
    });
  });

  sw.addEventListener('controllerchange', () => {
    if (!hadController) return;             // 首次安裝，不是換版
    try {
      if (sessionStorage.getItem(ONCE_KEY)) return;
      sessionStorage.setItem(ONCE_KEY, '1');
    } catch {
      // 無痕模式下 sessionStorage 會丟例外。這時寧可不自動重整，
      // 也不要冒無限迴圈的風險。
      return;
    }
    window.location.reload();
  });
}
