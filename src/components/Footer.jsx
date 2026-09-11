import { isOffline, offlineMeta } from '../hooks/useData.js';

export default function Footer({ meta }) {
  const om = offlineMeta();
  return (
    <footer className="border-t border-slate-200 bg-white text-[11px] text-slate-500">
      <div className="max-w-5xl mx-auto px-3 sm:px-4 py-3 space-y-1">
        <p>
          非官方工具，以健保署公告為準｜資料快照 {meta?.built ?? '—'}
          {isOffline() && om && <>｜離線版（打包 {om.packed_at}）</>}
          ｜<a className="underline" href="#/about">資料來源與授權</a>
        </p>
        <p>健保署開放資料（政府資料開放授權條款第 1 版）、CDC/CMS ICD-10、Disease Ontology、Wikidata、NLM MeSH®、國家教育研究院。by M116 RickyYu</p>
      </div>
    </footer>
  );
}
