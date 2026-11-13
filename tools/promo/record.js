// node tools/promo/record.js <claude-edition dist> <lecture.pdf> <out dir> — records the intro video of Quizzy (phone format, the real interface, Arabic captions).
// Claude is simulated (claude-edition/test/shim.js + tools/promo/promo_model.js) so that the video shows exactly the steps it describes; nothing leaves the machine.
const { chromium } = require('playwright'); const http = require('http'), fs = require('fs'), path = require('path');
const [dist, pdf, outDir] = process.argv.slice(2);
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2', '.pdf': 'application/pdf' };
const srv = http.createServer((q, r) => { let f = path.join(dist, decodeURIComponent(q.url.split('?')[0])); if (f.endsWith('/')) f += 'index.html'; fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); r.end(); } else { r.writeHead(200, { 'Content-Type': mime[path.extname(f)] || 'application/octet-stream' }); r.end(d); } }); });
// the overlay: a caption at the bottom (a step number and a line), full-screen cards, and a ring where the finger taps
const OVERLAY = `(() => { const css = \`
  #pv-cap{position:fixed;inset-inline:14px;bottom:18px;z-index:99999;background:rgba(14,24,22,.92);color:#fff;border-radius:18px;padding:14px 18px;font:600 19px/1.6 'IBM Plex Sans Arabic',system-ui,sans-serif;direction:rtl;box-shadow:0 10px 30px rgba(0,0,0,.25);transition:opacity .35s,transform .35s;opacity:0;transform:translateY(12px);pointer-events:none}
  #pv-cap.on{opacity:1;transform:none}#pv-cap b{display:inline-flex;align-items:center;justify-content:center;min-width:30px;height:30px;border-radius:99px;background:#FFD84A;color:#14231F;margin-inline-end:10px;font-size:16px}
  #pv-cap small{display:block;font-weight:500;font-size:15px;opacity:.85;margin-top:2px}
  #pv-card{position:fixed;inset:0;z-index:100000;background:#0F5D50;color:#FBF6EA;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:30px;direction:rtl;font-family:'IBM Plex Sans Arabic',system-ui,sans-serif;transition:opacity .5s;opacity:0}
  #pv-card.on{opacity:1}#pv-card .mk{width:92px;height:92px;border-radius:24px;background:#FBF6EA;color:#0F5D50;display:flex;align-items:center;justify-content:center;font:800 54px/1 'Reem Kufi Arabic',system-ui;margin-bottom:18px}
  #pv-card h1{font:800 44px/1.3 'Reem Kufi Arabic','IBM Plex Sans Arabic',system-ui;margin:0 0 10px}#pv-card p{font-size:21px;line-height:1.7;margin:0;opacity:.95}
  #pv-card ul{list-style:none;padding:0;margin:14px 0 0;text-align:start;font-size:19px;line-height:1.75}#pv-card li{margin:9px 0;padding-inline-start:30px;position:relative}
  #pv-card li::before{content:'✓';position:absolute;inset-inline-start:0;color:#FFD84A;font-weight:800}#pv-card .hl{color:#FFD84A}
  .pv-tap{position:fixed;z-index:100001;width:46px;height:46px;margin:-23px 0 0 -23px;border-radius:50%;border:4px solid #FFD84A;background:rgba(255,216,74,.25);pointer-events:none;animation:pvtap .7s ease-out forwards}
  @keyframes pvtap{from{transform:scale(.5);opacity:1}to{transform:scale(1.5);opacity:0}}\`;
  const add = () => { if (document.getElementById('pv-style')) return; const s = document.createElement('style'); s.id = 'pv-style'; s.textContent = css; document.head.appendChild(s); };
  window.__cap = (n, t, sub) => { add(); let c = document.getElementById('pv-cap'); if (!c) { c = document.createElement('div'); c.id = 'pv-cap'; document.body.appendChild(c); }
    if (!t) { c.classList.remove('on'); return; } c.innerHTML = (n ? '<b>' + n + '</b>' : '') + t + (sub ? '<small>' + sub + '</small>' : ''); requestAnimationFrame(() => c.classList.add('on')); };
  window.__card = (html) => { add(); let c = document.getElementById('pv-card'); if (!html) { if (c) { c.classList.remove('on'); setTimeout(() => c.remove(), 500); } return; }
    if (!c) { c = document.createElement('div'); c.id = 'pv-card'; document.body.appendChild(c); } c.innerHTML = html; requestAnimationFrame(() => c.classList.add('on')); };
  window.__tap = (x, y) => { add(); const d = document.createElement('div'); d.className = 'pv-tap'; d.style.left = x + 'px'; d.style.top = y + 'px'; document.body.appendChild(d); setTimeout(() => d.remove(), 800); };
})();`;
const wait = (p, ms) => p.waitForTimeout(ms);
(async () => {
  srv.listen(8840); const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, recordVideo: { dir: outDir, size: { width: 780, height: 1688 } } });
  await ctx.addInitScript({ path: path.join(__dirname, '..', '..', 'claude-edition', 'test', 'shim.js') }); await ctx.addInitScript({ path: path.join(__dirname, 'promo_model.js') }); await ctx.addInitScript({ content: OVERLAY });
  const p = await ctx.newPage(); const t0 = Date.now();
  const tap = async (sel) => { const el = p.locator(sel).first(); await el.scrollIntoViewIfNeeded(); const bb = await el.boundingBox(); if (bb) await p.evaluate(([x, y]) => window.__tap(x, y), [bb.x + bb.width / 2, bb.y + bb.height / 2]); await wait(p, 380); await el.click(); };
  const cap = (n, t, sub) => p.evaluate(([a, b2, c]) => window.__cap(a, b2, c), [n, t, sub || '']);
  const card = (html) => p.evaluate((h) => window.__card(h), html);

  await p.goto('http://localhost:8840/?viewer&lat=350#/files'); await p.waitForSelector('#file', { state: 'attached', timeout: 20000 });
  const startAt = (Date.now() - t0) / 1000;      // the first frames before the page are trimmed off
  // 0) title
  await card('<div class="mk">ك</div><h1>كويزي</h1><p>ذاكر من محاضرتك نفسها:<br>كويز ذكي من ملفك في دقائق</p>'); await wait(p, 3300);
  await card(null); await wait(p, 500);
  // 1) upload
  await cap('١', 'ارفع محاضرتك', 'ملف PDF أو باوربوينت كما أعطاك إياه الدكتور'); await wait(p, 1800);
  const up = p.locator('button:has-text("رفع ملف")').first(); const bb = await up.boundingBox(); if (bb) await p.evaluate(([x, y]) => window.__tap(x, y), [bb.x + bb.width / 2, bb.y + bb.height / 2]); await wait(p, 400);
  await p.setInputFiles('#file', pdf); await p.waitForSelector('tbody tr a.fquiz', { timeout: 30000 }); await p.waitForFunction(() => !/قيد القراءة/.test(document.body.textContent), null, { timeout: 30000 }); await wait(p, 1500);
  // 2) a quiz
  await cap('٢', 'اختر عدد الأسئلة واضغط «إنشاء الكويز»', 'ابدأ بـ ٢٠–٣٠ سؤالًا للمحاضرة الواحدة'); await tap('tbody tr a.fquiz'); await p.waitForSelector('#create-quiz'); await wait(p, 1600);
  await tap('.chips button:text-is("10")'); await wait(p, 900); await tap('#create-quiz');
  await cap('٢', 'كلود يقرأ محاضرتك ويكتب الأسئلة ويراجعها', 'أبقِ الصفحة مفتوحة حتى يجهز الكويز'); await p.waitForSelector('h2:has-text("جاهز للحل")', { timeout: 180000 }); await wait(p, 1600);
  // 3) practice
  await cap('٣', 'ابدأ الحل في وضع التدريب', 'يصحّح لك فورًا بعد كل إجابة'); await wait(p, 1200); await tap('button:has-text("ابدأ الحل")'); await wait(p, 900); await tap('.modal button:has-text("ابدأ")'); await p.waitForSelector('.stem'); await wait(p, 1500);
  // a right answer: the explanation and the line from the lecture
  const keyOf = (stem) => ({ 'Closure of which valves produces the second heart sound (S2)?': 'Semilunar valves' })[stem];
  let stem = (await p.textContent('.stem')).trim(); const right = await p.evaluate(async () => { const id = (location.hash.match(/attempt\/(\w+)/) || [])[1]; const a = await (await fetch('/api/attempts/' + id)).json(); return a; }).catch(() => null);
  await cap('٣', 'كل سؤال معه السطر الذي أُخذ منه من محاضرتك');
  // pick the right option of the first question by trying them in order of the bank's key (the first option written is the key)
  const opts = await p.locator('.opt').allTextContents(); const known = ['Systole', 'All four heart valves', 'Aortic pressure', 'Semilunar valves', 'Atrioventricular valves', 'End-systolic volume', 'End-diastolic volume', 'Stroke volume', 'It decreases heart rate', 'Myocardial contractility'];
  let k = opts.findIndex((o) => known.some((x) => o.includes(x))); if (k < 0) k = 0; await tap(`.opt >> nth=${k}`); await p.waitForSelector('.explain'); await wait(p, 600);
  await p.locator('.evidence').first().scrollIntoViewIfNeeded(); await wait(p, 3200);
  // to the question on the second heart sound, answered wrongly
  const all = await p.evaluate(async () => { const id = (location.hash.match(/attempt\/(\w+)/) || [])[1]; const a = await (await fetch('/api/attempts/' + id)).json(); return (a.questions || []).map((q) => q.stem); });
  if (process.env.PROMO_DEBUG) { console.log('stems', JSON.stringify(all)); const rep = await p.evaluate(async () => { const r = await (await fetch('/api/quizzes')).json(); const q = await (await fetch('/api/quizzes/' + (r[0] || r.items[0]).id)).json(); return JSON.stringify((q.report || {}).dropped || q.report || q).slice(0, 1500); }).catch((e) => String(e)); console.log('dropped', rep); }
  const target = all.findIndex((x) => /S2/.test(x)); if (target < 0) throw new Error('no S2 question in the quiz');
  for (let i = 0; i < 20 && !/S2/.test(stem); i++) { await p.locator('button:has-text("التالي")').first().click(); await wait(p, 350); stem = (await p.textContent('.stem')).trim(); }
  await cap('٤', 'أخطأت؟ التصحيح الذكي يشرح لك السبب', 'يشخّص خطأك نفسه، لا يكتفي بالجواب الصحيح'); await wait(p, 1400);
  await tap('.opt:has-text("Atrioventricular valves")'); await p.waitForSelector('.fix'); await p.waitForFunction(() => /الصواب/.test((document.querySelector('.fx-ar') || {}).textContent || ''), null, { timeout: 20000 });
  await p.locator('.fix').scrollIntoViewIfNeeded(); await wait(p, 5200);
  // the tutor
  await p.locator('.tutor').scrollIntoViewIfNeeded(); await cap('٥', 'اسأل المعلّم عن أي شيء في السؤال', 'يجيبك من محاضرتك فقط'); await wait(p, 1500);
  await tap('.tutor button:has-text("ليش اختياري غلط؟")'); await p.waitForSelector('.tutor .tb.ai:not(.wait)', { timeout: 20000 }); await p.locator('.tutor .tb.ai:not(.wait)').last().scrollIntoViewIfNeeded(); await wait(p, 4600);
  await tap('.tutor .tin'); await p.type('.tutor .tin', 'اشرحها أبسط', { delay: 110 }); await wait(p, 400); await tap('.tutor button:has-text("أرسل")');
  await p.waitForFunction(() => document.querySelectorAll('.tutor .tb.ai:not(.wait)').length >= 2, null, { timeout: 20000 }); await p.locator('.tutor .tb.ai:not(.wait)').last().scrollIntoViewIfNeeded(); await wait(p, 4600);
  // a similar question
  await cap('٦', 'تأكّد من فهمك بسؤال مشابه', 'سؤال جديد على الفكرة نفسها يُحل في مكانه'); await tap('.tutor button:has-text("سؤال مشابه أتأكد فيه")'); await p.waitForSelector('.tutor .sim', { timeout: 20000 });
  await p.locator('.tutor .sim').scrollIntoViewIfNeeded(); await wait(p, 1800); await tap('.tutor .sim .sim-opt:has-text("The second heart sound")'); await p.waitForSelector('.tutor .sim .sim-ok'); await p.locator('.tutor .sim .sim-ok').scrollIntoViewIfNeeded(); await wait(p, 3400);
  await cap(null, null);
  // tips
  await card('<h1 style="font-size:34px">أفضل طريقة للاستخدام</h1><ul>'
    + '<li>ارفع ملف المحاضرة نفسه، والأفضل أن يكون نصه قابلًا للنسخ لا صورًا</li>'
    + '<li>اطلب <span class="hl">٢٠–٣٠ سؤالًا</span> للمحاضرة الواحدة</li>'
    + '<li>ابدأ بوضع <span class="hl">التدريب</span>، ثم اختبر نفسك بوضع الاختبار</li>'
    + '<li>عند كل خطأ: اقرأ التصحيح، واسأل المعلّم، وحلّ سؤالًا مشابهًا</li>'
    + '<li>أبقِ الصفحة مفتوحة حتى يجهز الكويز</li></ul>'); await wait(p, 9000);
  await card('<div class="mk">ك</div><h1>كويزي</h1><p>محاضرتك… صارت كويزًا يعلّمك</p><p style="margin-top:14px;font-size:17px;opacity:.85">أخوكم سعد مقبل</p>'); await wait(p, 3200);
  const video = p.video(); await ctx.close(); const file = await video.path(); await b.close(); srv.close();
  fs.writeFileSync(path.join(outDir, 'trim.txt'), String(Math.max(0, startAt - 0.1))); console.log('video', file, 'trim', startAt.toFixed(2));
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
