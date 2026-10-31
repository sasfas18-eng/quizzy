// node static-edition/test/json_robust.test.js — "no JSON in model output": an answer that arrives (HTTP 200) without usable JSON is recovered, never fatal.
// What real providers do (Groq, Ollama, OpenRouter, Gemini 2.5...): a "thinking" model spends the whole output budget thinking and the answer is EMPTY (finish_reason "length");
// an unclosed <think> block; a prose reply; a 200 that carries an error body; a reply cut in the middle; JSON wrapped in prose; content sent as parts.
global.window = {}; const { LLMPool, PoolError, extractJson, salvageJson } = require('../../shared/pool.js'); const assert = require('assert');
const clock = () => { const c = { t: 1e6, slept: 0, now: () => c.t, sleep: async (ms) => { c.t += ms; c.slept += ms; } }; return c; };
const res = (status, body = {}, headers = {}) => ({ status, ok: status >= 200 && status < 300, headers: { get: (k) => headers[k.toLowerCase()] }, json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const OAI = (obj) => res(200, { choices: [{ finish_reason: 'stop', message: { content: '```json\n' + JSON.stringify(obj) + '\n```' } }] });
const chat = (content, extra = {}, finish = 'stop') => res(200, { choices: [{ finish_reason: finish, message: { role: 'assistant', content, ...extra } }] });
const ep = (name, extra = {}) => ({ name, kind: 'openai', base: `https://${name}.example/v1`, key: 'k-' + name, model: 'm', rpm: 100, ...extra });
const GQ = (model, extra = {}) => ({ name: 'Groq', kind: 'openai', base: 'https://api.groq.com/openai/v1', key: 'gsk_x', model, rpm: 100, ...extra });
const mk = (endpoints, fetch, c, opts = {}) => new LLMPool(endpoints, { fetch, now: c.now, sleep: c.sleep, ...opts });
const body = (init) => JSON.parse(init.body);
const T = []; const scenario = (name, fn) => T.push([name, fn]);

scenario('1) extractJson: unclosed <think>, a stray closing tag, brackets in prose, trailing commas, raw newlines, truncation', async () => {
  assert.throws(() => extractJson('<think>I should output {"ok": true} perhaps, let me think'), (e) => e.code === 'bad_json', 'a cut-off thinking block is not an answer (its braces must not be taken for one)');
  assert.deepStrictEqual(extractJson('reasoning with {braces} first</think>\n{"a":1}'), { a: 1 }, 'a template that put <think> in the prompt leaves only the closing tag');
  assert.deepStrictEqual(extractJson('See [page 3] for details. Here you go: {"a":1}'), { a: 1 }, 'a bracket in prose is not the answer');
  assert.deepStrictEqual(extractJson('{"a":"x\ny","b":[1,2,],}'), { a: 'x\ny', b: [1, 2] }, 'trailing commas and a raw newline inside a string are repaired');
  assert.deepStrictEqual(extractJson('[{"a":1}]'), [{ a: 1 }], 'a top-level array is still an array');
  assert.throws(() => extractJson('{"questions":[{"slot":1,"stem":"cut'), (e) => e.code === 'bad_json' && e.truncated === true, 'a reply cut in the middle says so');
  assert.deepStrictEqual(extractJson('{"a":"x } y"} trailing words {"b":2}'), { a: 'x } y' }, 'the first complete value wins'); });

scenario('1b) salvageJson: the complete items of a cut-off reply, never a half item', async () => {
  const cut = '{"questions":[{"slot":1,"stem":"a"},{"slot":2,"stem":"b"},{"slot":3,"stem":"c';
  assert.deepStrictEqual(salvageJson(cut), { questions: [{ slot: 1, stem: 'a' }, { slot: 2, stem: 'b' }] });
  assert.deepStrictEqual(salvageJson('{"results":[{"id":"q1","ok":true},{"id":"q2","ok":false},'), { results: [{ id: 'q1', ok: true }, { id: 'q2', ok: false }] });
  assert.deepStrictEqual(salvageJson('[{"a":1},{"a":2},{"a"'), [{ a: 1 }, { a: 2 }]);
  assert.strictEqual(salvageJson('{"questions":[{"slot":1,"stem":"par'), null, 'no complete item: nothing to keep');
  assert.strictEqual(salvageJson('{"questions":[{"slot":1,"options":["a","b"'), null, 'an inner list of a half-written item is not an item');
  assert.strictEqual(salvageJson('no json here'), null); assert.strictEqual(salvageJson(''), null);
  assert.deepStrictEqual(salvageJson('{"lecture_character":"abc","objectives":[{"id":"o1","statement":"x","pa'), { lecture_character: 'abc' }, 'a finished top-level member survives'); });

scenario('2) a THINKING model (gpt-oss, Qwen3, R1...) on a small budget: empty answer -> retried quietly with a bigger budget; the connection probe too; and it is learned', async () => {
  const seen = []; const f = async (url, init) => { const b = body(init); seen.push(b); const need = b.reasoning_effort === 'low' ? 200 : 3000;      // hidden reasoning is paid from max_tokens first
    return b.max_tokens < need ? chat('', { reasoning: 'Okay, the user wants me to return JSON. Let me think about the format...' }, 'length') : chat('{"ok": true}'); };
  // the probe the operator's "connect" button makes (it used to ask for 64 tokens: the user's "no JSON in model output")
  { const c = clock(); const r = await mk([], f, c).test(GQ('openai/gpt-oss-20b')); assert.strictEqual(r.ok, true, 'the probe passes for a thinking model'); }
  seen.length = 0; const c = clock(); const p = mk([GQ('openai/gpt-oss-20b')], f, c);
  assert.deepStrictEqual(await p.json('generate', 's', 'p', 500), { ok: true }); assert.strictEqual(seen.length, 2, 'one failed try, one adjusted try'); assert.strictEqual(seen[1].reasoning_effort, 'low', 'asks the model to think little'); assert(seen[1].max_tokens > seen[0].max_tokens, 'and gives it room');
  seen.length = 0; assert.deepStrictEqual(await p.json('generate', 's', 'p', 500), { ok: true }); assert.strictEqual(seen.length, 1, 'learned: the next request starts with what worked (no failed try)'); assert.strictEqual(seen[0].reasoning_effort, 'low');
  assert.strictEqual(p.status()[0].state, 'ready'); });

scenario('3) the provider refuses the reasoning parameter: it is dropped and remembered, the endpoint is not blamed', async () => {
  const seen = []; const f = async (url, init) => { const b = body(init); seen.push(b); if ('reasoning_effort' in b) return res(400, { error: { message: "`reasoning_effort` is not supported with this model", type: 'invalid_request_error' } }); return b.max_tokens < 1200 ? chat('', {}, 'length') : chat('{"ok":1}'); };
  const c = clock(); const p = mk([GQ('qwen/qwen3-32b')], f, c); assert.deepStrictEqual(await p.json('generate', 's', 'p', 500), { ok: 1 });
  assert(seen.some((b) => 'reasoning_effort' in b) && !('reasoning_effort' in seen.at(-1)), 'tried it once, then sent without'); assert.strictEqual(p.status()[0].state, 'ready', 'a refused optional parameter is not a dead key');
  seen.length = 0; await p.json('generate', 's', 'p', 500); assert(seen.every((b) => !('reasoning_effort' in b)), 'never sent again'); });

scenario('4) a prose answer ("I cannot...", "Here is..."): asked again, strictly and in JSON mode', async () => {
  const seen = []; const f = async (url, init) => { const b = body(init); seen.push(b); return b.response_format && b.response_format.type === 'json_object' ? chat('{"ok":1}') : chat("I'm sorry, but I can't help with that request."); };
  const c = clock(); const p = mk([ep('a')], f, c); assert.deepStrictEqual(await p.json('generate', 'SYS', 'p'), { ok: 1 }); assert.strictEqual(seen.length, 2);
  assert(/start with \{/.test(seen[1].messages[0].content) && seen[1].messages[0].content.startsWith('SYS'), 'the retry says it plainly'); assert.deepStrictEqual(seen[1].response_format, { type: 'json_object' });
  seen.length = 0; assert.deepStrictEqual(await p.json('generate', 'SYS', 'p'), { ok: 1 }); assert.strictEqual(seen.length, 1, 'learned: JSON mode from the start for this endpoint');
  // a provider that does not know JSON mode: the parameter is dropped, the strict wording still applies
  const seen2 = []; const g = async (url, init) => { const b = body(init); seen2.push(b); if ('response_format' in b) return res(400, { error: { message: 'Unrecognized request argument supplied: response_format' } }); return /start with \{/.test(b.messages[0].content) ? chat('{"ok":2}') : chat('Sure! I will do it.'); };
  assert.deepStrictEqual(await mk([ep('b')], g, clock()).json('generate', 's', 'p'), { ok: 2 }); assert(seen2.length === 3 && !('response_format' in seen2[2])); });

scenario('5) a reply cut by the output limit: bigger room first; at the cap the complete items are kept; the next requests get smaller', async () => {
  const full = { questions: [1, 2, 3, 4].map((n) => ({ slot: n, stem: 'question ' + n })) }; const text = JSON.stringify(full);
  { const seen = []; const f = async (url, init) => { const b = body(init); seen.push(b.max_tokens); return b.max_tokens >= 2000 ? chat(text, {}, 'stop') : chat(text.slice(0, 70), {}, 'length'); };
    const p = mk([ep('a')], f, clock()); assert.deepStrictEqual(await p.json('generate', 's', 'p', 1000), full); assert(seen[1] >= 3000 || seen[1] > seen[0], 'second try with more room: ' + seen); }
  { const cut = text.slice(0, text.indexOf('"slot":3') + 8); const p = mk([GQ('llama-3.3-70b-versatile')], async () => chat(cut, {}, 'length'), clock()); const before = p.scale();      // Groq's cap is 2500: no more room to give
    const r = await p.json('generate', 's', 'p', 2500); assert.deepStrictEqual(r.questions.map((q) => q.slot), [1, 2], 'the two complete questions are kept'); assert(p.scale() < before, 'the engine will now send smaller pieces'); }
  { const p = mk([GQ('llama-3.3-70b-versatile')], async () => chat('{"questions":[{"slot":1,"stem":"cut', {}, 'length'), clock()); await assert.rejects(() => p.json('generate', 's', 'p', 2500), (e) => e.code === 'too_large' && /انقطع/.test(e.message), 'nothing complete: the engine is told to send smaller pieces'); } });

scenario('6) a 200 that carries an ERROR body (OpenRouter and others): treated like the HTTP error it says, never "no JSON"', async () => {
  { const f = async (url) => (url.includes('//a.') ? res(200, { error: { message: 'Provider returned error', code: 429 } }) : OAI({ from: 'b' })); const c = clock(); const p = mk([ep('a'), ep('b')], f, c);
    assert.deepStrictEqual(await p.json('generate', 's', 'p'), { from: 'b' }); assert.strictEqual(p.status().find((x) => x.name === 'a').state, 'cooling'); }
  { const f = async (url) => (url.includes('//a.') ? res(200, { error: { message: 'Insufficient credits. Add more using https://openrouter.ai/credits', code: 402 } }) : OAI({ from: 'b' })); const p = mk([ep('a'), ep('b')], f, clock());
    assert.deepStrictEqual(await p.json('generate', 's', 'p'), { from: 'b' }); assert.strictEqual(p.status().find((x) => x.name === 'a').state, 'out'); }
  { const p = mk([ep('a')], async () => res(200, { choices: [{ error: { message: 'upstream exploded', code: 500 }, finish_reason: 'error', message: { content: '' } }] }), clock(), { maxWait: 1000 });
    await assert.rejects(() => p.json('generate', 's', 'p'), (e) => !/no JSON/i.test(e.message) && e.code !== 'bad_json', 'an upstream error is not reported as a JSON problem'); } });

scenario('7) content as parts (Mistral / Magistral style) and thinking parts', async () => {
  assert.deepStrictEqual(await mk([ep('a')], async () => chat([{ type: 'text', text: '{"ok":1}' }]), clock()).json('generate', 's', 'p'), { ok: 1 });
  assert.deepStrictEqual(await mk([ep('a')], async () => chat([{ type: 'thinking', thinking: [{ type: 'text', text: 'hmm {"no": true}' }] }, { type: 'text', text: '{"ok":2}' }]), clock()).json('generate', 's', 'p'), { ok: 2 });
  assert.deepStrictEqual(await mk([ep('a')], async () => chat('<think>maybe {"x":1}</think>{"ok":3}'), clock()).json('generate', 's', 'p'), { ok: 3 }); });

scenario('8) a model that never answers in JSON: the others serve at once, and after three strikes it is parked with the reason (never hammered)', async () => {
  const hits = { a: 0, b: 0 }; const f = async (url) => { const k = url.includes('//a.') ? 'a' : 'b'; hits[k]++; return k === 'a' ? chat('Sorry, I will not do that.') : OAI({ from: 'b' }); };
  const c = clock(); const p = mk([ep('a'), ep('b')], f, c); for (let i = 0; i < 6; i++) assert.deepStrictEqual(await p.json('generate', 's', 'p'), { from: 'b' });
  const st = p.status().find((x) => x.name === 'a'); assert.strictEqual(st.state, 'dead'); assert(/JSON/.test(st.reason) && /\bm\b/.test(st.reason), 'says why and which model: ' + st.reason);
  const before = hits.a; for (let i = 0; i < 3; i++) await p.json('generate', 's', 'p'); assert.strictEqual(hits.a, before, 'parked: no more requests to it');
  p.revive('a'); assert.strictEqual(p.status().find((x) => x.name === 'a').state, 'ready'); });

scenario('9) nobody can answer in JSON: a clear Arabic error naming the model and what it said (never the bare English line)', async () => {
  const p = mk([GQ('some-chat-model')], async () => chat('عذرًا، لا أستطيع المساعدة في هذا الطلب.'), clock());
  await assert.rejects(() => p.json('analyze', 's', 'p'), (e) => e.code === 'bad_json' && /some-chat-model/.test(e.message) && /JSON/.test(e.message) && /لا أستطيع المساعدة/.test(e.message) && !/^no JSON in model output$/.test(e.message), 'message: ');
  const empty = mk([GQ('some-chat-model')], async () => chat('', {}, 'stop'), clock()); await assert.rejects(() => empty.json('analyze', 's', 'p'), (e) => e.code === 'bad_json' && /فارغ/.test(e.message), 'an empty reply is called empty');
  const think = mk([GQ('openai/gpt-oss-20b')], async () => chat('', { reasoning: 'thinking...' }, 'length'), clock()); await assert.rejects(() => think.json('analyze', 's', 'p', 2500), (e) => /تفكير/.test(e.message) && /llama/.test(e.message), 'a thinking model that cannot finish is named as such, with a model to choose instead'); });

scenario('10) the connection probe: one honest try, the answer at once, whatever the model returns as JSON', async () => {
  let n = 0; const c = clock(); const r = await mk([], async () => { n++; return chat('{"status":"fine"}'); }, c).test(ep('t')); assert.strictEqual(r.ok, true, 'any JSON object proves the connection and the format'); assert.strictEqual(n, 1);
  n = 0; await assert.rejects(() => mk([], async () => { n++; return chat('Hello! How can I help you today?'); }, clock()).test(ep('t', { model: 'chatty-1' })), (e) => e.code === 'bad_json' && /chatty-1/.test(e.message)); assert(n <= 2, 'at most the one adjusted retry: ' + n); });

scenario('11) Groq JSON mode failure (400 json_validate_failed): the text it was writing is read, not discarded', async () => {
  const failed = '{"questions":[{"slot":1,"stem":"a"}]}\n\nHope this helps!';
  const f = async () => res(400, { error: { message: "Failed to generate JSON. Please adjust your prompt. See 'failed_generation' for more details.", type: 'invalid_request_error', code: 'json_validate_failed', failed_generation: failed } });
  const p = mk([GQ('llama-3.3-70b-versatile')], f, clock()); assert.deepStrictEqual(await p.json('generate', 's', 'p'), { questions: [{ slot: 1, stem: 'a' }] }); assert.strictEqual(p.status()[0].state, 'ready');
  const g = async () => res(400, { error: { message: 'Failed to generate JSON.', code: 'json_validate_failed', failed_generation: '{"questions":[{"slot":1,"stem":"cut' } }); await assert.rejects(() => mk([GQ('llama-3.3-70b-versatile')], g, clock()).json('generate', 's', 'p'), (e) => e.code === 'too_large'); });

scenario('12) Gemini 2.5: thinking eats the budget (finishReason MAX_TOKENS, no parts): asked again with thinking off and more room', async () => {
  const GM = { name: 'Gemini', kind: 'gemini', base: 'https://generativelanguage.googleapis.com', key: 'AIza', model: 'gemini-2.5-flash', rpm: 100 }; const seen = [];
  const f = async (url, init) => { const b = body(init); seen.push(b.generationConfig); const off = b.generationConfig.thinkingConfig && b.generationConfig.thinkingConfig.thinkingBudget === 0;
    return off ? res(200, { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{"ok":1}' }] } }] }) : res(200, { candidates: [{ finishReason: 'MAX_TOKENS', content: { role: 'model' } }] }); };
  const p = mk([GM], f, clock()); assert.deepStrictEqual(await p.json('generate', 's', 'p', 1000), { ok: 1 }); assert.strictEqual(seen.length, 2); assert(!seen[0].thinkingConfig, 'first try as before'); assert.strictEqual(seen[1].thinkingConfig.thinkingBudget, 0);
  // thinking parts are never taken for the answer
  const t = mk([GM], async () => res(200, { candidates: [{ finishReason: 'STOP', content: { parts: [{ thought: true, text: 'hmm {"no":1}' }, { text: '{"ok":2}' }] } }] }), clock()); assert.deepStrictEqual(await t.json('generate', 's', 'p'), { ok: 2 }); });

scenario('13) nothing that already worked changes: a clean answer is one request, the same body as before', async () => {
  const seen = []; const p = mk([ep('a')], async (u, i) => { seen.push(body(i)); return OAI({ ok: 1 }); }, clock()); await p.json('generate', 'SYS', 'USER', 3000);
  assert.strictEqual(seen.length, 1); assert.deepStrictEqual(Object.keys(seen[0]).sort(), ['max_tokens', 'messages', 'model', 'temperature']); assert.strictEqual(seen[0].max_tokens, 3000); assert.strictEqual(seen[0].messages[0].content, 'SYS\n\nReturn ONLY one valid JSON value. No prose, no markdown fences.'); });

(async () => {
  let bad = 0; for (const [name, fn] of T) { try { await fn(); console.log('ok   ' + name); } catch (e) { bad++; console.log('FAIL ' + name + '\n     ' + String((e && e.stack) || e).split('\n').slice(0, 4).join('\n     ')); } }
  if (bad) { console.error(`${bad} of ${T.length} scenarios failed`); process.exit(1); } console.log('json robustness tests ok');
})();
