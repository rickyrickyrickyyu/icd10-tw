/**
 * MeSH 式搜尋引擎（瀏覽器與 node 共用）。
 *
 * 管線（照 PubMed Automatic Term Mapping 的順序）：
 *   0. 拼字修正：先修正再做 ATM（v2 以前反過來，「breat cancer」的 breat 被當成
 *      「已滿足」的空段，cancer→C80.1 搶到第一）
 *   1. 代碼：L40.0 / L400 / 範圍 / 前綴
 *   2. 整句 ATM：查詢的片語鍵（詞集合）若等於某入口詞 → 對應到主題（ICD 節點）
 *   3. 切段 ATM：整句沒對到 → 用字典做最長匹配切段，各段對應主題或留作自由詞，段與段 AND
 *   4. 自由文字：BM25（中文 bigram、英文 stem、最後一詞前綴）
 *   5. 合併：主題命中（含 explode 子孫）加權在前，自由文字其後；分數相近時可申報碼優先
 *
 * 權重常數集中在 CONFIG，基準測試（tests/bench）迭代時只改這裡。
 * 迭代紀錄見 tests/bench/bench_history.jsonl。
 */
import { CJK, bigrams, keyOf, norm, parts, phraseKey, stem, tokens, tokensOf } from './normalize.js';
import { parseQuery } from './query.js';
import { facetsOf } from './facets.js';
import { sideOf, siteConflict, siteOk } from './side.js';

export const CONFIG = {
  srcWeight: {
    title: 1.0, 'cdc-idx': 0.85, 'cdc-see': 0.8, 'cdc-incl': 0.85, 'cdc-neo': 0.6,
    doid: 0.75, 'doid-rel': 0.5, mesh: 0.7, zh14: 0.75, zh9: 0.55, naer: 0.7,
    'cur-zh': 0.95, 'cur-abbr': 0.95, 'cms-idx': 0.8, en9: 0.5, wd: 0.7, 'wd-alias': 0.6, 'fix-zh': 0.95,
  },
  fieldWeight: { zh: 1.0, en: 1.0, entry: 0.6 },
  k1: 1.2,
  b: 0.3,
  atmNode: 60,        // 整句 ATM 命中節點本身
  atmExplode: 25,     // explode 子孫
  segBonus: 12,       // 切段 ATM：每一段由主題滿足
  minCoverage: 0.5,   // 自由文字：至少涵蓋多少比例的查詢詞（分母不含 df=0 的詞）
  segHit: 0.75,       // 切段：一段的詞至少命中多少比例才算該段成立
  headerDemote: 0.97, // 標題碼（USE=0，不可申報）分數打折：同分時可申報的子碼排前面
  fuzzyMinLen: 4,     // stem 後長度；v2 為 5，「hievs」stem 成 4 字元就不修了
  gapWeight: 0.5,     // 中文跳一字字對的權重（0 = 關閉；v6 加入）
  manifestDemote: 0.9, // 「in diseases classified elsewhere」表現碼（v11）
  cdcDefBonus: 1.08,  // 整句命中時，CDC 字母索引直接給的碼（真正的預設碼）加分（v11）
  negationDemote: 0.6, // 查詢詞在標題裡是被否定的（「未伴有敗血性休克」、"without septic shock"）（v13）
  // ── 側別＋部位（v16，只在查詢含左／右／雙側時作用；見 side.js、lateralize()）──
  sideMatch: 1.3,     // 側別相符
  sideOther: 0.5,     // 側別相反（問左側卻是右側／雙側）
  sideUnspec: 0.8,    // 「未明示側」
  sideOffTopic: 0.8,  // 側別相符但和該類目主題不是同一個病（結膜炎 → 眼瞼結膜炎 H10.501）
  sideNone: 0.85,     // 名稱沒有側別
  siteMiss: 0.75,     // 查詢有部位（腿、膝…）但這個碼的名稱對不上
  siteConflict: 0.5,  // 名稱是另一個部位（問手臂卻是手指；「右手」字對讓 L03.011 手指搶過 L03.113 上肢）
  laterDemote: 0.9,   // 後續照護／後遺症（查詢沒講就降）
  openDemote: 0.9,    // 開放性骨折（查詢沒講就降，預設閉鎖性）
  sideTopK: 5,        // 前幾名候選去找「側別＋部位相符」的同類目可申報碼
  sideGeneric: 2,     // 同類目多個相符時，偏好 unspecified／primary（醫師沒講細分型）
  sideHint: 3,        // 同類目挑碼：名稱符合細部提示（distal ↔ lower end）加分
  sideGenericMul: 1.06, // 側別相符的候選裡，通用碼（unspecified part／primary）略加分：
                        // 「右肺癌」C34.31 下葉只贏 C34.91 2%、「left femoral neck fracture」S72.042A 基部贏 4%
  sideStrip: true,    // ATM 用去掉側別字的查詢（A/B 測試用開關）
  sideMember: 0.99,   // 找到的碼 ＝ 原候選分數 × sideMatch × 此值
  obstetricDemote: 0.85, // 查詢沒提懷孕，妊娠章（O 碼）略降（v16：「慢性腎臟病第三期」被「妊娠第三期」搶走）
  prefixMin: 3,
  limit: 60,
};

const ZH_SPLIT = /[，、,;；:：()（）[\]［］〔〕「」\s/]+|未伴有|伴有|併有|合併|所致|引起|及|與|或|之|的/;
const MAXBIT = 30;

const isSubseq = (a, b) => { let i = 0; for (const ch of b) if (ch === a[i]) i += 1; return i === a.length; };
const lower = (a, x) => { let lo = 0; let hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < x) lo = m + 1; else hi = m; } return lo; };
const popcount = (x) => { let n = 0; while (x) { x &= x - 1; n += 1; } return n; };

function editDist(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d = [];
  for (let i = 0; i <= a.length; i += 1) { d[i] = [i]; }
  for (let j = 1; j <= b.length; j += 1) d[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    let rowMin = Infinity;
    for (let j = 1; j <= b.length; j += 1) {
      const c = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      rowMin = Math.min(rowMin, d[i][j]);
    }
    if (rowMin > max) return max + 1;
  }
  return d[a.length][b.length];
}

export class Engine {
  /**
   * @param rows   [[code, zh, en, use, st, rev], ...]（已依官方順序）
   * @param vocab  {src: [...], t: [[text, code, srcIdx, flags], ...]}
   * @param opts   {kind: 'cm'|'pcs', exclude: (vocabRow) => bool}
   */
  constructor(rows, vocab, opts = {}) {
    this.kind = opts.kind ?? 'cm';
    this.rows = rows;
    this.codes = rows.map((r) => r[0]);
    this.id = new Map(this.codes.map((c, i) => [c, i]));
    const order = this.codes.map((_, i) => i).sort((a, b) => (this.codes[a] < this.codes[b] ? -1 : this.codes[a] > this.codes[b] ? 1 : 0));
    this.sortedIdx = Int32Array.from(order);
    this.sortedCodes = order.map((i) => this.codes[i]);
    this.srcNames = vocab?.src ?? [];
    this.defaults = vocab?.def ?? {};           // 標題碼 → 預設可申報子碼（build_vocab 產生）
    this.cdcIdx = new Set(['cdc-idx', 'cdc-see'].map((n) => this.srcNames.indexOf(n)).filter((i) => i >= 0));
    this.abbr = new Map(Object.entries(vocab?.abbr ?? {}));   // 縮寫 → 全名（多字查詢時展開）
    const ex = opts.exclude;
    this.vt = (vocab?.t ?? []).filter((v) => !(ex && ex(v)));     // 本索引實際使用的入口詞
    const t0 = Date.now();

    // ★ 記憶體：v1 的片語表值是 [[code, src, flags], ...]，305k 鍵吃掉 114 MB。
    //   改存整數：>=0 = this.vt 的列號；<0 = -(doc+1)，表示該 doc 的官方名稱。
    const phrase = new Map();
    const addPhrase = (k, val) => {
      if (!k) return;
      const cur = phrase.get(k);
      if (cur === undefined) phrase.set(k, val);
      else if (typeof cur === 'number') phrase.set(k, [cur, val]);
      else cur.push(val);
    };
    const zhDict = new Set();
    const addZh = (zhRuns) => {
      for (const r of zhRuns) {
        if (r.length >= 2 && r.length <= 12) zhDict.add(r);
        for (const p of r.split(ZH_SPLIT)) if (p.length >= 2 && p.length <= 12) zhDict.add(p);
      }
    };

    // 倒排索引：先逐 doc 聚合，再灌進 typed array
    const W = CONFIG.fieldWeight;
    const sw = this.srcNames.map((n) => CONFIG.srcWeight[n] ?? 0.5);
    const docEntries = rows.map(() => []);
    this.vt.forEach((v, i) => { const d = this.id.get(v[1]); if (d !== undefined) docEntries[d].push(i); });
    const tmp = new Map();
    const len = new Float32Array(rows.length);
    const local = new Map();
    const bump = (t, w) => local.set(t, Math.max(local.get(t) ?? 0, 0) + w);
    // ★ 中文跳一字的字對：文件的「腎臟病」同時以「腎病」（半權重）入索引，查詢端不變。
    //   官方用語不一致（「腎臟病變」vs 使用者打的「腎病變」、「股骨頸部」vs「股骨頸」）
    //   時，正確答案的 bigram 覆蓋率會跟無關碼一樣低。只補「沒有真 bigram」的字對，免得重複加分。
    const gap = (zhRuns, w) => {
      for (const r of zhRuns) {
        for (let k = 0; k + 2 < r.length; k += 1) {
          const t = r[k] + r[k + 2];
          if (!local.has(t)) local.set(t, w * CONFIG.gapWeight);
        }
      }
    };
    rows.forEach((r, d) => {
      local.clear();
      const pz = parts(r[1]); const pe = parts(r[2]);
      addPhrase(keyOf(pz), -(d + 1)); addPhrase(keyOf(pe), -(d + 1));
      addZh(pz.zh);
      for (const t of tokensOf(pz)) bump(t, W.zh);
      for (const t of tokensOf(pe)) bump(t, W.en);
      const zhEntries = [];
      for (const i of docEntries[d]) {
        const v = this.vt[i];
        const p = parts(v[0]);
        addPhrase(keyOf(p), i);
        addZh(p.zh);
        const w = W.entry * (sw[v[2]] ?? 0.5);
        for (const t of new Set(tokensOf(p))) bump(t, w);   // 同一筆入口詞重複 token 只算一次
        if (p.zh.length) zhEntries.push([p.zh, w]);
      }
      if (CONFIG.gapWeight > 0) {
        gap(pz.zh, W.zh);
        for (const [runs, w] of zhEntries) gap(runs, w);
      }
      for (const [t, w] of local) {
        let p = tmp.get(t);
        if (!p) { p = [[], []]; tmp.set(t, p); }
        p[0].push(d); p[1].push(w);
        len[d] += w;
      }
    });
    // 指向「不在本 CM 主檔」的入口詞（PCS 表前綴等）也要進片語表
    this.vt.forEach((v, i) => { if (!this.id.has(v[1])) { const p = parts(v[0]); addPhrase(keyOf(p), i); addZh(p.zh); } });
    this.entries = docEntries.map((a) => Int32Array.from(a));
    this.phrase = phrase;
    this.zhDict = zhDict;
    this.maxZhWord = 12;
    this.post = new Map();
    for (const [t, [ds, ws]] of tmp) this.post.set(t, { d: Int32Array.from(ds), w: Float32Array.from(ws) });
    this.len = len;
    this.avgLen = len.reduce((a, b) => a + b, 0) / Math.max(1, rows.length);
    this.vocabEn = [...this.post.keys()].filter((t) => !CJK.test(t)).sort();
    this.tokCache = new Map();
    // 有分側的碼群（碼的前 5 字元）：沒寫側別的碼只有在這種群裡才因「沒有側別」被降（v16）。
    // G51.0 Bell 氏麻痺本身不分側 → 查「左側顏面神經麻痺」不該輸給 G51.32 左側半顏面痙攣。
    this.latPrefix5 = new Set();
    for (const r of rows) if (facetsOf({ en: r[2], use: r[3] }).lat) this.latPrefix5.add(r[0].slice(0, 5));
    this.buildMs = Date.now() - t0;
  }

  /** 片語表的整數值 → [[code, srcIdx(-1=官方名), flags], ...] */
  expand(val) {
    const arr = typeof val === 'number' ? [val] : val;
    return arr.map((x) => (x < 0 ? [this.codes[-x - 1], -1, 0] : [this.vt[x][1], this.vt[x][2], this.vt[x][3]]));
  }

  lookup(text) {
    const v = this.phrase.get(phraseKey(text));
    return v === undefined ? null : this.expand(v);
  }

  df(tok) { return this.post.get(tok)?.d.length ?? 0; }

  idf(tok) {
    const n = this.df(tok);
    return Math.log(1 + (this.rows.length - n + 0.5) / (n + 0.5));
  }

  docTexts(d) {
    return [this.rows[d][1], this.rows[d][2], ...Array.from(this.entries[d], (i) => this.vt[i][0])];
  }

  docTokens(d) {
    let s = this.tokCache.get(d);
    if (!s) {
      s = new Set();
      for (const t of this.docTexts(d)) for (const x of tokens(t)) s.add(x);
      if (this.tokCache.size > 5000) this.tokCache.clear();
      this.tokCache.set(d, s);
    }
    return s;
  }

  descendants(code) {
    const out = [];
    for (let i = lower(this.sortedCodes, code); i < this.sortedCodes.length && this.sortedCodes[i].startsWith(code); i += 1) {
      out.push(this.sortedIdx[i]);
    }
    return out;
  }

  /**
   * 拼字修正。候選排序：
   *   1. 編輯距離取「原字」與「stem 後」兩者較小者（stem 會先砍掉尾巴，
   *      gastroenterits → gastroenterit，離 gastroenteritis 反而變成 2）
   *   2. 查詢是候選的子序列者優先 —— 最常見的錯字是漏打字母（breat→breast、cest→chest）
   *   3. 長度差小者優先（hiev→hive 是對調，不該輸給刪字的 hiv）
   *   4. 最後才比常見度（df）。v4 只比 df，hiev→hiv、cest→cyst。
   */
  correct(tok, raw = tok) {
    if (raw.length < CONFIG.fuzzyMinLen || this.post.has(tok) || /\d/.test(tok)) return null;
    const max = tok.length >= 9 ? 2 : 1;
    const cands = [];
    let bestD = max + 1;
    for (let i = lower(this.vocabEn, tok[0]); i < this.vocabEn.length && this.vocabEn[i][0] === tok[0]; i += 1) {
      const w = this.vocabEn[i];
      if (Math.abs(w.length - tok.length) > max + 1) continue;
      const dd = Math.min(editDist(tok, w, max), editDist(raw, w, max));
      if (dd > max || dd > bestD) continue;
      if (dd < bestD) { bestD = dd; cands.length = 0; }
      cands.push(w);
    }
    if (!cands.length) return null;
    const key = (w) => [isSubseq(tok, w) || isSubseq(raw, w) ? 0 : 1, Math.abs(w.length - tok.length), -this.df(w)];
    return cands.sort((a, b) => {
      const ka = key(a); const kb = key(b);
      return ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2];
    })[0];
  }

  /** 整句拼字修正：英文詞 stem 後不在索引裡才修，中文與數字不動。 */
  correctText(text) {
    const corrections = [];
    const expansions = [];                      // 縮寫展開與拼字修正分開記，畫面上標示不同
    const words = norm(text).split(' ');
    // ★ 多字查詢時把已核可縮寫展開成全名（「BCC nose」→ basal cell carcinoma nose）：
    //   縮寫本身只對到一個碼（C44.91），和部位詞 AND 起來會落空，v11 線上實測 C44.311 只排第二。
    //   單獨查縮寫時不展開，直接走入口詞對應。
    const multi = words.filter(Boolean).length > 1;
    const out = words.map((w) => {
      if (!w || CJK.test(w)) return w;
      if (multi && this.abbr.has(w)) { expansions.push([w, this.abbr.get(w)]); return this.abbr.get(w); }
      const fix = this.correct(stem(w), w);
      if (fix) { corrections.push([w, fix]); return fix; }
      return w;
    });
    return { text: out.join(' '), corrections, expansions };
  }

  prefixExpand(tok) {
    const out = [];
    for (let i = lower(this.vocabEn, tok); i < this.vocabEn.length && this.vocabEn[i].startsWith(tok) && out.length < 40; i += 1) {
      if (this.vocabEn[i] !== tok) out.push(this.vocabEn[i]);
    }
    return out;
  }

  segmentZh(run) {
    const n = run.length;
    const best = Array.from({ length: n + 1 }, () => null);
    best[0] = { cost: 0, segs: [] };
    for (let i = 0; i < n; i += 1) {
      if (!best[i]) continue;
      for (let L = Math.min(this.maxZhWord, n - i); L >= 1; L -= 1) {
        const w = run.slice(i, i + L);
        const inDict = L >= 2 && this.zhDict.has(w);
        if (!inDict && L > 1) continue;
        const cost = best[i].cost + (inDict ? 1 : 3);
        if (!best[i + L] || cost < best[i + L].cost) best[i + L] = { cost, segs: [...best[i].segs, { w, dict: inDict }] };
      }
    }
    const merged = [];
    for (const s of best[n].segs) {
      const last = merged[merged.length - 1];
      if (!s.dict && last && !last.dict) last.w += s.w; else merged.push({ ...s });
    }
    return merged;
  }

  segments(text) {
    const whole = this.lookup(text);
    if (whole) return { whole: true, segs: [{ text, mapped: whole }] };
    const segs = [];
    const words = norm(text).split(' ').filter(Boolean);
    let i = 0;
    while (i < words.length) {
      const w = words[i];
      if (CJK.test(w)) {
        for (const s of this.segmentZh(w)) segs.push({ text: s.w, mapped: s.dict ? this.lookup(s.w) : null });
        i += 1;
        continue;
      }
      let hit = null;
      for (let L = Math.min(5, words.length - i); L >= 1; L -= 1) {
        const span = words.slice(i, i + L);
        if (span.some((x) => CJK.test(x))) continue;
        const m = this.lookup(span.join(' '));
        if (m && (L > 1 || parts(span[0]).en.length)) { hit = { text: span.join(' '), mapped: m, L }; break; }
      }
      if (hit) { segs.push(hit); i += hit.L; } else { segs.push({ text: w, mapped: null }); i += 1; }
    }
    return { whole: false, segs };
  }

  /**
   * 自由文字 BM25。每個 doc 另記一個 bitmask：哪些查詢詞命中。
   * ★ 切段判定直接看 bitmask（O(1)）；v1 對每個候選重新斷詞所有入口詞，p95 300 ms。
   */
  bm25(text) {
    const { en, zh } = parts(text);
    const qt = [];                                  // [主 token, [替代 token...]]
    en.forEach((t, i) => {
      if (this.post.has(t)) { qt.push([t, [t]]); return; }
      const pre = i === en.length - 1 && t.length >= CONFIG.prefixMin ? this.prefixExpand(t) : [];
      qt.push([t, pre]);
    });
    for (const r of zh) for (const b of bigrams(r)) qt.push([b, [b]]);
    const live = qt.filter(([, alts]) => alts.some((t) => this.post.has(t)));
    const bit = new Map(live.map(([t], qi) => [t, 1 << Math.min(qi, MAXBIT)]));
    const acc = new Map();
    const { k1, b } = CONFIG;
    live.forEach(([, alts], qi) => {
      const seen = new Map();
      for (const t of alts) {
        const pl = this.post.get(t);
        if (!pl) continue;
        const idf = this.idf(t);
        for (let j = 0; j < pl.d.length; j += 1) {
          const d = pl.d[j]; const tf = pl.w[j];
          const s = idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * this.len[d] / this.avgLen));
          if (s > (seen.get(d) ?? 0)) seen.set(d, s);
        }
      }
      const m = 1 << Math.min(qi, MAXBIT);
      for (const [d, s] of seen) {
        let a = acc.get(d);
        if (!a) { a = { score: 0, hit: 0, mask: 0 }; acc.set(d, a); }
        a.score += s;
        a.hit += 1;
        a.mask |= m;
      }
    });
    return { acc, n: live.length, bit };
  }

  scanChar(ch) {
    const out = new Map();
    this.rows.forEach((r, d) => { if (r[1].includes(ch)) out.set(d, { score: 1, hit: 1, mask: 1 }); });
    return out;
  }

  search(raw, opts = {}) {
    const q = parseQuery(raw);
    const explode = !(q.flags.noexp || opts.explode === false);
    const limit = opts.limit ?? CONFIG.limit;
    const score = new Map();
    const put = (d, s, why, extra = {}) => {
      const cur = score.get(d);
      if (!cur || s > cur.s) score.set(d, { s, why, ...extra, ...(cur?.def ? { def: true } : {}) });
      else if (extra.def) cur.def = true;
    };
    const details = { mapped: [], free: [], corrections: [], expansions: [], codes: q.codes, whole: false };

    for (const c of q.codes) {
      if (c.kind === 'cm' || c.kind === 'pcs') {
        const d = this.id.get(c.code);
        if (d !== undefined) put(d, 1000, { kind: 'code' });
        for (const x of this.descendants(c.code)) if (x !== d) put(x, 500 - this.codes[x].length, { kind: 'code-prefix' });
      } else if (c.kind === 'range') {
        for (let i = lower(this.sortedCodes, c.from); i < this.sortedCodes.length; i += 1) {
          const code = this.sortedCodes[i];
          if (code > c.to && !code.startsWith(c.to)) break;
          put(this.sortedIdx[i], 800, { kind: 'code-range' });
        }
      }
    }
    if (!q.text || q.flags.code) return this.finish(score, details, q.text, limit);

    // 0. 拼字修正在 ATM 之前
    const { text, corrections, expansions } = this.correctText(q.text);
    details.corrections = corrections;
    details.expansions = expansions;

    // 側別（v16）：ATM 用去掉側別字的查詢（「cellulitis of left leg」→「cellulitis of leg」才對得到入口詞），
    // BM25 仍用原句（側別字本身也是線索），最後由 lateralize() 依側別與部位調整。
    const side = sideOf(text);
    details.side = side ? { lat: side.lat, sites: side.sites.length } : null;

    // 2–3. ATM
    // ★ 原句本身就是入口詞（「Hernia, femoral, bilateral, with obstruction」→ K41.00）就用原句：
    //   先去掉 bilateral 會變成單側 K41.30 的入口詞，拿到 ATM 高分，連相反側 ×0.5 都壓不下來。
    const atmText = side && CONFIG.sideStrip && !this.lookup(text) ? side.strip : text;
    const { whole, segs } = this.segments(atmText);
    details.whole = whole;
    const sw = (s) => (s < 0 ? CONFIG.srcWeight.title : CONFIG.srcWeight[this.srcNames[s]] ?? 0.5);
    const segSets = [];
    const nodeSets = [];
    for (const seg of segs) {
      if (!seg.mapped) { details.free.push(seg.text); segSets.push(null); nodeSets.push(null); continue; }
      const set = new Map();
      // ★ 「直接命中的節點」要明確記，不能用權重推（v1–v8 用 w >= 1.0 判斷：
      //   官方名稱來源權重正好 1.0，explode 子孫也是 1.0 → 全被當成節點，
      //   ★ 標到每個子標題的預設子碼上，子孫也拿節點分數）
      const nodes = new Set();
      const concepts = [];
      for (const [code, src, flags] of seg.mapped) {
        const d = this.id.get(code);
        concepts.push({ code, src: src < 0 ? 'title' : this.srcNames[src], incomplete: Boolean(flags & 1) });
        const w = sw(src);
        if (d !== undefined) { set.set(d, Math.max(set.get(d) ?? 0, w * 2)); nodes.add(d); }
        if (explode) for (const x of this.descendants(code)) if (x !== d) set.set(x, Math.max(set.get(x) ?? 0, w));
      }
      nodeSets.push(nodes);
      details.mapped.push({ text: seg.text, concepts: dedupe(concepts), explodeCount: set.size });
      segSets.push(set);
    }

    // 4. 自由文字
    const onlyChar = [...text].length === 1 && CJK.test(text);
    const bm = onlyChar ? { acc: this.scanChar(text), n: 1, bit: new Map() } : this.bm25(text);
    const cov = (a) => a.hit / Math.max(1, bm.n);

    // 5. 合併
    if (whole) {
      for (const [d, w] of segSets[0]) {
        const node = nodeSets[0].has(d);
        const s = (node ? CONFIG.atmNode : CONFIG.atmExplode) * w + (bm.acc.get(d)?.score ?? 0);
        // ★ 只有可申報碼能標 ★預設碼；命中的是標題碼時，把它的預設子碼帶到緊接其後。
        //   ×0.96 < 標題碼的 ×0.97：v7 用同分讓子碼搶過標題碼，保留集 Hit@1 掉 6 點（正解常是標題碼本身）。
        const billable = this.rows[d][3] === 1;
        // ★ 預設碼＝CDC 字母索引（含 see 解析）直接給這個詞的完整碼；沒有這種來源時才退回「官方名稱完全相同」。
        //   v10 以前任何來源都算，Tabular 的 inclusion term 也會讓表現碼 N16 標 ★。
        const isDef = node && billable && seg0Def(segs[0], this.codes[d], this.cdcIdx);
        put(d, isDef ? s * CONFIG.cdcDefBonus : s, { kind: 'atm', seg: segs[0].text }, { atm: true, def: isDef });
        if (node && !billable) {
          const dc = this.id.get(this.defaults[this.codes[d]]);
          if (dc !== undefined) put(dc, s * 0.96, { kind: 'atm', seg: segs[0].text }, { atm: true, def: true });
        }
      }
    } else if (segs.length > 1) {
      const segMask = segs.map((s) => {
        let m = 0; let n = 0;
        for (const t of tokens(s.text)) { const x = bm.bit.get(t); if (x) { m |= x; n += 1; } }
        return { m, need: n ? Math.max(1, Math.ceil(CONFIG.segHit * n)) : 0 };
      });
      for (const [d, a] of bm.acc) {
        let ok = 0; let bonus = 0;
        segs.forEach((s, i) => {
          const set = segSets[i];
          if (set?.has(d)) { ok += 1; bonus += CONFIG.segBonus * set.get(d); return; }
          // ★ 單一個中文字的段（「右眼結膜炎」去掉側別後的「眼」、「肩旋轉肌腱撕裂」的「肩」）沒有字對可比，
          //   need 永遠是 0 → 沒有任何碼能通過 AND，連主題碼 H10.9 都進不來（v16 fresh4）。
          //   部位由側別規則處理，這種段視為已滿足；英文拼錯的詞維持不算（breat cancer 的教訓）。
          if (!s.mapped && [...s.text].length === 1 && CJK.test(s.text)) { ok += 1; return; }
          const { m, need } = segMask[i];
          // need = 0：這段的詞全庫都沒有（修正也修不回來）→ 不能拿來當「已滿足」
          if (need && popcount(a.mask & m) >= need) ok += 1;
        });
        if (ok === segs.length) put(d, a.score * cov(a) ** 2 + bonus, { kind: 'atm-seg' }, { atm: bonus > 0 });
      }
      if (segSets.every(Boolean)) {
        const [first, ...others] = segSets;
        for (const [d, w] of first) {
          if (others.every((s) => s.has(d))) {
            put(d, CONFIG.segBonus * others.reduce((acc, s) => acc + s.get(d), w) * 2, { kind: 'atm-and' }, { atm: true });
          }
        }
      }
    }
    for (const [d, a] of bm.acc) {
      const c = cov(a);
      if (c < CONFIG.minCoverage && bm.n > 1) continue;
      put(d, a.score * c * c, { kind: 'text' });
    }
    if (q.neg.length) {
      const negTok = q.neg.flatMap((w) => tokens(w));
      // 迭代中要刪除，所以先複製一份鍵
      for (const d of Array.from(score.keys())) if (negTok.some((t) => this.docTokens(d).has(t))) score.delete(d);
    }
    if (side) this.lateralize(score, side, bm, text, details.mapped);
    return this.finish(score, details, text, limit);
  }

  /**
   * 側別＋部位（v16）。兩步：
   *   1. 既有候選：側別相符加分、相反扣分、未明示側／沒有側別略降；部位對不上降；
   *      後續照護、後遺症、開放性骨折在查詢沒提時略降（醫師最常要的是初次照護、閉鎖性）
   *   2. 特化：前 sideTopK 名裡側別不符（或是標題碼）的候選 → 在它的類目（標題碼則是自己的子孫）
   *      找「側別＋部位都相符、初次照護、可申報」的碼，排在「原候選若側別相符」的位置。
   *      多個相符時看 BM25 分數，再偏好 unspecified／primary（醫師沒講細分型時的通用碼）。
   *   例：左小腿蜂窩性組織炎 → ATM 到 L03.90 → 類目 L03 裡左側＋下肢 → L03.116。
   */
  lateralize(score, side, bm, text, mapped = []) {
    const C = CONFIG;
    // 查詢的英文詞出現在「官方英文名稱」裡的數量：查 calf 就要挑名稱有 calf 的 L97.228，不是通用的 L97.928。
    // ★ 只算英文：中文 bigram 會被字序騙（「左側乳癌」的「側乳」剛好出現在「左側乳房中央位置」、
    //   「鎖骨骨折」的「骨骨」出現在「鎖骨骨幹」），v16 第三輪因此把 C50.112、S42.022A 排到通用碼前面。
    const qTok = new Set(tokens(text).filter((t) => !CJK.test(t)));
    const nameCov = (x) => {
      if (!qTok.size) return 0;
      const nt = new Set(tokens(this.rows[x][2]));
      let n = 0;
      for (const t of qTok) if (nt.has(t)) n += 1;
      return n;
    };
    const avoided = (d) => side.avoid.some((a) => a.en.test(this.rows[d][2]));
    // 問左／右時，ICD 只分「單側」的碼（K40.90 單側腹股溝疝氣）也算側別相符
    const latOk = (lat) => lat === side.lat || (lat === '單側' && side.lat !== '雙側');
    // ★ 共同前綴的「錨」＝查詢對到的主題碼（同類目有多個時取它們的共同前綴），不是產生候選的那個碼：
    //   BM25 撈到的 S72.04「股骨頸基部」、I82.4Y「近端下肢」不是查詢的主題，拿它當錨會挑到它的子碼；
    //   「肺癌」同時對到 C34.1／C34.2／C34.3 三個肺葉 → 錨是 C34.，不偏好任何一葉。
    const mappedCodes = mapped.flatMap((m) => m.concepts.map((c) => c.code));
    // 同類目的主題若有上下層關係（「耳鳴」同時對到 H93 與 H93.1），只留最下層再取共同前綴：
    // 錨取 H93 等於沒有錨，會被 unspecified 的 H93.91「右側耳疾患」搶走 H93.11。
    const anchorOf = (cat) => {
      const inCat = mappedCodes.filter((c) => c.startsWith(cat));
      const leaves = inCat.filter((c) => !inCat.some((o) => o !== c && o.startsWith(c)));
      return leaves.length ? leaves.reduce((a, c) => a.slice(0, commonPrefix(a, c))) : null;
    };
    // 主題的「內容詞」＝錨碼英文名稱去掉泛用字、部位字、側別字後剩下的詞
    // （conjunctivitis、cellulitis、adhesive capsulitis、subluxation／dislocation、hydronephrosis）。
    // 找到的碼至少要共用一個內容詞：從 H10.9「結膜炎」找右眼的碼，不能挑 H10.501 blepharoconjunctivitis；
    // 從 N13.30「腎水腫」不能挑 N13.721 單側逆流性腎病變（v16 fresh4）。
    // 只取「最罕見的一個詞」會壞：S43.0「Subluxation and dislocation」只留 subluxation，就把 S43.004A 脫臼擋掉。
    // 錨是前綴（C34.）時不用。
    const contentOf = (anchor) => {
      const a = anchor && this.id.get(anchor);
      if (a === undefined || a === null) return null;
      const s = new Set(tokens(this.rows[a][2]).filter((t) => t.length >= 4 && !KEY_STOP.has(t) && !SITE_STOP.has(t)));
      return s.size ? s : null;
    };
    // 候選 d 與它所在類目的主題是不是同一個病（類目裡沒有主題、或主題沒有內容詞 → 不判斷，當作是）
    const catContent = new Map();
    const sameDisease = (d) => {
      const cat = this.codes[d].slice(0, 3);
      if (!catContent.has(cat)) catContent.set(cat, contentOf(anchorOf(cat)));
      const content = catContent.get(cat);
      if (!content) return true;
      const tk = new Set(tokens(this.rows[d][2]));
      for (const t of content) if (tk.has(t)) return true;
      return false;
    };
    const fac = (d) => facetsOf({ en: this.rows[d][2], use: this.rows[d][3] });
    const site = (d) => siteOk(side, this.rows[d][1], this.rows[d][2]);
    const orig = new Map();
    for (const [d, v] of score) {
      if (String(v.why.kind).startsWith('code')) continue;     // 使用者直接打的碼不動
      orig.set(d, v.s);
      const f = fac(d);
      const ok = latOk(f.lat);
      // 「單側」在候選層不加分（只在找側別碼時算相符）：v16 fresh4「左側腎水腫」被 N13.721
      // 「單側性膀胱輸尿管逆流…」搶走 N13.30 —— 單側 ×1.3 讓不相干的碼升上來。
      // 側別相符也要是「同一個病」才加分：H10.501 眼瞼結膜炎沒有主題 H10.9 的內容詞 conjunctivitis → 不加分
      let m = f.lat === side.lat ? (sameDisease(d) ? C.sideMatch : C.sideOffTopic) : ok ? 1
        : f.lat && f.lat !== '未明示側' ? C.sideOther : f.lat ? C.sideUnspec
          : this.latPrefix5.has(this.codes[d].slice(0, 5)) ? C.sideNone : 1;
      // 查詢有部位、名稱卻是「unspecified site」（M19.90 未明示部位骨關節炎）→ 跟「別的部位」一樣重降：
      // 單字段（膝、髖）視為已滿足後，M19.90 會以主題分數搶過 M17.11／M16.11
      if (!site(d)) {
        m *= siteConflict(side, this.rows[d][1], this.rows[d][2]) || UNSPEC_SITE.test(this.rows[d][2]) ? C.siteConflict : C.siteMiss;
      }
      if (f.enc && f.enc !== '初次照護' && !side.later) m *= C.laterDemote;
      if (f.fx === '開放性' && !side.open) m *= C.openDemote;
      if (!side.fbody && FBODY.test(this.rows[d][2])) m *= C.openDemote;
      if (avoided(d)) m *= C.openDemote;
      if (ok && GENERIC_PART.test(this.rows[d][2])) m *= C.sideGenericMul;
      v.s *= m;
    }
    const top = [...orig.keys()].sort((a, b) => score.get(b).s - score.get(a).s).slice(0, C.sideTopK);
    const done = new Set();
    for (const d of top) {
      const f = fac(d);
      const header = this.rows[d][3] === 0;
      if (latOk(f.lat) && !header) continue;                    // 已經是側別相符的可申報碼
      // 找碼範圍：側別相符的標題碼 → 自己的子孫；標題碼、「unspecified」通用碼、或本身有側別但相反
      // （問雙側卻對到單側 K41.30，雙側版 K41.00 在另一個 5 字元群）→ 整個類目；
      // 本身完全不分側的具體疾病 → 只看同一個 5 字元群（G51.0 Bell 氏麻痺不能跨到 G51.32 半顏面痙攣）
      const code = this.codes[d];
      const wrongSide = Boolean(f.lat) && f.lat !== '未明示側' && !latOk(f.lat);
      const fam = header && latOk(f.lat) ? code
        : header || wrongSide || /\bunspecified\b/i.test(this.rows[d][2]) ? code.slice(0, 3) : code.slice(0, 5);
      if (done.has(fam)) continue;
      done.add(fam);
      const anchor = anchorOf(this.codes[d].slice(0, 3));
      const content = contentOf(anchor);
      const cands = [];
      for (const x of this.descendants(fam)) {
        if (this.rows[x][3] !== 1) continue;
        const fx = fac(x);
        if (!latOk(fx.lat) || !site(x)) continue;
        if (fx.enc && fx.enc !== '初次照護' && !side.later) continue;
        if (fx.fx === '開放性' && !side.open) continue;
        if (!side.fbody && FBODY.test(this.rows[x][2])) continue;
        const [zh, en] = [this.rows[x][1], this.rows[x][2]];
        let share = 0;
        if (content) {
          const tk = new Set(tokens(en));
          for (const t of content) if (tk.has(t)) share += 1;
          if (!share) continue;                                  // 不同的病（眼瞼結膜炎、逆流性腎病變）
        }
        const hint = side.hints.some((h) => h.zh.test(zh) || h.en.test(en)) ? 1 : 0;
        // 挑碼順序：非避開 → 與主題錨的共同前綴 → 細部提示 → 查詢英文詞在官方名稱裡的數量 → 通用碼 → BM25
        // ★ 共同前綴：從 M75.0（五十肩）要挑 M75.02，不是同類目的 M75.92「未明示肩病灶」。
        // ★ 通用碼排在 BM25 前：「左鎖骨骨折」BM25 偏好骨幹碼（舊譯名入口詞多），醫師沒講部位就該是 S42.002A。
        cands.push([
          x, avoided(x) ? 0 : 1, share,
          anchor ? commonPrefix(this.codes[x], anchor) : 0, hint, nameCov(x),
          GENERIC.test(en) ? 1 : 0, bm.acc.get(x)?.score ?? 0,
        ]);
      }
      if (!cands.length) continue;
      cands.sort((a, b) => {
        for (let k = 1; k < a.length; k += 1) if (b[k] !== a[k]) return b[k] - a[k];
        return this.codes[a[0]].localeCompare(this.codes[b[0]]);
      });
      const base = orig.get(d) * C.sideMatch * C.sideMember * (avoided(d) ? C.openDemote : 1);
      const atm = Boolean(score.get(d).atm);
      cands.slice(0, 3).forEach(([x], i) => {
        const s = base * (1 - 0.02 * i);
        const cur = score.get(x);
        if (!cur || s > cur.s) score.set(x, { s, why: { kind: 'text' }, atm, ...(cur?.def ? { def: true } : {}) });
      });
    }
  }

  finish(score, details, text, limit) {
    // 標題碼 ×0.97（同分時可申報碼優先）；「歸類於他處疾病」的表現碼 ×0.9 —— 依撰碼規則
    // 它們不能當主診斷（要先編原發疾病），v10 查 pyelonephritis 曾讓 N16 排第一。
    const neg = negationProbe(text);
    const preg = PREG.test(text ?? '');
    const adj = (d, v) => {
      if (v.why.kind === 'code') return v.s;
      let s = v.s;
      if (this.rows[d][3] === 0) s *= CONFIG.headerDemote;
      if (/classified elsewhere/i.test(this.rows[d][2])) s *= CONFIG.manifestDemote;
      if (neg && negated(this.rows[d], neg)) s *= CONFIG.negationDemote;
      if (!preg && this.codes[d][0] === 'O') s *= CONFIG.obstetricDemote;
      return s;
    };
    const items = [...score.entries()]
      .map(([d, v]) => [d, v, adj(d, v)])
      .sort((a, b) => b[2] - a[2] || this.codes[a[0]].localeCompare(this.codes[b[0]]))
      .slice(0, limit)
      .map(([d, v, s]) => ({
        code: this.codes[d], zh: this.rows[d][1], en: this.rows[d][2], use: this.rows[d][3],
        score: Math.round(s * 100) / 100, atm: Boolean(v.atm), def: Boolean(v.def),
        why: v.why.kind === 'text' || v.why.kind?.startsWith('atm') ? this.explain(d, text) : v.why,
      }));
    return { items, details, total: score.size };
  }

  explain(d, text) {
    const qt = new Set(tokens(text));
    if (!qt.size) return { kind: 'code' };
    const cands = [[this.rows[d][1], -1], [this.rows[d][2], -1], ...Array.from(this.entries[d], (i) => [this.vt[i][0], this.vt[i][2]])];
    let best = null; let bestN = -1;
    for (const [t, s] of cands) {
      const tt = new Set(tokens(t));
      let n = 0;
      for (const x of qt) if (tt.has(x)) n += 1;
      const sc = n - (s < 0 ? 0 : 0.1);
      if (sc > bestN) { bestN = sc; best = [t, s]; }
    }
    return { kind: 'match', text: best[0], src: best[1] < 0 ? 'title' : this.srcNames[best[1]] };
  }
}

/**
 * 否定判斷（v13）：新題實測「敗血性休克」第一名是 R65.20「未伴有敗血性休克的嚴重敗血症」——
 * 標題含查詢字串，意思卻相反。只在「查詢整段」緊跟在否定詞之後時才算，避免誤傷。
 */
const ZH_NEG = ['未伴有', '未併有', '未合併', '無', '未', '非'];
// 查詢有提到懷孕／產科才不降 O 碼（v16）
const PREG = /妊娠|懷孕|孕|產|胎|分娩|哺乳|pregnan|obstet|puerper|trimester|labou?r|deliver|gestation|partum|fetal|fetus|abortion|ectopic|placenta|eclampsia|lactation/i;
function negationProbe(text) {
  const t = norm(text);
  const zh = t.replace(/\s+/g, '');
  const en = parts(text).en;
  if (!zh && !en.length) return null;
  return { zh: CJK.test(zh) ? zh : null, en: en.length ? en : null };
}
function negated(row, probe) {
  if (probe.zh) {
    const z = norm(row[1]).replace(/\s+/g, '');
    const i = z.indexOf(probe.zh);
    if (i > 0 && ZH_NEG.some((w) => z.slice(Math.max(0, i - w.length), i) === w)) return true;
  }
  if (probe.en) {
    // 英文：查詢的所有詞都落在同一個 "without ..." 子句裡
    const m = row[2].toLowerCase().match(/\bwithout\b([^,;]*)/);
    if (m) {
      const clause = new Set(parts(m[1]).en);
      if (probe.en.every((w) => clause.has(w))) return true;
    }
  }
  return false;
}

const FBODY = /\bwith foreign body\b/i;
// 通用碼：醫師沒講細分型時的碼（unspecified part／primary）。「unspecified side／knee」這種未明示側
// 由 facets 判成「未明示側」，不會同時是側別相符，所以不會被這條誤加分。
// without：醫師沒提阻塞、壞疽、異物、併發症時就是 without（K40.90、S61.411A、E11.9）
const GENERIC = /\bunspecified\b|\bprimary\b|\bwithout\b/i;
// 候選層加分只給「部位未明示」：「unspecified stability／ligament」是另一個軸，
// v16 第二輪用寬版讓 S93.401 標題碼（unspecified ligament）搶過 S93.401A、M93.071 搶過 M93.021
const GENERIC_PART = /\bunspecified (part|site)s?\b/i;
const UNSPEC_SITE = /\bunspecified site\b/i;
const commonPrefix = (a, b) => { let i = 0; while (i < a.length && a[i] === b[i]) i += 1; return i; };
// 辨識詞不能是這些泛用字（比對用 stem 後的形式）
const KEY_STOP = new Set(['unspecified', 'other', 'specified', 'without', 'with', 'classified', 'elsewhere', 'encounter',
  'initial', 'subsequent', 'sequela', 'disease', 'disorder', 'condition', 'part', 'site', 'unilateral', 'bilateral']
  .flatMap((w) => [w, stem(w)]));
// 部位與側別字不算「內容詞」（找的就是換了側別／部位的碼）
const SITE_STOP = new Set(['right', 'left', 'side', 'shoulder', 'knee', 'hip', 'elbow', 'wrist', 'ankle', 'hand', 'foot',
  'eye', 'ear', 'breast', 'lung', 'limb', 'upper', 'lower', 'extremity', 'extremities', 'leg', 'arm', 'joint', 'region',
  'finger', 'thumb', 'toe', 'axilla'].flatMap((w) => [w, stem(w)]));

function dedupe(concepts) {
  const seen = new Set();
  return concepts.filter((c) => (seen.has(c.code) ? false : (seen.add(c.code), true)));
}

function seg0Def(seg, code, cdcIdx) {
  const direct = seg.mapped.filter(([, s, f]) => cdcIdx.has(s) && !(f & 1));
  if (direct.length) return direct.some(([c]) => c === code);
  return seg.mapped.some(([c, s, f]) => c === code && s < 0 && !(f & 1));   // 退回：官方名稱完全相同
}
