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
    const out = norm(text).split(' ').map((w) => {
      if (!w || CJK.test(w)) return w;
      const fix = this.correct(stem(w), w);
      if (fix) { corrections.push([w, fix]); return fix; }
      return w;
    });
    return { text: out.join(' '), corrections };
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
    const details = { mapped: [], free: [], corrections: [], codes: q.codes, whole: false };

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
    const { text, corrections } = this.correctText(q.text);
    details.corrections = corrections;

    // 2–3. ATM
    const { whole, segs } = this.segments(text);
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
        put(d, s, { kind: 'atm', seg: segs[0].text }, { atm: true, def: node && billable && seg0Def(segs[0], this.codes[d]) });
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
    return this.finish(score, details, text, limit);
  }

  finish(score, details, text, limit) {
    const adj = (d, v) => (this.rows[d][3] === 0 && v.why.kind !== 'code' ? v.s * CONFIG.headerDemote : v.s);
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

function dedupe(concepts) {
  const seen = new Set();
  return concepts.filter((c) => (seen.has(c.code) ? false : (seen.add(c.code), true)));
}

function seg0Def(seg, code) {
  return seg.mapped.some(([c, , f]) => c === code && !(f & 1));
}
