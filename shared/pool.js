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

/** Reasoning models (DeepSeek-R1, Qwen3, gpt-oss... on Groq/Ollama/OpenRouter) write their thinking first, sometimes inside the text: <think>…</think> (it may contain braces, so it must go). A block that
 *  never closes means the model was cut while thinking — there is no answer in it; a lone closing tag means the template opened the block in the prompt. */
function stripReasoning(text) {
  return String(text || '').replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, '').replace(/^[\s\S]*<\/(?:think|thinking|reasoning)>/i, '').replace(/<(?:think|thinking|reasoning)>[\s\S]*$/i, '');
}
/** Models' small slips that JSON.parse refuses: a comma before } or ], a raw line break / tab inside a string. */
function repairJson(s) {
  let out = '', inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) { const c = s[i];
    if (inStr) { if (esc) { esc = false; out += c; } else if (c === '\\') { esc = true; out += c; } else if (c === '"') { inStr = false; out += c; } else if (c === '\n') out += '\\n'; else if (c === '\r') out += '\\r'; else if (c === '\t') out += '\\t'; else out += c; continue; }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === ',') { let j = i + 1; while (j < s.length && /\s/.test(s[j])) j++; if (s[j] === '}' || s[j] === ']') continue; }
    out += c; }
  return out;
}
const nextStart = (t, from) => { const a = t.indexOf('{', from), b = t.indexOf('[', from); return a < 0 ? b : b < 0 ? a : Math.min(a, b); };
function balancedEnd(t, s) {          // index of the bracket that closes the one at `s`, or -1 when the text ends first (strings are skipped)
  const open = t[s], close = open === '{' ? '}' : ']'; let depth = 0, inStr = false, esc = false;
  for (let i = s; i < t.length; i++) { const c = t[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true; else if (c === open) depth++; else if (c === close && --depth === 0) return i; }
  return -1;
}
function extractJson(text) {
  const t = stripReasoning(text).trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  const parse = (x) => { try { return [JSON.parse(x)]; } catch { /* repair below */ } try { return [JSON.parse(repairJson(x))]; } catch { return null; } };
  let seen = false, truncated = false;
  for (let s = nextStart(t, 0), guard = 0; s >= 0 && guard++ < 60;) {
    seen = true; const end = balancedEnd(t, s);
    if (end < 0) { truncated = true; break; }                 // cut in the middle: whatever follows is part of it, not a second answer
    const v = parse(t.slice(s, end + 1)); if (v) return v[0];
    s = nextStart(t, end + 1);                                // that span was prose ("[page 3]", "{x}"): look after it
  }
  const err = new PoolError(truncated ? 'truncated JSON in model output' : seen ? 'malformed JSON in model output' : 'no JSON in model output', 'bad_json'); err.truncated = truncated; throw err;
}
/** A reply cut by the output limit: keep what is COMPLETE. Safe cut points are only (a) after a finished element of the list directly under the answer (the questions / results / objectives array)
 *  and (b) after a finished top-level member — never inside a half-written item. Returns the value, or null when there is nothing complete to keep. */
function salvageJson(text) {
  const t = stripReasoning(text).replace(/^\s*```(?:json)?\s*/i, ''); const s = t.search(/[{[]/); if (s < 0) return null;
  const stack = []; let inStr = false, esc = false, safe = -1, safeStack = null, prev = '', strPrev = '', scalar = false;
  const mark = (end) => { const top = stack[stack.length - 1]; if ((top === '[' && stack.length <= 2) || (top === '{' && stack.length === 1)) { safe = end + 1; safeStack = stack.slice(); } };
  for (let i = s; i < t.length; i++) { const c = t[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') { inStr = false; if (stack[stack.length - 1] === '[' || strPrev === ':') mark(i); prev = '"'; } continue; }
    if (scalar && /[\s,}\]]/.test(c)) { scalar = false; mark(i - 1); }
    if (/\s/.test(c)) continue;
    if (c === '"') { inStr = true; strPrev = prev; continue; }
    if (c === '{' || c === '[') { stack.push(c); prev = c; continue; }
    if (c === '}' || c === ']') { stack.pop(); if (!stack.length) { try { return JSON.parse(repairJson(t.slice(s, i + 1))); } catch { return null; } } mark(i); prev = c; continue; }
    if (c === ',' || c === ':') { prev = c; continue; }
    if (!scalar) scalar = true; prev = 'x';
  }
  if (safe < 0) return null;
  const closers = safeStack.reverse().map((b) => (b === '{' ? '}' : ']')).join('');
  try { return JSON.parse(repairJson(t.slice(s, safe) + closers)); } catch { return null; }
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

/* ---- answers that arrive (HTTP 200) without usable JSON. Real causes, all seen with Groq / Ollama / OpenRouter / Gemini:
 *   - a THINKING model (gpt-oss, Qwen3, DeepSeek-R1, Gemini 2.5...) pays its hidden reasoning out of max_tokens: with a small budget the answer is EMPTY (finish_reason "length");
 *   - a reply cut by the limit in the middle of the JSON;  - prose instead of JSON ("I cannot...", "Here is...");  - a 200 whose body is an error (OpenRouter...).
 * The ladder, per endpoint and per request: (1) give a cut reply more room, ask a thinking model to think little; (2) for prose: say it strictly + JSON mode;
 * (3) at the cap keep the COMPLETE items of a cut reply; (4) otherwise give up on that endpoint for this request (another one may serve it). What worked is remembered (`learned`),
 * a refused optional parameter is dropped for good, and a model that keeps answering without JSON is parked with the reason instead of being asked again and again. */
const STRICT = '\n\nIMPORTANT: your previous reply contained no usable JSON. Answer with the JSON value ONLY — it must start with { and end with }. Do not think aloud, explain, or add any other text.';
const PARAM_RE = /response_format|json_object|json mode|reasoning|thinking|thinkingBudget|unsupported (parameter|property|argument)|unknown (parameter|field|property|argument)|unrecognized|extra inputs?|additional properties|not permitted|does not support/i;
const REASONER_RE = /gpt-oss|qwen3|qwq|deepseek-r1|(^|[/:_-])r1([/:_.-]|$)|reason|think|magistral|(^|[/:])o[134](-|$)|gemini-(2\.5|3)/i;
const isReasoner = (m) => REASONER_RE.test(String(m || ''));
/** The knob that makes a thinking model think little (per family; a provider that does not know it answers 400 and the knob is dropped for good). */
function quietParams(e) {
  const m = String(e.model || ''); let host = ''; try { host = new URL(e.base).hostname; } catch { /* ignore */ }
  if (e.kind === 'gemini') return /gemini-2\.5-flash/i.test(m) ? { thinkingConfig: { thinkingBudget: 0 } } : {};
  if (e.kind !== 'openai') return {};
  if (/qwen3|qwq/i.test(m)) return { reasoning_effort: 'none' };
  if (/deepseek-r1|(^|[/:_-])r1([/:_.-]|$)/i.test(m)) return /groq\.com$/.test(host) ? { reasoning_format: 'hidden' } : {};
  return isReasoner(m) ? { reasoning_effort: 'low' } : {};
}
/** An error object found INSIDE a 200 response -> the HTTP status it means + its text. */
function errInfo(er) {
  const o = er && typeof er === 'object' ? er : { message: String(er || '') }; const msg = String(o.message || (o.error && o.error.message) || JSON.stringify(o)).slice(0, 400); const n = +(o.code || o.status || (o.error && o.error.code));
  return { status: n >= 400 && n < 600 ? n : /rate.?limit|too many requests|quota|overloaded|capacity/i.test(msg) ? 429 : CREDIT_RE.test(msg) ? 402 : 502, text: msg };
}

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
    this.noParam = new Set(); this.learned = null; this.badJson = 0;      // optional parameters this provider refused; the request shape that fixed an unusable answer; consecutive answers without JSON
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

  async _acquire(deadline, avoid, skip = new Set(), est = 0, prefer = null) {
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
      const pref = prefer && prefer.size ? any.filter(([, i]) => prefer.has(i)) : [];            // an endpoint whose answer is being asked again (adjusted) is asked again, if it is free
      if (any.length) { const [, i] = best(pref.length ? pref : any); this.eps[i].stamps.push(now); if (est) this.eps[i].tokStamps.push([now, est]); this.rr = (i + 1) % n; return [this.eps[i], i]; }
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
  revive(id) { for (const e of this.eps) if (e.id === id) { e.dead = false; e.deadReason = ''; e.outUntil = 0; e.outReason = ''; e.coolUntil = 0; e.fails = 0; e.badJson = 0; } }
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
  /** The request for one endpoint. `hint` (set after an unusable answer, or learned from one) = { mul: output room x, quiet: think little, json: JSON mode, strict: say it plainly }.
   *  Returns the request plus `extras` (optional parameters it carries: if the provider refuses them they are dropped), `out` (output budget used) and `cap` (the most this endpoint can give). */
  _body(e, task, system, prompt, maxTokens, hint) {
    const h = hint || {}; const mul = h.mul || 1; const ok = (k) => !e.noParam.has(k); const clamp = (n) => Math.max(64, Math.min(n, e.maxOut));
    const sys = system + '\n\nReturn ONLY one valid JSON value. No prose, no markdown fences.' + (h.strict ? STRICT : ''); const temperature = task === 'generate' ? 0.4 : 0;
    if (e.kind === 'anthropic') { const c5 = isClaude5(e.model); const out = c5 ? Math.max(clamp(maxTokens), 16000) : clamp(maxTokens);
      // relay: the page sends NO key and no provider headers; the relay adds them server-side
      const headers = e.relay ? { 'content-type': 'application/json' } : { 'content-type': 'application/json', 'x-api-key': e.key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' };
      return { url: `${e.base}/v1/messages`, headers, extras: [], out, cap: out, body: { model: e.model, max_tokens: out, system: [{ type: 'text', text: sys, cache_control: { type: 'ephemeral' } }], messages: [{ role: 'user', content: prompt }],
        ...(c5 ? { output_config: { effort: EFFORT[task] || 'medium' } } : {}) } }; }
    if (e.kind === 'gemini') {
      // JSON mime type = the model must answer with JSON; the output budget leaves room for the "thinking" tokens of 2.5-class models (which are paid from it)
      const lim = /gemini-(2\.5|3)/i.test(e.model) ? 32768 : 8192; const out = Math.min(lim, Math.max(clamp(maxTokens), 8192) * mul); const gen = { temperature, maxOutputTokens: out, responseMimeType: 'application/json' }; const extras = [];
      if (h.quiet && ok('thinkingConfig')) { const q = quietParams(e); if (q.thinkingConfig) { gen.thinkingConfig = q.thinkingConfig; extras.push('thinkingConfig'); } }
      return { url: `${e.base}/v1beta/models/${encodeURIComponent(e.model)}:generateContent`, headers: { 'content-type': 'application/json', 'x-goog-api-key': e.key }, extras, out, cap: lim,
        body: { systemInstruction: { parts: [{ text: sys }] }, contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: gen } }; }
    const base = clamp(maxTokens); const out = Math.max(base, Math.min(clamp(maxTokens * mul), 16000)); const cap = Math.max(out, Math.min(e.maxOut, 16000));
    const body = { model: e.model, max_tokens: out, temperature, messages: [{ role: 'system', content: sys }, { role: 'user', content: prompt }] }; const extras = [];
    if (h.json && ok('response_format')) { body.response_format = { type: 'json_object' }; extras.push('response_format'); }
    if (h.quiet) for (const [k, v] of Object.entries(quietParams(e))) if (ok(k)) { body[k] = v; extras.push(k); }
    return { url: `${e.base}/chat/completions`, headers: { 'content-type': 'application/json', ...(e.key ? { authorization: `Bearer ${e.key}` } : {}) }, body, extras, out, cap };
  }
  /** What a 200 answer holds: { text, cut (stopped by the output limit), reasoning (it did hidden thinking), why } — or { error } when the body is an error in disguise. */
  _read(e, data) {
    const d = data && typeof data === 'object' ? data : {};
    if (e.kind === 'gemini') { if (d.error) return { error: errInfo(d.error) };
      const c = (d.candidates || [])[0] || {}; const parts = (c.content || {}).parts || []; const fin = String(c.finishReason || ''); const block = (d.promptFeedback || {}).blockReason;
      return { text: parts.filter((x) => x && !x.thought).map((x) => x.text || '').join(''), cut: fin === 'MAX_TOKENS', reasoning: parts.some((x) => x && x.thought) || ((d.usageMetadata || {}).thoughtsTokenCount || 0) > 0, why: block ? `حجب المزوّد الطلب (${block})` : fin && fin !== 'STOP' ? fin : '' }; }
    if (e.kind === 'anthropic') { if (d.type === 'error' || d.error) return { error: errInfo(d.error || d) };
      const blocks = Array.isArray(d.content) ? d.content : [];
      return { text: blocks.filter((b) => b && b.type === 'text').map((b) => b.text || '').join(''), cut: d.stop_reason === 'max_tokens', reasoning: blocks.some((b) => b && b.type === 'thinking'), why: d.stop_reason === 'refusal' ? 'رفض النموذج الطلب' : '' }; }
    if (d.error) return { error: errInfo(d.error) };
    const ch = (d.choices || [])[0] || {}; if (ch.error) return { error: errInfo(ch.error) };
    const m = ch.message || {}; let text = m.content;
    if (Array.isArray(text)) text = text.map((x) => (typeof x === 'string' ? x : x && (x.type === 'text' || x.type === 'output_text' || (!x.type && typeof x.text === 'string')) ? x.text || '' : '')).join('');   // parts: only the text ones (thinking parts are skipped)
    return { text: typeof text === 'string' ? text : '', cut: ch.finish_reason === 'length', reasoning: !!(m.reasoning || m.reasoning_content || (m.reasoning_details && m.reasoning_details.length)), why: ch.finish_reason && ch.finish_reason !== 'stop' ? String(ch.finish_reason) : '' };
  }
  /** The next, STRONGER way to ask the same endpoint after an unusable answer (or null when there is none): more room if it was cut, a thinking model told to think little,
   *  a prose answer asked again strictly and in JSON mode. */
  _escalate(e, got, cut, grow, used) {
    const u = used || {}; const n = { mul: u.mul || 1, quiet: !!u.quiet, json: !!u.json, strict: !!u.strict }; let changed = false; const thinker = !!got.reasoning || isReasoner(e.model);
    const quiet = () => Object.keys(quietParams(e)).some((k) => !e.noParam.has(k));
    if (cut) { if (grow) { n.mul = (u.mul || 1) * 3; changed = true; } }
    else { if (!n.strict) { n.strict = true; changed = true; } if (!n.json && e.kind === 'openai' && !e.noParam.has('response_format')) { n.json = true; changed = true; } }
    if (thinker && !n.quiet && quiet()) { n.quiet = true; changed = true; }
    return changed ? n : null;
  }
  _noJson(e, got, cut, out) {
    const who = `${e.name} (${e.model})`; const snip = stripReasoning(got.text).replace(/\s+/g, ' ').trim().slice(0, 140);
    if (cut) return new PoolError(`${who}: انقطع جواب النموذج عند حدّ الإخراج (${out} رمزًا) قبل أن يكتمل${got.reasoning || isReasoner(e.model) ? ' — هذا نموذج «تفكير» يصرف الحدّ في التفكير؛ اختر نموذجًا غير تفكيري مثل llama-3.3-70b-versatile' : ''}.`, 'too_large');
    if (!snip) return new PoolError(`${who}: ردّ النموذج بجواب فارغ${got.why ? ' (' + got.why + ')' : ''}.`, 'bad_json');
    return new PoolError(`${who}: لم يلتزم النموذج بالرد بصيغة JSON: «${snip}».`, 'bad_json');
  }
  /** One more request this endpoint could not answer in JSON even when asked in every way. The third in a row parks it (like a wrong key): asking again would only waste the visitor's time and the provider's quota. */
  _strike(e) { e.badJson = (e.badJson || 0) + 1; if (e.badJson >= 3) { e.dead = true; e.deadReason = `النموذج ${e.model} لا يردّ بصيغة JSON (جرّب نموذجًا غير تفكيري مثل llama-3.3-70b-versatile)`; } }
  /** A 200 answer: { out } usable (maybe the complete part of a cut one: `partial`), { retry } ask this endpoint again adjusted, or { fail } give up on it for this request. */
  _judge(e, got, req, used) {
    let perr; try { return { out: extractJson(got.text) }; } catch (er) { perr = er; }
    const cut = !!got.cut || !!perr.truncated; const next = this._escalate(e, got, cut, req.out < req.cap, used);
    if (cut && req.out < req.cap && next) return { retry: next };              // more room first: the complete answer beats a partial one
    const part = salvageJson(got.text); if (part) return { out: part, partial: cut };
    if (next) return { retry: next };
    return { fail: this._noJson(e, got, cut, req.out), strike: !cut };           // asked in every way and still nothing: that is one strike (retries are not: six parallel first requests must not park a model the retry would fix)
  }

  async json(task, system, prompt, maxTokens = 6000, o = {}) {
    if (!this.eps.length) throw new PoolError('لا يوجد مفتاح توليد: أضف مفتاحًا من صفحة الإعدادات.', 'llm_not_configured');
    const deadline = this.now() + this.maxWait; const avoid = new Set(); const skip = new Set(); const errs = []; const inTok = Math.ceil((String(system).length + String(prompt).length) / 3);   // ~3 characters per token (Arabic is denser than English)
    const hints = new Map(), prefer = new Set();        // per endpoint: the adjusted way to ask again after an unusable answer, and the endpoint to ask again first
    for (let attempt = 0; attempt < Math.max(6, 3 * this.eps.length); attempt++) {
      if (o.once && errs.length) throw this._final(errs);      // a connection test: one honest try per endpoint, the answer at once (no cool-down waiting)
      let e, idx;
      const room = Math.max(maxTokens, ...[...hints.values()].map((h) => maxTokens * (h.mul || 1)));
      try { [e, idx] = await this._acquire(deadline, avoid, skip, inTok + room, prefer); } catch (err) {
        if (errs.length && err.code === 'keys_invalid') throw this._final(errs);
        if (errs.length && err.code === 'rate_limited') throw new PoolError(err.message + ' — ' + [...new Set(errs.map((x) => x.message))].slice(-4).join(' | '), 'rate_limited');   // say what each one answered
        throw err;
      }
      const hint = hints.get(idx) || e.learned || null; const req = this._body(e, task, system, prompt, maxTokens, hint);
      let resp;
      try { resp = await this.fetch(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body) }); }
      catch (err) { errs.push(new PoolError(`${e.name}: تعذّر الاتصال (${err.message || err}). قد يمنع المزوّد الطلبات من المتصفح (CORS).`, 'network')); this._cool(e, 0, null, ''); avoid.add(idx); continue; }
      let status = resp.status, t = '', raw = '', got = null;
      if (resp.ok) {                                            // a 200 may still be an error in disguise, or an answer without JSON
        let data = null; try { data = await resp.json(); } catch { /* not JSON at all: a proxy / portal page */ }
        got = this._read(e, data); if (got.error) { status = got.error.status; t = got.error.text; got = null; }
      }
      if (status === 401 || status === 403) { e.dead = true; e.deadReason = `HTTP ${status} (مفتاح غير صالح أو غير مصرّح)`; errs.push(new PoolError(`${e.name}: ${e.deadReason}`, 'auth')); avoid.add(idx); continue; }
      if (got) {
        const v = this._judge(e, got, req, hint);
        if (v.out !== undefined) { e.fails = 0; e.used++; e.badJson = 0; if (hints.has(idx)) e.learned = hints.get(idx); if (v.partial) e.scale = Math.max(0.1, e.scale * 0.7); return v.out; }    // a cut reply keeps its complete items; the next pieces are smaller
        if (v.strike) this._strike(e);
        if (v.retry) { hints.set(idx, v.retry); prefer.add(idx); attempt--; continue; }           // the same endpoint again, asked in the stronger way (not a failed attempt)
        hints.delete(idx); prefer.delete(idx); errs.push(v.fail); avoid.add(idx); skip.add(idx); if (v.fail.code === 'too_large') e.scale = Math.max(0.1, e.scale * 0.5);
        continue;
      }
      if (!resp.ok) { try { raw = await resp.text(); } catch { /* ignore */ } t = raw.slice(0, 400); }
      avoid.add(idx);
      // optional parameters we added on a retry (JSON mode, "think little") that this provider does not know: send the same request again without them for good; the endpoint is not at fault
      if (req.extras.length && status >= 400 && status < 500 && ![401, 402, 403, 429].includes(status) && PARAM_RE.test(t)) { req.extras.forEach((k) => e.noParam.add(k)); avoid.delete(idx); attempt--; continue; }
      // Groq's JSON mode refuses a document that is invalid or was cut, and hands the text back: read it instead of throwing it away
      if (status === 400 && /json_validate_failed|failed to generate json/i.test(raw || t)) {
        let fg = ''; try { fg = String(JSON.parse(raw).error.failed_generation || ''); } catch { /* not JSON */ }
        let out; try { out = extractJson(fg); } catch { out = salvageJson(fg); if (out) e.scale = Math.max(0.1, e.scale * 0.7); }
        if (out) { e.fails = 0; e.used++; e.badJson = 0; return out; }
        e.scale = Math.max(0.1, e.scale * 0.5); errs.push(new PoolError(`${e.name} (${e.model}): تعذّر على النموذج كتابة جواب JSON كامل ضمن حدّ الإخراج.`, 'too_large')); skip.add(idx); continue;
      }
      if (status === 429 || status === 402 || status >= 500) {
        if (status === 402 || CREDIT_RE.test(t)) { this._out(e, reasonOf(status, t)); errs.push(new PoolError(`${e.name}: HTTP ${status} ${t.slice(0, 240)}`, 'rate_limited')); }
        else { this._cool(e, status, resp.headers && resp.headers.get && resp.headers.get('retry-after'), t); errs.push(new PoolError(`${e.name}: HTTP ${status}`, 'rate_limited')); }
        continue;
      }
      if (status === 413 || TOO_LARGE_RE.test(t)) {           // too big for THIS provider (e.g. Groq free: "Limit 8000, Requested 33128"): learn its size, let another provider try, and tell the engine to send smaller pieces
        const lim = parseLimit(t); e.scale = Math.max(0.1, e.scale * 0.5);
        if (lim) { e.tpm = lim.limit; const room2 = lim.limit - Math.max(0, lim.requested - req.out) - 150; if (room2 >= 600) e.maxOut = Math.min(e.maxOut, room2); }
        errs.push(new PoolError(`${e.name}: HTTP ${status} ${t.slice(0, 300)}`, 'too_large')); skip.add(idx); continue;
      }
      // any other refusal (400, 404, 413, 422...): this endpoint cannot serve THIS request. Say why, and let the next endpoint try.
      errs.push(new PoolError(`${e.name}: HTTP ${status} ${t.slice(0, 300)}`, 'bad_request'));
      if (CREDIT_RE.test(t)) this._out(e, reasonOf(status, t));                               // account-level: out for a while, tried again by itself
      else if (status === 404 || KEYFIX_RE.test(t)) { e.dead = true; e.deadReason = reasonOf(status, t); }   // the key/model must be fixed by the operator
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
    // 400 tokens, not 50: a "thinking" model pays its hidden reasoning out of this budget, and with 64 it answers NOTHING ("no JSON in model output"). Any JSON object proves the key, the model and the format.
    try { const r = await p.json('test', 'You are a connectivity probe.', 'Return the JSON {"ok": true}.', 400, { once: true }); return { ok: !!r && typeof r === 'object', ms: this.now() - t0 }; }
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
const NOT_CHAT = /(embed|tts|whisper|audio|image|imagen|veo|guard|moderation|rerank|transcri|speech|-live|aqa|robotics|computer-use|dall|distil-whisper|orpheus)/i;
/** Choose a sensible default chat model out of what the key can use (stable ids, newest, free-tier friendly). */
function pickModel(kind, base, ids) {
  const all = [...new Set((ids || []).map((x) => String(x).replace(/^models\//, '')))].filter(Boolean);
  const chat = all.filter((x) => !NOT_CHAT.test(x));
  const ver = (x) => { const m = String(x).match(/(\d+(?:\.\d+)?)/); return m ? +m[1] : 0; };
  const best = (arr, re) => arr.filter((x) => re.test(x)).sort((a, b) => ver(b) - ver(a) || a.length - b.length)[0];
  let host = ''; try { host = new URL(base).hostname; } catch { /* ignore */ }
  if (kind === 'gemini' || /generativelanguage\.googleapis\.com$/.test(host)) {
    const stable = chat.filter((x) => /^gemini-[\d.]+-flash(-lite)?$/.test(x));        // no -preview / -exp / dated snapshots
    return best(stable, /-flash$/) || best(stable, /-flash-lite$/) || best(chat, /^gemini-[\d.]+-(flash|pro)/) || chat[0] || null;
  }
  if (/groq\.com$/.test(host)) { const pri = ['llama-3.3-70b-versatile', 'meta-llama/llama-4-maverick-17b-128e-instruct', 'moonshotai/kimi-k2-instruct-0905', 'moonshotai/kimi-k2-instruct', 'meta-llama/llama-4-scout-17b-16e-instruct', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'llama-3.1-8b-instant', 'qwen/qwen3-32b'];   // answering models first: the "thinking" ones (gpt-oss, qwen3) pay hidden reasoning out of the output budget
    return pri.find((m) => chat.includes(m)) || chat.find((m) => !isReasoner(m)) || chat[0] || null; }
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
/** The models to try, best first: the pick, then the other chat models of the key (answering models before thinking ones). Used when the pick turns out not to work (it never answers in JSON, it is
 *  not available to this key): the connect card goes on to the next one instead of stopping. OpenRouter: free models only (nothing paid is ever tried silently). Claude: the operator's own choice. */
function rankModels(kind, base, ids) {
  const first = pickModel(kind, base, ids); if (!first) return [];
  let host = ''; try { host = new URL(base).hostname; } catch { /* ignore */ }
  if (kind === 'anthropic' || kind === 'gemini' || /anthropic\.com$|generativelanguage\.googleapis\.com$/.test(host)) return [first];
  const chat = [...new Set((ids || []).map((x) => String(x).replace(/^models\//, '')))].filter((x) => x && !NOT_CHAT.test(x) && x !== first && (!/openrouter\.ai$/.test(host) || /:free$/.test(x)));
  return [first, ...chat.map((m, i) => [m, i]).sort((a, b) => (isReasoner(a[0]) - isReasoner(b[0])) || (a[1] - b[1])).map(([m]) => m)];
}
window.QZ_POOL = { LLMPool, PoolError, extractJson, salvageJson, pickModel, rankModels, isClaude5, isReasoner, rankOf, ANTHROPIC_MODELS };
if (typeof module !== 'undefined') module.exports = window.QZ_POOL;
})();
