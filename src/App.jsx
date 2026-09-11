import { useEffect } from 'react';
import { useCore } from './hooks/useData.js';
import { useHashRoute } from './lib/routes.js';
import SearchBar from './components/SearchBar.jsx';
import Results from './components/Results.jsx';
import CodeDetail from './components/CodeDetail.jsx';
import PcsDetail from './components/PcsDetail.jsx';
import MapView from './components/MapView.jsx';
import CatView from './components/CatView.jsx';
import Changes from './components/Changes.jsx';
import About from './components/About.jsx';
import Favorites from './components/Favorites.jsx';
import Home from './components/Home.jsx';
import Footer from './components/Footer.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';

const SCOPES = [
  ['derm', '皮膚科'],
  ['cm', '全部診斷 CM'],
  ['pcs', '處置 PCS'],
];

export default function App() {
  const core = useCore();
  const route = useHashRoute();

  // 開 PCS 詳細頁時自動切到 PCS 範圍
  useEffect(() => {
    if (route.view === 'pcs' && core.scope !== 'pcs' && !core.loading) core.setScope('pcs');
  }, [route.view, core.scope, core.loading]); // eslint-disable-line react-hooks/exhaustive-deps

  // ★ 每個路由各自的 key：同一個元件在不同路由間重用時，第一次 render 會拿到上一頁的 state
  //   （ICD-9 頁 → 2014 頁時 MapView 的 data 還是 ICD-9 的物件 → targets.map 不是函式 → 整站白畫面）。
  const rk = `${route.view}:${route.key ?? route.q ?? ''}`;
  let body;
  if (core.loading) body = <p className="p-6 text-slate-500">載入中…</p>;
  else if (core.error && !core.eng) body = <p className="p-6 text-red-700">資料載入失敗：{core.error}</p>;
  else if (route.view === 'search') body = <Results core={core} q={route.q} />;
  else if (route.view === 'code' || route.view === 'heading') body = <CodeDetail key={rk} code={route.key} />;
  else if (route.view === 'pcs') body = <PcsDetail key={rk} code={route.key} />;
  else if (route.view === 'map14' || route.view === 'map9') body = <MapView key={rk} kind={route.view} code={route.key} />;
  else if (route.view === 'cat') body = <CatView key={rk} n={route.key} />;
  else if (route.view === 'changes') body = <Changes core={core} />;
  else if (route.view === 'about') body = <About meta={core.meta} />;
  else if (route.view === 'fav') body = <Favorites core={core} />;
  else body = <Home core={core} />;

  return (
    <div className="min-h-screen flex flex-col">
      <header className="sticky top-0 z-20 bg-white/95 backdrop-blur border-b border-slate-200">
        <div className="max-w-5xl mx-auto px-3 sm:px-4 py-2 flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <a href="#/" className="font-semibold text-brand-900 whitespace-nowrap">ICD-10 健保診斷碼查詢</a>
            <nav className="flex gap-3 text-sm text-slate-600">
              <a href="#/fav" className="hover:text-brand-700">常用碼</a>
              <a href="#/changes" className="hover:text-brand-700">本版異動</a>
              <a href="#/about" className="hover:text-brand-700">關於</a>
            </nav>
          </div>
          <SearchBar core={core} initial={route.view === 'search' ? route.q : ''} />
          <div className="flex items-center gap-1 text-xs" role="tablist" aria-label="查詢範圍">
            {SCOPES.map(([k, label]) => (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={core.scope === k}
                onClick={() => core.setScope(k)}
                className={`px-2.5 py-1 rounded-full border ${core.scope === k
                  ? 'bg-brand-700 text-white border-brand-700'
                  : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'}`}
              >
                {label}
              </button>
            ))}
            {core.building && <span className="ml-2 text-slate-500">建立索引中…</span>}
          </div>
        </div>
      </header>
      <main className="flex-1 max-w-5xl w-full mx-auto px-3 sm:px-4 py-4">
        <ErrorBoundary key={rk}>{body}</ErrorBoundary>
      </main>
      <Footer meta={core.meta} />
    </div>
  );
}
