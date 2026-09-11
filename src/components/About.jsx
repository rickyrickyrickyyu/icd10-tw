import { useState } from 'react';
import { clearMisses, getPrefs } from '../lib/storage.js';
import { href } from '../lib/routes.js';

/** 關於本站：資料來源、授權與顯名、搜尋原理、免責、查不到的關鍵字。 */
export default function About({ meta }) {
  const s = meta?.sources ?? {};
  return (
    <article className="rounded-xl border border-slate-200 bg-white p-4 text-sm leading-6 space-y-4">
      <Misses />
      <section>
        <h1 className="text-lg font-semibold">關於本站</h1>
        <p>非官方工具。代碼、名稱與是否可申報，一律以<b>衛生福利部中央健康保險署</b>最新公告為準；申報結果由使用者自行負責。</p>
      </section>
      <section>
        <h2 className="font-medium">代碼本體</h2>
        <ul className="list-disc pl-5">
          <li>健保署《2023 年版中文版 ICD-10-CM/PCS（正式版）》、《2014↔2023 對應檔》、《ICD-9-CM↔2023 對應檔》（政府資料開放平臺 177507／177508／177509）。</li>
          <li>健保署《重大傷病 2014↔2023 ICD-10-CM 對照表》{s.catastrophic ? `（${s.catastrophic} 版）` : ''}。</li>
          <li className="text-xs text-slate-600">此開放資料依政府資料開放授權條款進行公眾釋出，使用者於遵守本條款各項規定之前提下，得利用之。條款全文：data.gov.tw/license</li>
        </ul>
      </section>
      <section>
        <h2 className="font-medium">搜尋用的詞彙層（入口詞）</h2>
        <ul className="list-disc pl-5">
          <li>CDC ICD-10-CM {s.cdc ?? 'FY2023'} Alphabetical Index、Tabular List、Neoplasm Table；CMS ICD-10-PCS {s.cms ?? '2023'} Index（美國政府公有領域）。</li>
          <li>Disease Ontology{s.doid ? `（${s.doid}）` : ''}（CC0）與 Wikidata（CC0）。</li>
          <li>MeSH® {s.mesh ?? ''}：本站使用美國國家醫學圖書館（NLM）的 MeSH 資料，經 Disease Ontology 對應至 ICD 碼。本站非 NLM 產品，NLM 未背書本站；MeSH 版本可能不是最新。</li>
          <li>國家教育研究院「醫學名詞」（政府資料開放授權）。</li>
          <li>俗稱與縮寫由本站人工策展，只收錄經醫師核可的條目。</li>
        </ul>
      </section>
      <section>
        <h2 className="font-medium">搜尋怎麼運作</h2>
        <ol className="list-decimal pl-5">
          <li>先修正英文拼字，再判斷是不是代碼（L40.0、L400、範圍、舊碼、ICD-9）。</li>
          <li>整句若恰好是某個入口詞（例：shingles、皮蛇），直接對應到該主題與其下層碼（explode），並標出<b>預設碼</b>。</li>
          <li>否則把查詢切成片段（中文用字典最長匹配），各段分別對應主題或當全文，段與段取交集。</li>
          <li>全文部分用 BM25（中文字元雙字、英文詞幹），結果依主題命中、覆蓋率排序；分數相近時可申報碼優先。</li>
        </ol>
        <p className="text-xs text-slate-500 mt-1">搜尋品質以固定題組持續量測（皮膚科臨床題、門診常見題、保留入口詞、錯字），每次改動都要不退步才上線。</p>
      </section>
      <section className="text-xs text-slate-500">
        <p>程式碼 MIT；資料層授權見 repo 的 DATA_LICENSE.md。本站不收集任何個人資料，常用碼只存在你的瀏覽器。</p>
      </section>
    </article>
  );
}

/**
 * 查不到（或結果不可信）的關鍵字：只存在這台裝置。複製給維護者後可補進俗稱／同義詞，
 * 搜尋會越用越準。放在「關於」頁最上面，但沒有資料時不顯示。
 */
function Misses() {
  const [list, setList] = useState(() => getPrefs().misses);
  const [msg, setMsg] = useState('');
  if (!list.length) return null;
  return (
    <section className="rounded-lg border border-amber-200 bg-amber-50 p-3" data-testid="misses">
      <h2 className="font-medium">查不到的關鍵字（{list.length}）</h2>
      <p className="text-xs text-slate-600">只記在這台裝置、不上傳。複製給維護者，確認後會加進俗稱／同義詞。</p>
      <p className="mt-1.5 flex flex-wrap gap-1.5">
        {list.map((q) => <a key={q} href={href.q(q)} className="px-1.5 rounded bg-white border border-amber-200 text-slate-700">{q}</a>)}
      </p>
      <p className="mt-2 flex gap-3 text-xs">
        <button type="button" className="underline" onClick={() => navigator.clipboard?.writeText(list.join('\n')).then(() => setMsg('已複製'), () => setMsg('複製失敗'))}>複製清單</button>
        <button type="button" className="underline text-slate-500" onClick={() => { setList(clearMisses().misses); setMsg(''); }}>清除</button>
        {msg && <span className="text-emerald-700">{msg}</span>}
      </p>
    </section>
  );
}
