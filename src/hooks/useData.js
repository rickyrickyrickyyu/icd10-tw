import { useCallback, useEffect, useRef, useState } from 'react';
import { Engine } from '../lib/search/engine.js';

const BASE = `${import.meta.env.BASE_URL}data`;

/**
 * 離線版把資料內嵌在 window.__ICD_OFFLINE__（file:// 下 fetch 讀不到本機檔）。
 * 在這裡分流，其他地方一律呼叫 getJson，不必知道自己在哪個版本。
 */
const EMBEDDED = typeof window !== 'undefined' ? window.__ICD_OFFLINE__ : null;

/**
 * 離線包的資料是 gzip+base64 字串（全庫 JSON 56 MB，原樣內嵌會讓單檔 HTML 破 50 MB）。
 * 用瀏覽器內建 DecompressionStream 解開：Chrome/Edge 80+、Safari 16.4+、Firefox 113+。
 */
async function gunzipB64(b64) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('此瀏覽器太舊，無法開啟離線版（請用新版 Chrome 或 Edge）');
  }
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) buf[i] = bin.charCodeAt(i);
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(stream).text());
}

/**
 * ★ 資料網址帶版本（?v=<data_fingerprint>）：
 *   v12 以前資料用 NetworkFirst（3 秒逾時），vocab_cm.json 在慢網路超過 3 秒就回舊快取 ——
 *   實測線上「新程式＋舊詞彙」，BCC nose 的縮寫展開整個失效。帶版本後每一版網址不同，
 *   SW 可以放心 CacheFirst（快又不可能拿到舊版）；只有 meta.json 走網路優先決定版本。
 */
let VERSION = null;
async function version() {
  if (VERSION) return VERSION;
  const r = await fetch(`${BASE}/meta.json`, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`meta.json: HTTP ${r.status}`);
  const m = await r.json();
  VERSION = m.data_fingerprint ?? m.built ?? 'x';
  return VERSION;
}

export async function getJson(path) {
  if (EMBEDDED) {
    const v = EMBEDDED[path];
    if (v === undefined) throw new Error(`${path}: 離線版未內嵌此資料`);
    return typeof v === 'string' ? gunzipB64(v) : v;
  }
  if (path === 'meta.json') {
    const r = await fetch(`${BASE}/meta.json`, { cache: 'no-cache' });
    if (!r.ok) throw new Error(`meta.json: HTTP ${r.status}`);
    const m = await r.json();
    VERSION = m.data_fingerprint ?? m.built ?? 'x';
    return m;
  }
  const r = await fetch(`${BASE}/${path}?v=${await version()}`);
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}

export const isOffline = () => Boolean(EMBEDDED);
export const offlineMeta = () => (typeof window !== 'undefined' ? window.__ICD_OFFLINE_META__ : null) ?? null;

const cache = new Map();
/** 同一檔只抓一次（分片、節點資訊、對應檔）。失敗不快取，下次可重試。 */
export function load(path) {
  if (!cache.has(path)) {
    cache.set(path, getJson(path).catch((e) => { cache.delete(path); throw e; }));
  }
  return cache.get(path);
}

export const shardKey = (code) => (/^[0-9A-Z]/i.test(code) ? code[0].toUpperCase() : '_');
export const loadNodes = (code) => load(`nodes/${shardKey(code)}.json`).catch(() => ({}));
export const loadMap14 = (kind, code) => load(`map14/${kind}/${shardKey(code)}.json`).catch(() => ({}));
export const loadMap9 = (kind, code) => load(`map9/${kind}/${shardKey(code)}.json`).catch(() => ({}));

/**
 * 代碼詳細頁資料：同首字母的列與入口詞（detail/<字母>.json）。
 * ★ 離線包不內嵌這些分片（資料已全在 cm.json／vocab_cm.json 裡，重複內嵌只會讓檔案變大），
 *   離線時改從全庫切出同一個形狀。
 */
export async function loadDetail(code) {
  const k = shardKey(code);
  if (EMBEDDED && EMBEDDED[`detail/${k}.json`] === undefined) {
    const [rows, v] = await Promise.all([load('cm.json'), load('vocab_cm.json')]);
    return { rows: rows.rows.filter((r) => shardKey(r[0]) === k), src: v.src, t: v.t.filter((t) => shardKey(t[1]) === k) };
  }
  return load(`detail/${k}.json`);
}

export async function loadPcsDetail(code) {
  const k = shardKey(code);
  if (EMBEDDED && EMBEDDED[`pdetail/${k}.json`] === undefined) {
    const rows = await load('pcs.json');
    return { rows: rows.rows.filter((r) => shardKey(r[0]) === k) };
  }
  return load(`pdetail/${k}.json`);
}

/** 一批代碼 → Map(code → 列)；只載用得到的首字母分片。 */
export async function namesFor(codes, pcs = false) {
  const keys = [...new Set(codes.map(shardKey))];
  const shards = await Promise.all(keys.map((k) => (pcs ? loadPcsDetail(k) : loadDetail(k)).catch(() => ({ rows: [] }))));
  const out = new Map();
  for (const s of shards) for (const r of s.rows) out.set(r[0], r);
  return out;
}

/**
 * 首載：meta + 皮膚科子集（約 180 KB gz）並立刻建索引；
 * 全庫（CM 約 2.7 MB gz）與 PCS 等使用者切換範圍才載。
 */
export function useCore() {
  const [s, setS] = useState({ loading: true, error: null, meta: null, scope: 'derm', eng: null, building: false });
  const engines = useRef({});
  const rowsByCode = useRef(new Map());

  useEffect(() => {
    let alive = true;
    Promise.all([getJson('meta.json'), getJson('derm.json')])
      .then(([meta, derm]) => {
        if (!alive) return;
        engines.current.derm = new Engine(derm.rows, derm.vocab);
        for (const r of derm.rows) rowsByCode.current.set(r[0], r);
        setS((x) => ({ ...x, loading: false, meta, eng: engines.current.derm }));
      })
      .catch((e) => alive && setS((x) => ({ ...x, loading: false, error: e.message })));
    return () => { alive = false; };
  }, []);

  const setScope = useCallback(async (scope) => {
    if (engines.current[scope]) { setS((x) => ({ ...x, scope, eng: engines.current[scope] })); return; }
    setS((x) => ({ ...x, building: true }));
    try {
      const [rowsFile, vocabFile] = scope === 'pcs' ? ['pcs.json', 'vocab_pcs.json'] : ['cm.json', 'vocab_cm.json'];
      const [rows, vocab] = await Promise.all([load(rowsFile), load(vocabFile)]);
      // 讓 spinner 先畫出來再做 1–2 秒的索引建置
      await new Promise((r) => setTimeout(r, 30));
      engines.current[scope] = new Engine(rows.rows, vocab, { kind: scope === 'pcs' ? 'pcs' : 'cm' });
      if (scope !== 'pcs') for (const r of rows.rows) rowsByCode.current.set(r[0], r);
      setS((x) => ({ ...x, scope, eng: engines.current[scope], building: false }));
    } catch (e) {
      setS((x) => ({ ...x, building: false, error: e.message }));
    }
  }, []);

  /** 查任意 CM 碼的列（詳細頁用）；不在已載範圍就補載全庫。 */
  const getRow = useCallback(async (code) => {
    if (rowsByCode.current.has(code)) return rowsByCode.current.get(code);
    const rows = await load('cm.json');
    for (const r of rows.rows) rowsByCode.current.set(r[0], r);
    return rowsByCode.current.get(code) ?? null;
  }, []);

  return { ...s, setScope, getRow, engines: engines.current };
}
