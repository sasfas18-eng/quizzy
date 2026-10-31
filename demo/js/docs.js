// Shared helpers for reading uploaded lectures: upload + progress, and the plain-language quality notes.
import { h, api, num } from './core.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** what the reader is doing right now, in words (the browser editions report text/ocr progress; the server just says "reading") */
export function progressText(d) {
  const p = d && d.progress;
  if (!p || !p.total) return 'نقرأ الملف…';
  if (p.phase === 'ocr') return `نقرأ الصور والصفحات الممسوحة (القراءة الضوئية)… ${num(p.done)}/${num(p.total)}`;
  if (p.phase === 'text') return `نقرأ الصفحات والجداول… ${num(Math.min(p.done + 1, p.total))}/${num(p.total)}`;
  return 'نقرأ الملف…';
}
export function progressPct(d) {
  const p = d && d.progress; if (!p || !p.total) return 8;
  return Math.max(8, Math.min(97, Math.round(p.phase === 'ocr' ? 55 + (40 * p.done) / p.total : (55 * p.done) / p.total)));
}

/** POST the file, then follow its status until it is no longer "processing"; `onStatus(doc)` is called on every poll */
export async function uploadAndRead(file, onStatus) {
  const fd = new FormData(); fd.append('file', file);
  let d = await api('POST', '/api/documents', fd);
  for (let i = 0; i < 1800 && d.status === 'processing'; i++) { if (onStatus) onStatus(d); await sleep(600); d = await api('GET', `/api/documents/${d.id}`); }
  return d;
}

/** quality notes in plain language (what could not be read, what was read by OCR) — shown next to a file, never as an error wall */
export function qualityNote(q) {
  const parts = []; const list = (a) => a.map(num).join('، ');
  const bad = [...(q.image_only || []), ...(q.empty || []), ...(q.garbled || [])];
  if (bad.length) parts.push(h('div', { class: 'alert bad' }, h('strong', {}, `${num(bad.length)} صفحة لم نتمكن من قراءتها (حتى بالقراءة الضوئية): `), list(bad), '. لن نخمّن محتواها ولن تُستخدم في الأسئلة.'));
  if ((q.low_text || []).length) parts.push(h('div', { class: 'alert warn' }, `صفحات بنص قليل جدًا: ${list(q.low_text)} (غالبًا عناوين أو فواصل).`));
  if ((q.ocr_pages || []).length) parts.push(h('div', { class: 'alert info' }, h('strong', {}, `قرأنا نص الصور بالقراءة الضوئية في ${num(q.ocr_pages.length)} صفحة: `), list(q.ocr_pages), '. قد تحوي أخطاء بسيطة، فتُعلَّم الأسئلة المبنية عليها ويمكنك مراجعة الصفحة الأصلية.'));
  if ((q.figures_unread || []).length) parts.push(h('div', { class: 'alert info' }, `صفحات فيها صور أو أشكال لم يظهر فيها نص: ${list(q.figures_unread)}.`));
  return parts;
}
