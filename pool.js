/* Quizzy — browser LLM pool (bring-your-own-key). Calls providers DIRECTLY from the page; keys never leave the device
 * except to the provider the user chose. Mirrors backend/app/services/llm.py (OpenAICompatProvider):
 *   - each endpoint is paced under its own requests/minute;   - the request goes to the endpoint that is ready soonest;
 *   - 429/5xx/network error => that endpoint cools down (Retry-After honoured) and the SAME request moves to another one;
 *   - if every endpoint is cooling the call WAITS (up to maxWait) instead of failing;   - 401/403 => key marked invalid.
 * Kinds: "anthropic" (Messages API, direct-browser header) and "openai" (any /chat/completions: Groq, OpenRouter, Gemini
 * compat, Ollama...). The provider must allow browser (CORS) calls — the Settings page has a Test button for that. */
(() => {
class PoolError extends Error { constructor(msg, code) { super(msg); this.code = code || 'llm_error'; } }

function extractJson(text) {
  let t = String(text || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  try { return JSON.parse(t); } catch { /* fall through */ }
  const starts = [t.indexOf('{'), t.indexOf('[')].filter((i) => i >= 0); if (!starts.length) throw new PoolError('no JSON in model output', 'bad_json');
  const s = Math.min(...starts); const open = t[s], close = open === '{' ? '}' : ']'; let depth = 0, inStr = false, esc = false;
  for (let i = s; i < t.length; i++) { const c = t[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true; else if (c === open) depth++; else if (c === close && --depth === 0) { try { return JSON.parse(t.slice(s, i + 1)); } catch { break; } } }
  throw new PoolError('malformed JSON in model output', 'bad_json');
}

class Endpoint {
  constructor(cfg) {
    this.id = cfg.id || cfg.name; this.name = cfg.name || cfg.base; this.kind = cfg.kind === 'anthropic' ? 'anthropic' : 'openai';
    this.base = String(cfg.base || '').replace(/\/+$/, ''); this.key = cfg.key || ''; this.model = cfg.model; this.rpm = Math.max(1, +cfg.rpm || 20);
    this.stamps = []; this.coolUntil = 0; this.fails = 0; this.dead = false; this.deadReason = '';
  }
  waitNeeded(now) {
    if (this.dead) return Infinity;
    this.stamps = this.stamps.filter((t) => now - t < 60000);
    let w = Math.max(0, this.coolUntil - now);
    if (this.stamps.length >= this.rpm) w = Math.max(w, 60000 - (now - this.stamps[0]) + 50);
    return w;
  }
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

  async _acquire(deadline, avoid) {
    for (;;) {
      const now = this.now(); const n = this.eps.length; const cands = [];
      for (let k = 0; k < n; k++) { const i = (this.rr + k) % n; cands.push([this.eps[i].waitNeeded(now), i]); }
      const ready = cands.filter(([w, i]) => w <= 0 && !avoid.has(i)); const any = ready.length ? ready : cands.filter(([w]) => w <= 0);
      if (any.length) { const i = any[0][1]; this.eps[i].stamps.push(now); this.rr = (i + 1) % n; return [this.eps[i], i]; }
      const wait = Math.min(...cands.map(([w]) => w));
      if (!Number.isFinite(wait)) throw new PoolError('كل مفاتيح التوليد غير صالحة: ' + this.eps.map((e) => `${e.name}: ${e.deadReason}`).join(' | '), 'keys_invalid');
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
  _body(e, task, system, prompt, maxTokens) {
    const sys = system + '\n\nReturn ONLY one valid JSON value. No prose, no markdown fences.'; const temperature = task === 'generate' ? 0.4 : 0;
    if (e.kind === 'anthropic') return { url: `${e.base}/v1/messages`, headers: { 'content-type': 'application/json', 'x-api-key': e.key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
      body: { model: e.model, max_tokens: maxTokens, temperature, system: [{ type: 'text', text: sys, cache_control: { type: 'ephemeral' } }], messages: [{ role: 'user', content: prompt }] } };
    return { url: `${e.base}/chat/completions`, headers: { 'content-type': 'application/json', ...(e.key ? { authorization: `Bearer ${e.key}` } : {}) },
      body: { model: e.model, max_tokens: maxTokens, temperature, messages: [{ role: 'system', content: sys }, { role: 'user', content: prompt }] } };
  }
  _text(e, data) { return e.kind === 'anthropic' ? (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('') : (((data.choices || [])[0] || {}).message || {}).content || ''; }

  async json(task, system, prompt, maxTokens = 6000) {
    if (!this.eps.length) throw new PoolError('لا يوجد مفتاح توليد: أضف مفتاحًا من صفحة الإعدادات.', 'llm_not_configured');
    const deadline = this.now() + this.maxWait; const avoid = new Set(); let last = null;
    for (let attempt = 0; attempt < Math.max(6, 3 * this.eps.length); attempt++) {
      const [e, idx] = await this._acquire(deadline, avoid); const req = this._body(e, task, system, prompt, maxTokens);
      let resp;
      try { resp = await this.fetch(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body) }); }
      catch (err) { last = new PoolError(`${e.name}: تعذّر الاتصال (${err.message || err}). قد يمنع المزوّد الطلبات من المتصفح (CORS).`, 'network'); this._cool(e, 0, null, ''); avoid.add(idx); continue; }
      if (resp.status === 401 || resp.status === 403) { e.dead = true; e.deadReason = `HTTP ${resp.status} (مفتاح غير صالح أو غير مصرّح)`; last = new PoolError(`${e.name}: ${e.deadReason}`, 'auth'); avoid.add(idx); continue; }
      if (resp.status === 429 || resp.status === 402 || resp.status >= 500) { let t = ''; try { t = await resp.text(); } catch { /* ignore */ } this._cool(e, resp.status, resp.headers && resp.headers.get && resp.headers.get('retry-after'), t); last = new PoolError(`${e.name}: HTTP ${resp.status}`, 'rate_limited'); avoid.add(idx); continue; }
      if (!resp.ok) { let t = ''; try { t = (await resp.text()).slice(0, 300); } catch { /* ignore */ } throw new PoolError(`${e.name}: HTTP ${resp.status} ${t}`, 'bad_request'); }
      try { const out = extractJson(this._text(e, await resp.json())); e.fails = 0; return out; }
      catch (err) { last = err; avoid.add(idx); }
    }
    throw last instanceof PoolError ? last : new PoolError(String(last && last.message || last));
  }

  /** One tiny request through ONE endpoint: used by the Settings "Test" button. */
  async test(cfg) {
    const p = new LLMPool([cfg], { maxWait: 15000, now: this.now, sleep: this.sleep, fetch: this.fetch }); const t0 = this.now();
    const r = await p.json('test', 'You are a connectivity probe.', 'Return the JSON {"ok": true}.', 50);
    return { ok: r && r.ok === true, ms: this.now() - t0 };
  }
}
window.QZ_POOL = { LLMPool, PoolError, extractJson };
if (typeof module !== 'undefined') module.exports = window.QZ_POOL;
})();
