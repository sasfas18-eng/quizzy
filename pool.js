/* Quizzy — browser LLM pool (bring-your-own-key). Calls providers DIRECTLY from the page; keys never leave the device
 * except to the provider the user chose. Mirrors backend/app/services/llm.py (OpenAICompatProvider):
 *   - each endpoint is paced under its own requests/minute;
 *   - THE AUTOMATIC PATH IS PRESET: endpoints are tried in a fixed order of preference (rankOf: the site's own Claude relay, then Claude keys on this
 *     device, Gemini, Groq, OpenRouter, a model on the operator's machine); equal ranks share the load round-robin; and the local generator is the last link;
 *   - THEY BACK EACH OTHER UP: whatever goes wrong with one endpoint (429/5xx/network, out of credit or over a spend limit, a bad/expired key, a wrong
 *     model, a refused request) the SAME request moves on to the next one at once; an endpoint that is out of credit is skipped for a while and then
 *     tried again by itself (so the preferred one takes over again as soon as it works), a bad key stays out until fixed;
 *   - if every usable endpoint is merely cooling the call WAITS (up to maxWait) instead of failing; if none is usable it fails at once (never waits for nothing).
 * Kinds: "anthropic" (Messages API: direct-browser header, or `relay: true` = our own relay that holds the key — no key/headers from the page), "gemini" (Google's NATIVE generateContent API — the one made for
 * browsers; the OpenAI-compat layer of Gemini is server-oriented) and "openai" (any /chat/completions: Groq, OpenRouter,
 * Ollama...). The provider must allow browser (CORS) calls — the connect card / Settings page test that. */
(() => {
class PoolError extends Error { constructor(msg, code) { super(msg); this.code = code || 'llm_error'; } }

function extractJson(text) {
  let t = String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');      // reasoning models (DeepSeek-R1 on Ollama...) write <think>…</think> first: it may contain braces
  try { return JSON.parse(t); } catch { /* fall through */ }
  const starts = [t.indexOf('{'), t.indexOf('[')].filter((i) => i >= 0); if (!starts.length) throw new PoolError('no JSON in model output', 'bad_json');
  const s = Math.min(...starts); const open = t[s], close = open === '{' ? '}' : ']'; let depth = 0, inStr = false, esc = false;
  for (let i = s; i < t.length; i++) { const c = t[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true; else if (c === open) depth++; else if (c === close && --depth === 0) { try { return JSON.parse(t.slice(s, i + 1)); } catch { break; } } }
  throw new PoolError('malformed JSON in model output', 'bad_json');
}

// Claude 5 family (opus/sonnet/haiku/fable-5*): thinking is on by default and `effort` is the control; temperature/top_p/top_k are REJECTED (HTTP 400).
// So no Anthropic request here ever sends sampling parameters. Checking tasks need little thinking; writing/analysis use medium.
const isClaude5 = (m) => /^claude-(opus|sonnet|haiku|fable|mythos)-5/.test(String(m || ''));
const EFFORT = { verify: 'low', verify_explanation: 'low', cards: 'low', test: 'low' };

/** Preset order of the automatic path (lower = tried first). Not a setting: nobody has to choose. */
function rankOf(cfg) {
  if (cfg.relay) return 0;                                                   // the site's own Claude (paid, strongest) behind the relay
  let host = ''; try { host = new URL(cfg.base).hostname; } catch { /* ignore */ }
  if (cfg.kind === 'anthropic' || /anthropic\.com$/.test(host)) return 10;     // Claude keys on this device
  if (cfg.kind === 'gemini' || /generativelanguage\.googleapis\.com$/.test(host)) return 20;
  if (/groq\.com$/.test(host)) return 30;
  if (/openrouter\.ai$/.test(host)) return 40;
  if (/^(localhost|127\.0\.0\.1)$/.test(host)) return 60;                    // a model on the operator's own machine: unlimited, usually the weakest
  return 50;
}
/** What a provider can take in ONE request, and per minute. Free plans are small: Groq's free tier allows only ~6-12k tokens PER MINUTE for a whole request (prompt + max_tokens), and answers 413
 *  "Request too large" above that — the quiz prompts (pages + rules + accepted questions) are bigger, so they must be sized per provider. `scale` (0-1) shrinks the pages/batches the
 *  engine builds for this endpoint, `tpm` paces requests by estimated tokens, `maxOut` caps max_tokens. Unknown providers start at full size and LEARN from a too-large reply. */
function profileOf(cfg) {
  let host = ''; try { host = new URL(cfg.base).hostname; } catch { /* ignore */ }
  if (/groq\.com$/.test(host)) return { scale: 0.35, tpm: 6000, maxOut: 2500 };
  return { scale: 1, tpm: 0, maxOut: Infinity };
}
const TOO_LARGE_RE = /request too large|reduce your message|maximum context length|context[_ ]length|too many tokens|payload too large|request entity too large|Limit \d+, Requested \d+/i;
const parseLimit = (t) => { const m = /Limit (\d+), Requested (\d+)/i.exec(String(t || '')); return m ? { limit: +m[1], requested: +m[2] } : null; };
const OUT_MS = 10 * 60 * 1000;   // out of credit / over a spend limit: skipped this long, then tried again by itself
const CREDIT_RE = /credit balance|purchase credits|plans? & billing|usage limits?|usage threshold|spend(ing)? limit|enforced_spend_limit|insufficient[ _](credits?|funds|quota)/i;
const KEYFIX_RE = /not scoped to a workspace|anthropic-workspace-id|api key not valid|invalid api key|incorrect api key|invalid x-api-key/i;
const reasonOf = (status, t) => status === 402 || CREDIT_RE.test(t) ? 'نفد الرصيد أو بلغ سقف الإنفاق' : /not scoped to a workspace|anthropic-workspace-id/i.test(t) ? 'المفتاح غير مقيّد بمساحة عمل (Workspace)'
  : status === 404 ? 'النموذج غير متاح لهذا المفتاح' : KEYFIX_RE.test(t) ? 'المفتاح غير صالح' : `HTTP ${status}`;

// Anthropic's `GET /v1/models` answers WITHOUT any Access-Control-Allow-Origin header (measured: even its 401 carries none), so a browser can never read it — every
// "discover the models" call from a page fails with a CORS error whatever the key. `POST /v1/messages` does carry the headers. So the Claude models are a known list here,
// and the key is checked by one tiny real message (LLMPool.test).
const ANTHROPIC_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];

class Endpoint {
  constructor(cfg) {
    this.id = cfg.id || cfg.name; this.name = cfg.name || cfg.base; this.kind = cfg.kind === 'anthropic' ? 'anthropic' : cfg.kind === 'gemini' ? 'gemini' : 'openai';
    this.base = String(cfg.base || '').replace(/\/+$/, ''); this.key = cfg.key || ''; this.relay = !!cfg.relay; this.model = cfg.model; this.rpm = Math.max(1, +cfg.rpm || 20);
    this.rank = typeof cfg.rank === 'number' ? cfg.rank : rankOf(cfg);
    this.stamps = []; this.coolUntil = 0; this.fails = 0; this.dead = false; this.deadReason = ''; this.outUntil = 0; this.outReason = ''; this.used = 0;
    const pr = { ...profileOf(cfg), ...(cfg.limits || {}) }; this.scale = pr.scale; this.tpm = pr.tpm; this.maxOut = pr.maxOut; this.tokStamps = [];   // [time, estimated tokens] of recent requests
  }
  waitNeeded(now, est = 0) {
    if (this.dead) return Infinity;
    if (this.outUntil > now) return Infinity;                      // out of credit / spend limit: skipped (not waited for) until it is tried again
    this.stamps = this.stamps.filter((t) => now - t < 60000);
    let w = Math.max(0, this.coolUntil - now);
    if (this.stamps.length >= this.rpm) w = Math.max(w, 60000 - (now - this.stamps[0]) + 50);
    if (this.tpm && est && est <= this.tpm) {          // paced by tokens too: wait until enough of the last minute's requests have left the window (a request that can never fit is sent and answered 413 -> learned)
      this.tokStamps = this.tokStamps.filter(([t]) => now - t < 60000); let used = this.tokStamps.reduce((a, [, n]) => a + n, 0);
      if (used + est > this.tpm) for (const [t, n] of this.tokStamps) { used -= n; w = Math.max(w, 60000 - (now - t) + 50); if (used + est <= this.tpm) break; }
    }
    return w;
  }
  state(now) { return this.dead ? 'dead' : this.outUntil > now ? 'out' : this.waitNeeded(now) > 0 ? 'cooling' : 'ready'; }
}

class LLMPool {
  constructor(endpoints, opts = {}) {
    this.eps = endpoints.map((e) => new Endpoint(e)); this.rr = 0;
    this.maxWait = opts.maxWait ?? 900000;
    this.now = opts.now || (() => Date.now()); this.sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.fetch = opts.fetch || ((...a) => window.fetch(...a));
    this.onWait = opts.onWait || (() => {});
  }
  get size() { return this.eps.length; }

  async _acquire(deadline, avoid, skip = new Set(), est = 0) {
    for (;;) {
      const now = this.now(); const n = this.eps.length; const cands = [];
      for (let k = 0; k < n; k++) { const i = (this.rr + k) % n; if (!skip.has(i)) cands.push([this.eps[i].waitNeeded(now, est), i]); }
      if (!cands.some(([w]) => Number.isFinite(w))) {
        const why = this.eps.map((e) => `${e.name}: ${e.dead ? e.deadReason : e.outUntil > now ? e.outReason : 'رُفض الطلب'}`).join(' | ');
        throw new PoolError((this.eps.some((e) => !e.dead && e.outUntil > now) ? 'تعذّر التوليد بالذكاء الاصطناعي الآن: ' : 'كل مفاتيح التوليد غير صالحة: ') + why, 'keys_invalid');
      }
      // the preset order: the best-ranked READY endpoint (ties keep round-robin order); a busy/cooling better one never blocks a ready worse one
      const best = (list) => list.reduce((b, c) => (this.eps[c[1]].rank < this.eps[b[1]].rank ? c : b));
      const ready = cands.filter(([w, i]) => w <= 0 && !avoid.has(i)); const any = ready.length ? ready : cands.filter(([w]) => w <= 0);
      if (any.length) { const [, i] = best(any); this.eps[i].stamps.push(now); if (est) this.eps[i].tokStamps.push([now, est]); this.rr = (i + 1) % n; return [this.eps[i], i]; }
      const wait = Math.min(...cands.map(([w]) => w));
      if (now + wait > deadline) throw new PoolError('كل مزوّدي التوليد استنفدوا حدّهم الآن؛ أعد المحاولة لاحقًا أو أضف مفتاحًا/مزوّدًا آخر.', 'rate_limited');
      this.onWait(wait); await this.sleep(Math.min(wait, 30000) + 10);
    }
  }
  _cool(e, status, retryAfter, bodyText) {
    // Browsers hide Retry-After unless the provider exposes it via CORS, so without it fall back to a short exponential back-off.
    let secs = Math.min(60, 8 * 2 ** e.fails);
    if (retryAfter && !Number.isNaN(+retryAfter)) secs = +retryAfter; else if (/per day|daily|quota/i.test(bodyText || '')) secs = 3600;
    e.fails++; e.coolUntil = this.now() + Math.min(secs, 3600) * 1000;
  }
  _out(e, reason) { e.outUntil = this.now() + OUT_MS; e.outReason = reason; }
  /** 0-1: how much of a full-size request the endpoint that will most likely serve the NEXT call can take (the engine sizes its batches/pages by it) */
  scale() { const now = this.now(); const live = this.eps.filter((e) => !e.dead && e.outUntil <= now); if (!live.length) return 1;
    const ready = live.filter((e) => e.waitNeeded(now) <= 0); const pool = ready.length ? ready : live; return pool.reduce((b, e) => (e.rank < b.rank ? e : b)).scale; }
  /** bring an endpoint back at once (the operator fixed the key / added credit and the check succeeded) */
  revive(id) { for (const e of this.eps) if (e.id === id) { e.dead = false; e.deadReason = ''; e.outUntil = 0; e.outReason = ''; e.coolUntil = 0; e.fails = 0; } }
  /** the automatic path as it stands now, best first: what the operator page shows */
  status() {
    const now = this.now();
    return this.eps.map((e, order) => ({ id: e.id, name: e.name, kind: e.kind, model: e.model, relay: e.relay, rank: e.rank, order, state: e.state(now), used: e.used,
      reason: e.dead ? e.deadReason : e.outUntil > now ? e.outReason : '', retry_in: e.outUntil > now ? Math.ceil((e.outUntil - now) / 1000) : Math.max(0, Math.ceil(e.waitNeeded(now) / 1000)) || 0 }))
      .sort((a, b) => a.rank - b.rank || a.order - b.order);
  }
  _final(errs) {
    const last = errs[errs.length - 1]; if (!last) return new PoolError('تعذّر التوليد.', 'llm_error');
    const msgs = [...new Set(errs.map((x) => x.message))].slice(-4); return msgs.length > 1 ? new PoolError(msgs.join(' | '), last.code) : last;
  }
  _body(e, task, system, prompt, maxTokens) {
    const sys = system + '\n\nReturn ONLY one valid JSON value. No prose, no markdown fences.'; const temperature = task === 'generate' ? 0.4 : 0;
    if (e.kind === 'anthropic') { const c5 = isClaude5(e.model);
      // relay: the page sends NO key and no provider headers; the relay adds them server-side
      const headers = e.relay ? { 'content-type': 'application/json' } : { 'content-type': 'application/json', 'x-api-key': e.key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' };
      return { url: `${e.base}/v1/messages`, headers, body: { model: e.model, max_tokens: c5 ? Math.max(maxTokens, 16000) : maxTokens, system: [{ type: 'text', text: sys, cache_control: { type: 'ephemeral' } }], messages: [{ role: 'user', content: prompt }],
        ...(c5 ? { output_config: { effort: EFFORT[task] || 'medium' } } : {}) } }; }
    if (e.kind === 'gemini') return { url: `${e.base}/v1beta/models/${encodeURIComponent(e.model)}:generateContent`, headers: { 'content-type': 'application/json', 'x-goog-api-key': e.key },
      // JSON mime type = the model must answer with JSON; the output budget leaves room for the "thinking" tokens of 2.5-class models
      body: { systemInstruction: { parts: [{ text: sys }] }, contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature, maxOutputTokens: Math.max(maxTokens, 8192), responseMimeType: 'application/json' } } };
    return { url: `${e.base}/chat/completions`, headers: { 'content-type': 'application/json', ...(e.key ? { authorization: `Bearer ${e.key}` } : {}) },
      body: { model: e.model, max_tokens: maxTokens, temperature, messages: [{ role: 'system', content: sys }, { role: 'user', content: prompt }] } };
  }
  _text(e, data) { if (e.kind === 'gemini') return ((((data.candidates || [])[0] || {}).content || {}).parts || []).map((x) => x.text || '').join(''); return e.kind === 'anthropic' ? (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('') : (((data.choices || [])[0] || {}).message || {}).content || ''; }

  async json(task, system, prompt, maxTokens = 6000, o = {}) {
    if (!this.eps.length) throw new PoolError('لا يوجد مفتاح توليد: أضف مفتاحًا من صفحة الإعدادات.', 'llm_not_configured');
    const deadline = this.now() + this.maxWait; const avoid = new Set(); const skip = new Set(); const errs = []; const inTok = Math.ceil((String(system).length + String(prompt).length) / 3);   // ~3 characters per token (Arabic is denser than English)
    for (let attempt = 0; attempt < Math.max(6, 3 * this.eps.length); attempt++) {
      if (o.once && errs.length) throw this._final(errs);      // a connection test: one honest try per endpoint, the answer at once (no cool-down waiting)
      let e, idx;
      try { [e, idx] = await this._acquire(deadline, avoid, skip, inTok + maxTokens); } catch (err) {
        if (errs.length && err.code === 'keys_invalid') throw this._final(errs);
        if (errs.length && err.code === 'rate_limited') throw new PoolError(err.message + ' — ' + [...new Set(errs.map((x) => x.message))].slice(-4).join(' | '), 'rate_limited');   // say what each one answered
        throw err;
      }
      const maxTok = Math.max(64, Math.min(maxTokens, e.maxOut)); const req = this._body(e, task, system, prompt, maxTok);
      let resp;
      try { resp = await this.fetch(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body) }); }
      catch (err) { errs.push(new PoolError(`${e.name}: تعذّر الاتصال (${err.message || err}). قد يمنع المزوّد الطلبات من المتصفح (CORS).`, 'network')); this._cool(e, 0, null, ''); avoid.add(idx); continue; }
      if (resp.status === 401 || resp.status === 403) { e.dead = true; e.deadReason = `HTTP ${resp.status} (مفتاح غير صالح أو غير مصرّح)`; errs.push(new PoolError(`${e.name}: ${e.deadReason}`, 'auth')); avoid.add(idx); continue; }
      if (resp.ok) {
        try { const out = extractJson(this._text(e, await resp.json())); e.fails = 0; e.used++; return out; }
        catch (err) { errs.push(err); avoid.add(idx); continue; }
      }
      let t = ''; try { t = (await resp.text()).slice(0, 400); } catch { /* ignore */ }
      avoid.add(idx);
      if (resp.status === 429 || resp.status === 402 || resp.status >= 500) {
        if (resp.status === 402 || CREDIT_RE.test(t)) { this._out(e, reasonOf(resp.status, t)); errs.push(new PoolError(`${e.name}: HTTP ${resp.status} ${t.slice(0, 240)}`, 'rate_limited')); }
        else { this._cool(e, resp.status, resp.headers && resp.headers.get && resp.headers.get('retry-after'), t); errs.push(new PoolError(`${e.name}: HTTP ${resp.status}`, 'rate_limited')); }
        continue;
      }
      if (resp.status === 413 || TOO_LARGE_RE.test(t)) {           // too big for THIS provider (e.g. Groq free: "Limit 8000, Requested 33128"): learn its size, let another provider try, and tell the engine to send smaller pieces
        const lim = parseLimit(t); e.scale = Math.max(0.1, e.scale * 0.5);
        if (lim) { e.tpm = lim.limit; const room = lim.limit - Math.max(0, lim.requested - maxTok) - 150; if (room >= 600) e.maxOut = Math.min(e.maxOut, room); }
        errs.push(new PoolError(`${e.name}: HTTP ${resp.status} ${t.slice(0, 300)}`, 'too_large')); skip.add(idx); continue;
      }
      // any other refusal (400, 404, 413, 422...): this endpoint cannot serve THIS request. Say why, and let the next endpoint try.
      errs.push(new PoolError(`${e.name}: HTTP ${resp.status} ${t.slice(0, 300)}`, 'bad_request'));
      if (CREDIT_RE.test(t)) this._out(e, reasonOf(resp.status, t));                               // account-level: out for a while, tried again by itself
      else if (resp.status === 404 || KEYFIX_RE.test(t)) { e.dead = true; e.deadReason = reasonOf(resp.status, t); }   // the key/model must be fixed by the operator
      else skip.add(idx);                                                                          // the request itself was refused: not retried here
    }
    throw this._final(errs);
  }

  /** The model ids a key can use (GET {base}/models). Lets the UI pick a sensible model so nobody has to type model names. */
  static async listModels(cfg, fetchFn) {
    if (cfg.kind === 'anthropic') return ANTHROPIC_MODELS.slice();           // see ANTHROPIC_MODELS: not readable from a browser
    const f = fetchFn || ((...a) => window.fetch(...a)); const base = String(cfg.base || '').replace(/\/+$/, ''); const anth = cfg.kind === 'anthropic', gem = cfg.kind === 'gemini';
    const url = anth ? `${base}/v1/models?limit=100` : gem ? `${base}/v1beta/models?pageSize=200` : `${base}/models`;
    const headers = anth ? { 'x-api-key': cfg.key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' } : gem ? { 'x-goog-api-key': cfg.key } : (cfg.key ? { authorization: `Bearer ${cfg.key}` } : {});
    let r; try { r = await f(url, { headers }); } catch (err) { throw new PoolError('تعذّر الاتصال بالمزوّد. تحقق من الإنترنت، وقد يمنع المزوّد الطلبات القادمة من المتصفح (CORS).', 'network'); }
    if (r.status === 401 || r.status === 403 || r.status === 400) throw new PoolError('المفتاح غير صالح أو غير مصرّح له.', 'auth');
    if (!r.ok) throw new PoolError(`ردّ المزوّد بالخطأ HTTP ${r.status}.`, 'bad_request');
    let d; try { d = await r.json(); } catch { throw new PoolError('ردّ المزوّد ليس JSON صالحًا.', 'bad_json'); }
    let arr = Array.isArray(d) ? d : (d.data || d.models || []);
    if (gem) arr = arr.filter((m) => !m || !Array.isArray(m.supportedGenerationMethods) || m.supportedGenerationMethods.includes('generateContent'));   // chat-capable models only
    return arr.map((m) => (typeof m === 'string' ? m : m && (m.id || m.name))).filter(Boolean).map(String);
  }

  /** One tiny request through ONE endpoint: used by the Settings "Test" button. It answers at once (no retries, no waiting), and when the connection itself fails it says WHY. */
  async test(cfg) {
    const p = new LLMPool([cfg], { maxWait: 15000, now: this.now, sleep: this.sleep, fetch: this.fetch }); const t0 = this.now();
    try { const r = await p.json('test', 'You are a connectivity probe.', 'Return the JSON {"ok": true}.', 50, { once: true }); return { ok: r && r.ok === true, ms: this.now() - t0 }; }
    catch (err) { if (err && err.code === 'network') throw new PoolError(LLMPool.networkMessage(cfg, await LLMPool.diagnose(cfg, this.fetch)), 'network'); throw err; }
  }
  /** A browser reports "blocked by CORS" and "cannot reach the host" the same way (a rejected fetch). Tell them apart: a no-cors request to the host's root resolves (opaque) when the host is reachable. */
  static async diagnose(cfg, fetchFn, nav) {
    const n = nav === undefined ? (typeof navigator !== 'undefined' ? navigator : null) : nav; if (n && n.onLine === false) return 'offline';
    const f = fetchFn || ((...a) => window.fetch(...a)); let origin; try { origin = new URL(cfg.base).origin; } catch { return 'unreachable'; }
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null; const t = setTimeout(() => ctl && ctl.abort(), 4000);
    try { await f(origin + '/', { mode: 'no-cors', cache: 'no-store', signal: ctl ? ctl.signal : undefined }); return 'cors'; } catch { return 'unreachable'; } finally { clearTimeout(t); }
  }
  static networkMessage(cfg, diag) {
    let host = cfg.base; try { host = new URL(cfg.base).host; } catch { /* keep */ } const local = /^(localhost|127\.0\.0\.1)(:|$)/.test(host);
    if (diag === 'offline') return 'لا يوجد اتصال بالإنترنت على هذا الجهاز. تأكد من الشبكة ثم أعد المحاولة.';
    if (diag === 'cors') return local ? `${host} يعمل لكنه يرفض هذا الموقع (CORS). شغّل Ollama بالمتغير OLLAMA_ORIGINS=* ثم أعد تشغيله.` : `${host} يعمل لكنه لا يسمح لهذا الموقع بقراءة ردّه (CORS). الأرجح أن المفتاح غير صحيح أو انتهى حدّه المجاني (بعض المزوّدين يردّون على الأخطاء بلا ترويسات CORS فيحجبها المتصفح): راجع المفتاح من لوحة المزوّد وأعد المحاولة. وإن تكرر فهذا المزوّد لا يصلح من المتصفح؛ استعمل Claude أو Gemini أو الوسيط.`;
    return local ? `لا شيء يعمل على ${host}: شغّل Ollama (أو الخادم المحلي) ثم أعد المحاولة.` : `لا يصل متصفحك إلى ${host}. غالبًا حاجب إعلانات أو إضافة خصوصية تمنع هذا العنوان، أو VPN أو شبكة عمل/مدرسة تحجبه، أو انقطاع مؤقت. جرّب متصفحًا آخر أو شبكة أخرى.`;
  }
}
/** Choose a sensible default chat model out of what the key can use (stable ids, newest, free-tier friendly). */
function pickModel(kind, base, ids) {
  const all = [...new Set((ids || []).map((x) => String(x).replace(/^models\//, '')))].filter(Boolean);
  const NOT_CHAT = /(embed|tts|whisper|audio|image|imagen|veo|guard|moderation|rerank|transcri|speech|-live|aqa|robotics|computer-use|dall|distil-whisper|orpheus)/i;
  const chat = all.filter((x) => !NOT_CHAT.test(x));
  const ver = (x) => { const m = String(x).match(/(\d+(?:\.\d+)?)/); return m ? +m[1] : 0; };
  const best = (arr, re) => arr.filter((x) => re.test(x)).sort((a, b) => ver(b) - ver(a) || a.length - b.length)[0];
  let host = ''; try { host = new URL(base).hostname; } catch { /* ignore */ }
  if (kind === 'gemini' || /generativelanguage\.googleapis\.com$/.test(host)) {
    const stable = chat.filter((x) => /^gemini-[\d.]+-flash(-lite)?$/.test(x));        // no -preview / -exp / dated snapshots
    return best(stable, /-flash$/) || best(stable, /-flash-lite$/) || best(chat, /^gemini-[\d.]+-(flash|pro)/) || chat[0] || null;
  }
  if (/groq\.com$/.test(host)) { const pri = ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'llama-3.1-8b-instant', 'qwen/qwen3-32b']; return pri.find((m) => chat.includes(m)) || chat[0] || null; }
  if (/openrouter\.ai$/.test(host)) {
    const free = chat.filter((x) => /:free$/.test(x)); const pri = [/llama-3\.3-70b/, /gpt-oss-120b/, /deepseek.*(chat|v3)/, /qwen3?-.*(32|72|235)b/, /gemma-3-27b/, /mistral.*small/];
    for (const re of pri) { const hit = free.find((x) => re.test(x)); if (hit) return hit; } return free[0] || null;
  }
  if (kind === 'anthropic' || /anthropic\.com$/.test(host)) {
    const parsed = chat.map((id) => [id, /^claude-(opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(?:-(\d{8}))?$/.exec(id)]).filter(([, m]) => m).map(([id, m]) => ({ id, fam: m[1], major: +m[2], minor: m[3] ? +m[3] : 0, dated: m[4] ? 1 : 0 }));
    const top = (fam) => parsed.filter((x) => x.fam === fam).sort((a, b) => (b.major - a.major) || (b.minor - a.minor) || (a.dated - b.dated))[0];
    const hit = top('opus') || top('sonnet') || top('haiku'); if (hit) return hit.id;
    return best(chat, /opus/) || best(chat, /sonnet/) || best(chat, /haiku/) || chat[0] || null;
  }
  return chat[0] || null;
}
window.QZ_POOL = { LLMPool, PoolError, extractJson, pickModel, isClaude5, rankOf, ANTHROPIC_MODELS };
if (typeof module !== 'undefined') module.exports = window.QZ_POOL;
})();
