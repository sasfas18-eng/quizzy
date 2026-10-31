/* Quizzy — lecture reader (browser). Reads a WHOLE lecture, not just its text layer:
 *   · text in reading order (RTL aware), with TABLES rebuilt from the page geometry (PDF) or the table markup (PPTX) as "a | b | c" rows;
 *   · PPTX speaker notes, chart data (series/categories/values) and SmartArt text, in true slide order;
 *   · the TEXT INSIDE IMAGES and image-only pages (scans, screenshots, diagrams with labels) by OCR with a vendored Tesseract.js
 *     (ara + eng, runs in a worker inside the page: nothing is uploaded anywhere, works offline).
 * Pages that were read by OCR are flagged (`ocr:true`) so the questions built on them can say so.
 * The pure helpers (detectTables, composePage, mergeOcr…) are exported for node tests; the DOM parts need a browser. */
(() => {
const AR_RE = /[\u0600-\u06ff\u0750-\u077f\ufb50-\ufdff\ufe70-\ufeff]/;   // includes the shaped presentation forms PDFs store
const arRatio = (s) => { const L = [...String(s)].filter((c) => /\p{L}/u.test(c)); return L.length ? L.filter((c) => AR_RE.test(c)).length / L.length : 0; };
// PDFs often store Arabic as shaped presentation forms (U+FB50–FEFF): fold them back to base letters so terms/regexes/quotes match
const unshape = (s) => (/[ﭐ-﷿ﹰ-﻿]/.test(s) ? s.normalize('NFKC') : s.normalize('NFC'));
const cleanLines = (s) => s.replace(/\u0000/g, '').split('\n').map((l) => l.replace(/[ \t ​]+/g, ' ').trim()).reduce((o, l) => { if (l || (o.length && o[o.length - 1])) o.push(l); return o; }, []).join('\n').trim();
const clean = (s) => cleanLines(unshape(String(s || '')));
const norm = (s) => String(s || '').normalize('NFKC').toLowerCase().replace(/[ً-ٰٟـ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// ------------------------------------------------------------------ tables from positioned text (PDF)
const median = (a) => { const s = a.filter((x) => x > 0).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
/** items: [{i (stream index), str, x, y, w, h}] -> tables found by geometry: runs of >=3 rows whose short cells line up in >=2 columns */
function detectTables(items) {
  const its = items.filter((t) => t.str && t.str.trim());
  if (its.length < 6) return [];
  const fs = median(its.map((t) => t.h)) || 10;
  const sorted = its.slice().sort((a, b) => b.y - a.y || a.x - b.x);
  const rows = []; let cur = null;
  for (const t of sorted) { if (cur && Math.abs(t.y - cur.y) <= Math.max(2, 0.45 * fs)) cur.items.push(t); else { cur = { y: t.y, items: [t] }; rows.push(cur); } }
  for (const r of rows) {
    r.items.sort((a, b) => a.x - b.x); r.cells = [];
    for (const t of r.items) { const last = r.cells[r.cells.length - 1]; const gap = last ? t.x - last.x1 : 0;
      if (last && gap < 0.9 * fs) { last.items.push(t); last.x1 = Math.max(last.x1, t.x + t.w); } else r.cells.push({ x0: t.x, x1: t.x + t.w, items: [t] }); }
    // a cell's words keep the stream (logical) order, which is right for Arabic and Latin alike
    r.cells.forEach((c) => { c.text = c.items.slice().sort((a, b) => a.i - b.i).map((t) => t.str).join(' ').replace(/\s+/g, ' ').trim(); });
    r.cand = r.cells.length >= 2 && r.cells.every((c) => c.text.length <= 80);
  }
  const tables = []; let run = [];
  const flush = () => { if (run.length >= 3) { const tb = asTable(run, fs); if (tb) tables.push(tb); } run = []; };
  rows.forEach((r) => { if (r.cand && (!run.length || run[run.length - 1].y - r.y <= 4 * fs)) run.push(r); else { flush(); if (r.cand) run.push(r); } });
  flush();
  return tables;
}
function asTable(run, fs) {
  const tol = 1.2 * fs;
  run.forEach((r) => r.cells.forEach((c) => { c.xc = (c.x0 + c.x1) / 2; }));
  // columns line up on their left edge, right edge (right-aligned / Arabic) or centre: use whichever alignment explains the page best
  const attempt = (key) => {
    const xs = run.flatMap((r) => r.cells.map((c) => c[key])).sort((a, b) => a - b); const anchors = [];
    for (const x of xs) { const a = anchors[anchors.length - 1]; if (a && x - a.max <= tol) { a.xs.push(x); a.max = x; } else anchors.push({ xs: [x], max: x }); }
    anchors.forEach((a) => (a.x = a.xs.reduce((s, v) => s + v, 0) / a.xs.length));
    const need = Math.max(2, Math.ceil(0.6 * run.length)); const keep = anchors.filter((a) => run.filter((r) => r.cells.some((c) => Math.abs(c[key] - a.x) <= tol)).length >= need);
    if (keep.length < 2) return null;
    const filled = run.filter((r) => r.cells.filter((c) => keep.some((a) => Math.abs(c[key] - a.x) <= tol)).length >= 2).length;
    return filled >= need ? { key, keep, score: keep.length * filled } : null;
  };
  const best = ['x0', 'x1', 'xc'].map(attempt).filter(Boolean).sort((a, b) => b.score - a.score)[0]; if (!best) return null;
  const { key, keep } = best, lines = [], idx = new Set();
  for (const r of run) {
    const cols = keep.map(() => []);
    for (const c of r.cells) { let bi = 0, bd = Infinity; keep.forEach((a, i) => { const d = Math.abs(c[key] - a.x); if (d < bd) { bd = d; bi = i; } }); cols[bi].push(c.text); c.items.forEach((t) => idx.add(t.i)); }
    let texts = cols.map((a) => a.join(' ').trim());
    if (arRatio(texts.join(' ')) > 0.5) texts = texts.reverse();            // Arabic tables read right to left: first column = rightmost
    const full = texts.filter(Boolean); lines.push(full.length >= 2 ? texts.join(' | ') : full.join(' '));
  }
  return { idx, lines };
}
/** page text in stream order (what the old extractor produced) with every detected table replaced, in place, by its "a | b | c" rows */
function composePage(items) {
  const tables = detectTables(items), owner = new Map(); tables.forEach((tb, k) => tb.idx.forEach((i) => owner.set(i, k)));
  let text = '', lastY = null; const done = new Set();
  for (const it of items) {
    const k = owner.get(it.i);
    if (k != null) { if (!done.has(k)) { done.add(k); if (text && !text.endsWith('\n')) text += '\n'; text += tables[k].lines.join('\n') + '\n'; lastY = null; } continue; }
    if (lastY !== null && Math.abs(it.y - lastY) > 3 && !text.endsWith('\n')) text += '\n';
    text += it.str + (it.eol ? '\n' : ''); lastY = it.y;
  }
  return { text, tables: tables.length };
}

// ------------------------------------------------------------------ OCR text hygiene (pure)
const usefulLine = (l) => { const t = l.trim(); if (t.length < 3) return false; const letters = [...t].filter((c) => /[\p{L}\p{N}]/u.test(c)).length; return letters / t.length >= 0.55 && /\p{L}{2,}|\d{2,}/u.test(t); };
/** OCR lines that the text layer does not already contain (normalised), junk and low-confidence lines removed */
function mergeOcr(textLayer, ocrLines) {
  const have = norm(textLayer); const out = [];
  for (const l of ocrLines) { const t = String(l.text || '').replace(/\s+/g, ' ').trim(); if (!usefulLine(t)) continue; if (l.conf != null && l.conf < 55) continue; const n = norm(t); if (n.length >= 3 && have.includes(n)) continue; out.push(t); }
  return out;
}

// ------------------------------------------------------------------ OCR engine (browser)
const simd = () => { try { return WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11])); } catch { return false; } };
const OCR = {
  sched: null, langs: '', loading: null, workers: 0,
  available() { return typeof WebAssembly === 'object' && typeof Worker !== 'undefined' && simd(); },
  async _script(src) { if (window.Tesseract) return; await new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('تعذّر تحميل محرك القراءة الضوئية')); document.head.append(s); }); },
  async start(langs) {
    if (this.sched && this.langs === langs) return; await this.stop();
    const base = new URL('vendor/tesseract/', document.baseURI).href; await this._script(base + 'tesseract.min.js'); const T = window.Tesseract;
    const n = Math.max(1, Math.min(2, Math.floor(((navigator.hardwareConcurrency || 2)) / 2))); const sched = T.createScheduler();
    for (let k = 0; k < n; k++) sched.addWorker(await T.createWorker(langs.split('+'), 1, { workerPath: base + 'worker.min.js', corePath: base + 'tesseract-core-simd-lstm.wasm.js', langPath: base + 'lang', gzip: true, cacheMethod: 'none' }));
    this.sched = sched; this.langs = langs; this.workers = n;
  },
  /** canvas -> { lines:[{text,conf}], conf } */
  async read(canvas) {
    const { data } = await this.sched.addJob('recognize', canvas, {}, { blocks: true, text: true });
    let lines = []; const walk = (b) => { if (!b) return; if (Array.isArray(b)) return b.forEach(walk); if (b.lines) b.lines.forEach((l) => lines.push({ text: l.text, conf: l.confidence })); if (b.paragraphs) b.paragraphs.forEach(walk); };
    if (data.lines && data.lines.length) lines = data.lines.map((l) => ({ text: l.text, conf: l.confidence })); else walk(data.blocks);
    if (!lines.length && data.text) lines = String(data.text).split('\n').map((t) => ({ text: t, conf: data.confidence }));
    return { lines, conf: data.confidence };
  },
  async stop() { if (this.sched) { try { await this.sched.terminate(); } catch { /* ignore */ } } this.sched = null; this.langs = ''; },
};
const pickLangs = (sample) => (sample.length > 200 ? (arRatio(sample) > 0.25 ? 'ara+eng' : 'eng') : 'ara+eng');   // no text layer to judge by: read both scripts (Arabic first)

// ------------------------------------------------------------------ PDF
const IMG_OPS = (lib) => new Set([lib.OPS.paintImageXObject, lib.OPS.paintInlineImageXObject, lib.OPS.paintJpegXObject, lib.OPS.paintImageMaskXObject].filter((x) => x != null));
async function renderCanvas(pg, targetW = 1800) {
  const v0 = pg.getViewport({ scale: 1 }), scale = Math.min(3, Math.max(1, targetW / v0.width)), vp = pg.getViewport({ scale });
  const c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height); const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  await pg.render({ canvasContext: ctx, viewport: vp }).promise; return c;
}
async function extractPdf(buf, opts = {}) {
  const lib = window.pdfjsLib, onP = opts.onProgress || (() => {}); lib.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.min.js', document.baseURI).href;
  const pdf = await lib.getDocument({ data: new Uint8Array(buf) }).promise; if (pdf.numPages > 400) throw new Error('عدد الصفحات يتجاوز 400.');
  const pages = [], handles = [], imgOps = IMG_OPS(lib);
  for (let i = 1; i <= pdf.numPages; i++) {
    onP({ phase: 'text', done: i - 1, total: pdf.numPages });
    const pg = await pdf.getPage(i); const tc = await pg.getTextContent();
    const items = tc.items.filter((it) => typeof it.str === 'string').map((it, k) => ({ i: k, str: it.str, x: it.transform ? it.transform[4] : 0, y: it.transform ? it.transform[5] : 0, w: it.width || 0, h: it.transform ? Math.abs(it.transform[3]) || it.height || 0 : it.height || 0, eol: !!it.hasEOL }));
    const { text, tables } = composePage(items);
    let images = 0; try { const ops = await pg.getOperatorList(); images = ops.fnArray.filter((f) => imgOps.has(f)).length; } catch { /* ignore */ }
    pages.push({ page_no: i, text: clean(text), image_count: images, tables }); handles.push(pg);
  }
  // pictures matter when the page has little text around them, or no usable text layer at all
  const garbled = (t) => { const n = t.length; if (!n) return false; return [...t].filter((c) => c === '�' || (c >= '\u0000' && c < ' ' && c !== '\n' && c !== '\t')).length / n > 0.15; };
  pages.forEach((p) => { p.garbled_text = garbled(p.text); });
  const cand = pages.filter((p) => opts.ocr !== false && (p.garbled_text || (!p.text && p.image_count) || (p.image_count && p.text.length < 1200))).map((p) => p.page_no).slice(0, opts.maxOcrPages || 80);
  if (cand.length) await runOcr(cand.map((no) => ({ no, get: () => renderCanvas(handles[no - 1]) })), pages, onP, (p) => p.text);
  onP({ phase: 'done', done: pdf.numPages, total: pdf.numPages });
  return pages;
}
/** OCR the given image sources (each {no, get():Promise<canvas>}) and fold the new lines into pages[no-1] (pages are 1-based by page_no) */
async function runOcr(jobs, pages, onP, textOf) {
  if (!OCR.available()) { jobs.forEach((j) => { const p = pages[j.no - 1]; if (p) p.ocr_error = 'unavailable'; }); return; }
  const sample = pages.map(textOf).join('\n').slice(0, 4000); onP({ phase: 'ocr', done: 0, total: jobs.length });
  try { await OCR.start(pickLangs(sample)); } catch (e) { jobs.forEach((j) => { const p = pages[j.no - 1]; if (p) p.ocr_error = String(e.message || e); }); return; }
  let done = 0;
  const queue = jobs.slice(); const worker = async () => {
    for (let j = queue.shift(); j; j = queue.shift()) {
      const p = pages[j.no - 1];
      try { p.ocr_tried = true; const canvas = await j.get(); const r = await OCR.read(canvas); const fresh = mergeOcr(p.garbled_text ? '' : p.text, r.lines); canvas.width = canvas.height = 0;
        if (fresh.length) { p.text = clean((p.garbled_text ? '' : p.text + '\n') + fresh.join('\n')); p.garbled_text = false; p.ocr = true; p.ocr_lines = (p.ocr_lines || 0) + fresh.length; p.ocr_conf = Math.round(r.conf || 0); }
      } catch (e) { p.ocr_error = String(e.message || e); }
      onP({ phase: 'ocr', done: ++done, total: jobs.length });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, OCR.workers) }, worker));
  await OCR.stop();
}

// ------------------------------------------------------------------ PPTX
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const xmlDoc = (s) => new DOMParser().parseFromString(s, 'application/xml');
const byLocal = (root, name) => [...root.getElementsByTagName('*')].filter((e) => e.localName === name);
const kid = (el, name) => [...el.children].find((e) => e.localName === name);
const kids = (el, name) => [...el.children].filter((e) => e.localName === name);
const attr = (el, name) => el.getAttributeNS(R_NS, name) || el.getAttribute('r:' + name);
function paraText(p) { let out = ''; for (const n of p.children) { const ln = n.localName; if (ln === 'r' || ln === 'fld') out += (kid(n, 't') || {}).textContent || ''; else if (ln === 'br') out += '\n'; } return out; }
const paras = (txBody) => (txBody ? kids(txBody, 'p').map((p) => paraText(p).trim()).filter(Boolean) : []);
function resolvePath(base, target) { if (target.startsWith('/')) return target.slice(1); const parts = base.split('/').slice(0, -1); for (const seg of target.split('/')) { if (seg === '..') parts.pop(); else if (seg !== '.') parts.push(seg); } return parts.join('/'); }
async function relsOf(zip, part) { const f = zip.file(part.replace(/([^/]+)$/, '_rels/$1.rels')); const m = {}; if (!f) return m; for (const r of byLocal(xmlDoc(await f.async('string')), 'Relationship')) m[r.getAttribute('Id')] = { type: r.getAttribute('Type') || '', target: resolvePath(part, r.getAttribute('Target') || '') }; return m; }
function tableLines(tbl) {
  return kids(tbl, 'tr').map((tr) => { const cells = kids(tr, 'tc').filter((tc) => tc.getAttribute('hMerge') !== '1' && tc.getAttribute('vMerge') !== '1').map((tc) => paras(kid(tc, 'txBody')).join(' ').replace(/\s+/g, ' ').trim()); const full = cells.filter(Boolean); return full.length >= 2 ? cells.join(' | ') : full.join(' '); }).filter(Boolean);
}
function chartLines(xml) {
  const out = []; const title = byLocal(xml, 'title')[0]; const tt = title ? byLocal(title, 't').map((e) => e.textContent).join('').trim() : ''; if (tt) out.push('Chart: ' + tt);
  for (const ser of byLocal(xml, 'ser')) { const val = (n) => { const el = byLocal(ser, n)[0]; return el ? byLocal(el, 'pt').map((p) => (byLocal(p, 'v')[0] || {}).textContent || '') : []; };
    const tx = byLocal(ser, 'tx')[0], name = tx ? ((byLocal(tx, 'v')[0] || {}).textContent || '').trim() : '', cats = val('cat'), vals = val('val');
    if (vals.length) out.push((name ? name + ': ' : '') + vals.map((v, i) => (cats[i] ? cats[i] + '=' : '') + v).join('; ')); }
  return out;
}
function diagramLines(xml) { return byLocal(xml, 'pt').filter((p) => !p.getAttribute('type') || p.getAttribute('type') === 'node').map((p) => { const t = kid(p, 't'); return t ? kids(t, 'p').map((x) => paraText(x).trim()).filter(Boolean).join(' ') : ''; }).filter(Boolean); }
async function slideContent(zip, slidePath) {
  const xml = xmlDoc(await zip.file(slidePath).async('string')), rels = await relsOf(zip, slidePath), lines = [], pics = []; let tables = 0, charts = 0;
  const walk = async (node) => {
    for (const el of node.children) { const n = el.localName;
      if (n === 'sp') { const ph = byLocal(el, 'ph')[0], pt = ph && ph.getAttribute('type'); if (['sldNum', 'dt', 'ftr'].includes(pt)) continue; lines.push(...paras(kid(el, 'txBody'))); }
      else if (n === 'graphicFrame') {
        const tbl = byLocal(el, 'tbl')[0]; if (tbl) { tables++; lines.push(...tableLines(tbl)); continue; }
        const ch = byLocal(el, 'chart')[0]; if (ch) { const rel = rels[attr(ch, 'id')]; if (rel && zip.file(rel.target)) { charts++; lines.push(...chartLines(xmlDoc(await zip.file(rel.target).async('string')))); } continue; }
        const dg = byLocal(el, 'relIds')[0]; if (dg) { const rel = rels[attr(dg, 'dm')]; if (rel && zip.file(rel.target)) lines.push(...diagramLines(xmlDoc(await zip.file(rel.target).async('string')))); } }
      else if (n === 'grpSp') await walk(el);
      else if (n === 'pic') { const blip = byLocal(el, 'blip')[0], rel = blip && rels[attr(blip, 'embed')]; if (rel) pics.push(rel.target); } } };
  const tree = byLocal(xml, 'spTree')[0]; if (tree) await walk(tree);
  let notes = ''; const nrel = Object.values(rels).find((r) => /\/notesSlide$/.test(r.type));
  if (nrel && zip.file(nrel.target)) { const nx = xmlDoc(await zip.file(nrel.target).async('string')), ps = []; byLocal(nx, 'sp').forEach((sp) => { const ph = byLocal(sp, 'ph')[0]; if (ph && ph.getAttribute('type') === 'body') ps.push(...paras(kid(sp, 'txBody'))); }); notes = ps.join('\n'); }
  return { lines, pics, notes, tables, charts };
}
/** slide files in PRESENTATION order (the numbering PowerPoint shows), falling back to file-name order */
async function slideOrder(zip) {
  const all = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => +a.match(/\d+/)[0] - +b.match(/\d+/)[0]);
  try { const pres = zip.file('ppt/presentation.xml'); if (!pres) return all; const rels = await relsOf(zip, 'ppt/presentation.xml'); const ids = byLocal(xmlDoc(await pres.async('string')), 'sldId').map((e) => rels[attr(e, 'id')]).filter(Boolean).map((r) => r.target).filter((t) => zip.file(t));
    return ids.length >= all.length * 0.5 ? ids : all; } catch { return all; }
}
async function pictureCanvas(zip, path) {
  const f = zip.file(path); if (!f || !/\.(png|jpe?g|gif|bmp|webp)$/i.test(path)) return null; const blob = new Blob([await f.async('uint8array')]);
  let bmp; try { bmp = await createImageBitmap(blob); } catch { return null; } if (bmp.width < 200 || bmp.height < 90) { bmp.close(); return null; }
  const s = Math.min(1, 2200 / Math.max(bmp.width, bmp.height)), c = document.createElement('canvas'); c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s); const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(bmp, 0, 0, c.width, c.height); bmp.close(); return c;
}
async function extractPptx(buf, opts = {}) {
  const onP = opts.onProgress || (() => {}), zip = await window.JSZip.loadAsync(buf), names = await slideOrder(zip);
  if (names.length > 400) throw new Error('عدد الشرائح يتجاوز 400.'); const pages = [], picsOf = [];
  for (let i = 0; i < names.length; i++) {
    onP({ phase: 'text', done: i, total: names.length });
    const c = await slideContent(zip, names[i]); const body = c.lines.join('\n'); const notes = c.notes ? '\n\nملاحظات المحاضر (Notes):\n' + c.notes : '';
    pages.push({ page_no: i + 1, text: clean(body + notes), image_count: c.pics.length, tables: c.tables, charts: c.charts, notes: !!c.notes }); picsOf.push(c.pics);
  }
  // pictures with text in them (screenshots, scanned figures): only on slides that are picture-led, the largest few per slide
  if (opts.ocr !== false) {
    const jobs = []; pages.forEach((p, k) => { if (picsOf[k].length && p.text.length < 800) [...new Set(picsOf[k])].slice(0, 3).forEach((path) => jobs.push({ no: p.page_no, path })); });
    const real = jobs.slice(0, opts.maxOcrPictures || 60).map((j) => ({ no: j.no, get: () => pictureCanvas(zip, j.path).then((c) => c || Promise.reject(new Error('skip'))) }));
    if (real.length) await runOcr(real, pages, onP, (p) => p.text);
    pages.forEach((p) => { if (p.ocr_error === 'skip') delete p.ocr_error; });
  }
  onP({ phase: 'done', done: names.length, total: names.length });
  return pages;
}

const api = { extractPdf, extractPptx, OCR, detectTables, composePage, mergeOcr, usefulLine, pickLangs, arRatio, clean, unshape };
if (typeof window !== 'undefined') window.QZ_READER = api;
if (typeof module !== 'undefined') module.exports = api;
})();
