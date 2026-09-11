import { loadNodes } from '../hooks/useData.js';
import { mergeNotes } from './codingNotes.js';

/** 一個碼（含祖先）的撰碼規則。祖先與本碼同首字母 → 只載一個 nodes 分片（有快取）。 */
export async function notesFor(code) {
  return mergeNotes(code, await loadNodes(code));
}
