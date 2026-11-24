// node claude-edition/test/run_explain_split.js <dist> — THE LECTURE EXPLAINED ON A SPLIT SCREEN (Chromium, Claude simulated by shim.js):
// the layout follows the width the page really has, not the window's:
//  1) a wide page: the slide and its explanation side by side, each scrolling on its own (as before)
//  2) a narrow page - half a laptop screen with the side menu, an iPad split, a phone, a third of a screen: one column; the slide pinned on top
//     (just under the top bar when there is one), its picture whole in sight, its explanation starting right under it, no sideways scroll
//  3) reading down the explanation: the slide stays in sight at the same fixed size (no folding, nothing moves), the explanation keeps more than half
//     the screen; a point lights its line on the picture, in sight in the pinned box
//  4) nothing lost: the slide's text is still there under its picture (scrolled inside the pinned box), a phrase selected on it gets «اشرح هذا»;
//     a line lit in the text (no picture to light) is brought into view inside the box
//  5) a very short window (a phone on its side): the slide is not pinned, so the explanation has room
const { chromium } = require('playwright'); const http = require('http'), fs = require('fs'), path = require('path'); const assert = require('assert');
const dist = process.argv[2]; const PDF = path.join(dist, 'corpus', 'cardiac.pdf');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2', '.pdf': 'application/pdf' };
const srv = http.createServer((q, r) => { let f = path.join(dist, decodeURIComponent(q.url.split('?')[0])); if (f.endsWith('/')) f += 'index.html'; fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); r.end(); } else { r.writeHead(200, { 'Content-Type': mime[path.extname(f)] || 'application/octet-stream' }); r.end(d); } }); });

const state = (p) => p.evaluate(() => { const g = document.querySelector('.xgrid'), s = document.querySelector('.xslide'), e = document.querySelector('.xexp'), top = document.getElementById('top');
  const rs = s.getBoundingClientRect(), re = e.getBoundingClientRect(), im = s.querySelector('.ximg img'), ri = im ? im.getBoundingClientRect() : null, rt = top.getBoundingClientRect();
  return { cols: getComputedStyle(g).gridTemplateColumns.split(' ').length, pos: getComputedStyle(s).position, ovS: getComputedStyle(s).overflowY, ovE: getComputedStyle(e).overflowY,
    slideTop: rs.top, slideBottom: rs.bottom, slideH: rs.height, expTop: re.top, expDocTop: re.top + scrollY, imgTop: ri && ri.top, imgBottom: ri && ri.bottom, imgH: ri && ri.height,
    bar: getComputedStyle(top).position === 'sticky' && rt.height < innerHeight / 2 ? rt.bottom : 0, xtop: getComputedStyle(document.querySelector('.xpl')).getPropertyValue('--xtop').trim(),
    sideways: document.documentElement.scrollWidth > innerWidth + 1, lines: s.querySelectorAll('[data-line]').length, H: innerHeight, sy: scrollY }; });

(async () => {
  srv.listen(8815); const b = await chromium.launch(); const errs = [];
  const ctx = await b.newContext({ viewport: { width: 1280, height: 860 } }); await ctx.addInitScript({ path: path.join(__dirname, 'shim.js') });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('http://localhost:8815/#/files'); await p.waitForSelector('#file', { state: 'attached', timeout: 20000 });
  await p.setInputFiles('#file', PDF); await p.waitForSelector('tbody tr a.fexplain', { timeout: 30000 });
  await p.click('tbody tr a[href^="#/files/"]'); await p.click('#explain-lecture'); await p.waitForSelector('.xidea', { timeout: 20000 }); await p.waitForSelector('.xready.all', { timeout: 30000 });
  await p.waitForFunction(() => { const im = document.querySelector('.ximg img'); return im && im.complete && im.naturalWidth > 0; }, null, { timeout: 15000 });

  // 1) wide
  let st = await state(p); assert.strictEqual(st.cols, 2, '1) side by side'); assert.strictEqual(st.ovS + '/' + st.ovE, 'auto/auto', '1) each column scrolls on its own');
  console.log('1) a wide page: the slide and its explanation side by side, each scrolling on its own');

  // 2) + 3) narrow pages
  for (const [w, h, what] of [[1024, 760, 'half a laptop screen with the side menu'], [768, 900, 'an iPad split'], [600, 800, 'a narrow window'], [430, 860, 'a phone'], [375, 667, 'a small phone / a third of a screen']]) {
    await p.setViewportSize({ width: w, height: h }); await p.evaluate(() => scrollTo(0, 0)); await p.waitForTimeout(500);
    st = await state(p);
    assert.strictEqual(st.cols, 1, `2) ${w}px: one column`); assert.strictEqual(st.pos, 'sticky', `2) ${w}px: the slide is pinned`); assert(!st.sideways, `2) ${w}px: no sideways scroll`);
    assert(st.expTop >= st.slideBottom - 1 && st.expDocTop - (st.slideBottom + st.sy) < 30, `2) ${w}px: the explanation starts right under the slide`);
    assert(st.slideH <= st.imgH + 1.2 * 16 + 6, `2) ${w}px: the pinned box is exactly as tall as its picture (${Math.round(st.slideH)}px for a ${Math.round(st.imgH)}px picture)`);
    // one fixed, balanced size: the page's full width, at most about a third of the window's height (340px)
    const big = await p.evaluate(() => { const im = document.querySelector('.ximg img'), box = document.querySelector('.ximg'); const r = im.getBoundingClientRect(); const cap = Math.min(340, 0.36 * innerHeight);
      return { w: r.width, h: r.height, boxW: box.clientWidth, cap, ok: r.height <= cap + 1 && (r.width >= box.clientWidth - 2 || r.height >= cap - 2) }; });
    assert(big.ok, `2) ${w}px: the picture at its fixed size (${Math.round(big.w)}x${Math.round(big.h)} in ${big.boxW}, cap ${Math.round(big.cap)})`);
    assert(st.imgH > 60 && st.imgBottom <= st.slideBottom + 1, `2) ${w}px: the slide's picture whole in sight (${Math.round(st.imgH)}px)`);
    assert.strictEqual(st.xtop, Math.round(st.bar) + 'px', `2) ${w}px: pinned under the top bar (${st.xtop} / ${st.bar})`);
    // 3) read down the explanation: the slide stays where it is pinned, at the same size; the explanation keeps more than half the screen
    await p.evaluate(() => scrollTo(0, document.querySelector('.xexp').getBoundingClientRect().top + scrollY - 40)); await p.waitForTimeout(500);
    const pinned = await state(p); assert(Math.abs(pinned.slideTop - pinned.bar) <= 1, `3) ${w}px: the slide stays in sight while reading (${pinned.slideTop} vs ${pinned.bar})`);
    assert(Math.abs(pinned.slideH - st.slideH) <= 1 && Math.abs(pinned.expDocTop - st.expDocTop) <= 1, `3) ${w}px: same size while reading, nothing moves (${Math.round(pinned.slideH)} vs ${Math.round(st.slideH)})`);
    const room = h - pinned.slideBottom; assert(room >= 0.5 * h, `3) ${w}px: the explanation keeps more than half the screen (${Math.round(room)} of ${h})`);
    await p.evaluate(() => { const li = document.querySelectorAll('.xpoints li')[1]; for (const t of ['pointerover', 'mouseover', 'mouseenter', 'pointerenter']) li.dispatchEvent(new MouseEvent(t, { bubbles: t.endsWith('over') })); });
    await p.waitForSelector('.ximg .xhl', { timeout: 5000 }); await p.waitForTimeout(600);
    const litIn = await p.evaluate(() => { const s = document.querySelector('.xslide'), el = s.querySelector('.xhl'); const a = s.getBoundingClientRect(), r = el.getBoundingClientRect(); return r.bottom > a.top && r.top < a.bottom; });
    assert(litIn, `3) ${w}px: the lit line is in sight in the pinned box`);
    if (process.env.QZ_SHOT) await p.screenshot({ path: `${process.env.QZ_SHOT}-${w}.png` });
    await p.evaluate(() => { const li = document.querySelectorAll('.xpoints li')[1]; for (const t of ['pointerout', 'mouseout', 'mouseleave', 'pointerleave']) li.dispatchEvent(new MouseEvent(t, { bubbles: t.endsWith('out') })); });
    console.log(`2-3) ${w}x${h} (${what}): one column, the slide pinned ${pinned.bar ? 'under the top bar' : 'on top'} (${Math.round(st.slideH)}px, picture ${Math.round(st.imgH)}px high), its picture whole, the explanation right under it; the same size while reading, the explanation keeps ${Math.round(100 * room / h)}% of the screen, a point lights its line`);
  }

  // 4) nothing lost on a narrow page: the slide's text under its picture, select-and-ask, a lit text line brought into view
  await p.setViewportSize({ width: 430, height: 860 }); await p.evaluate(() => scrollTo(0, 0)); await p.waitForTimeout(400);
  st = await state(p); assert(st.lines >= 3, '4) the slide\'s text is still there: ' + st.lines);
  const inBox = await p.evaluate(() => { const s = document.querySelector('.xslide'); s.scrollTop = s.scrollHeight; const el = s.querySelector('.xlines p:last-child'); const a = s.getBoundingClientRect(), r = el.getBoundingClientRect(); return r.top >= a.top - 1 && r.bottom <= a.bottom + 1; });
  assert(inBox, '4) the text is reached by scrolling inside the pinned box');
  await p.evaluate(() => { const el = document.querySelector('.xslide .xlines p'); el.scrollIntoView({ block: 'nearest' }); const t = el.firstChild; const r = document.createRange(); r.setStart(t, 0); r.setEnd(t, Math.min(t.length, 24));
    const s = getSelection(); s.removeAllRanges(); s.addRange(r); el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); });
  await p.waitForSelector('.xpop:not([hidden])', { timeout: 5000 }); await p.click('.xpop'); await p.waitForSelector('.xask .tb.ai:not(.wait)', { timeout: 10000 });
  // a line lit in the text (the picture cannot show it): brought into view inside the box
  await p.evaluate(() => { const s = document.querySelector('.xslide'); s.scrollTop = 0; document.querySelector('.ximg').hidden = true; });
  await p.evaluate(() => { const li = [...document.querySelectorAll('.xpoints li')].pop(); for (const t of ['pointerover', 'mouseover', 'mouseenter', 'pointerenter']) li.dispatchEvent(new MouseEvent(t, { bubbles: t.endsWith('over') })); });
  await p.waitForSelector('.xslide .lit', { timeout: 5000 }); await p.waitForTimeout(700);
  const litSeen = await p.evaluate(() => { const s = document.querySelector('.xslide'), el = s.querySelector('.lit'); const a = s.getBoundingClientRect(), r = el.getBoundingClientRect(); return r.bottom > a.top && r.top < a.bottom; });
  assert(litSeen, '4) the lit line of the text is brought into view inside the pinned box');
  await p.evaluate(() => { document.querySelector('.ximg').hidden = false; });
  console.log('4) nothing lost: the slide\'s text is under its picture (scrolled inside the pinned box), «اشرح هذا» on a selected phrase is answered, a lit text line comes into view');

  // 5) a very short window
  await p.setViewportSize({ width: 740, height: 400 }); await p.evaluate(() => scrollTo(0, 0)); await p.waitForTimeout(400);
  st = await state(p); assert.strictEqual(st.cols, 1); assert.strictEqual(st.pos, 'static', '5) not pinned on a very short window'); assert(!st.sideways);
  console.log('5) a very short window (a phone on its side): the slide is not pinned, the explanation has room');

  // back to wide: as it was
  await p.setViewportSize({ width: 1280, height: 860 }); await p.waitForTimeout(400); st = await state(p);
  assert.strictEqual(st.cols, 2); assert.strictEqual(st.ovS + '/' + st.ovE, 'auto/auto'); assert.strictEqual(st.xtop, '0px', 'no top bar on a wide page');
  assert.deepStrictEqual(errs, []); await b.close(); srv.close(); console.log('explain split-screen ok');
})().catch((e) => { console.error(e); process.exit(1); });
