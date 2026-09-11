import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

// ★ CSP 只加在線上版（沿用 nhi-drug-rules）。離線版是單一 HTML、資料與程式都內嵌成
//   inline script，`script-src 'self'` 會直接把它擋死；離線版的保證來自
//   build_offline.py 的靜態檢查。connect-src 'self'：只讀自己 origin 的 data/*.json。
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self' blob:",            // 搜尋索引若搬進 Web Worker 用
  "form-action 'none'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-src 'none'",
].join('; ');

const cspPlugin = {
  name: 'icd-csp',
  transformIndexHtml(html) {
    return html.replace(
      '<meta charset="UTF-8" />',
      `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`,
    );
  },
};

export default defineConfig(({ mode }) => {
  const offline = mode === 'offline';

  return {
  base: offline ? './' : '/icd10-tw/',
  build: offline
    ? {
        outDir: 'dist-offline',
        assetsInlineLimit: 100_000_000,
        cssCodeSplit: false,
        rollupOptions: { output: { inlineDynamicImports: true } },
      }
    : {},
  plugins: [
    ...(offline ? [] : [cspPlugin]),
    react(),
    tailwindcss(),
    ...(offline ? [] : [VitePWA({
      registerType: 'autoUpdate',
      injectRegister: null,               // 自己註冊，見 src/lib/swUpdate.js
      manifest: {
        name: 'ICD-10 健保診斷碼查詢',
        short_name: 'ICD-10',
        lang: 'zh-TW',
        display: 'standalone',
        background_color: '#ffffff',
        theme_color: '#3730a3',
        icons: [{ src: 'icon-512.png', sizes: '512x512', type: 'image/png' }],
      },
      workbox: {
        // ★ 不 precache index.html、關掉 navigateFallback（理由見 nhi-drug-rules：
        //   precache 後新版部署第一次打開拿到舊 HTML→舊 bundle，毫無線索）
        globPatterns: ['**/*.{js,css,svg,png,ico,webmanifest}'],
        navigateFallback: null,
        runtimeCaching: [
          {
            urlPattern: ({ request }) => request.mode === 'navigate',
            handler: 'NetworkFirst',
            options: {
              cacheName: 'icd-shell-v1',
              networkTimeoutSeconds: 4,
              expiration: { maxEntries: 4, maxAgeSeconds: 60 * 60 * 24 * 180 },
            },
          },
          {
            // meta.json 決定資料版本：網路優先，離線時才用快取
            urlPattern: /\/data\/meta\.json/,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'icd-meta-v2',
              networkTimeoutSeconds: 5,
              expiration: { maxEntries: 4 },
            },
          },
          {
            // ★ 其他資料網址都帶 ?v=<指紋>，同一網址內容永不變 → CacheFirst。
            //   v1 用 NetworkFirst＋3 秒逾時，慢網路會拿到舊版詞彙（見 useData.getJson）。
            urlPattern: /\/data\/.*\.json\?v=/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'icd-data-v2',
              // 分片多（nodes/map14/map9/detail/pdetail），留足空間；舊版本網址 90 天後自然淘汰
              expiration: { maxEntries: 600, maxAgeSeconds: 60 * 60 * 24 * 90 },
            },
          },
        ],
      },
    })]),
  ],
  };
});
