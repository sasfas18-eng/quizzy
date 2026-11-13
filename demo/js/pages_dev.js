// THE DEVELOPMENT TRACK (#/dev, the owner's only): the question forms learn from many quizzes. The page shows how far each of the ten types x four fixed
// forms x three kinds of lecture (heavy, medium, light) has learned, and runs the track step after step - each step one round of the owner's Claude on one
// study file of the corpus shipped with the app - until it is ready, or the owner stops it. Nothing here is shown to students.
import { h, api, fill, toast, num, keepOpen, TYPE_AR } from './core.js?v=a6963eb548';
import { onLeave } from './main.js?v=a6963eb548';

const DENS_AR = { heavy: 'ثقيلة', medium: 'متوسطة', light: 'خفيفة' };
const FAM_AR = { giveaway: 'السؤال يكشف الإجابة', options_same: 'خياران بمعنى واحد', options_meta: 'خيار عن السؤال لا عن المادة', options_weak: 'مشتتات ضعيفة', ambiguous: 'أكثر من إجابة أو غير محسوم',
  evidence: 'الدليل من المصدر', negation: 'صيغة النفي', order: 'الترتيب', repeat: 'يكرر سؤالًا آخر', format: 'شكل السؤال', unfit: 'لا تناسب مادة الصفحات', other: 'أخرى' };
const STATUS_AR = { new: 'لم تُجرَّب', learning: 'تتعلم', learned: 'تعلّمت', settled: 'استقرت', unfit: 'لا تناسب هذا النوع' };

export async function devPage() {
  const root = h('div', { class: 'devtrack' });
  let s = null, running = false, stopAsked = false, left = false, err = null, publishing = false, corpusOpen = false;      // corpusOpen: the folded study-files part stays as the owner left it
  let wake = null; const keepAwake = async (on) => { try { if (on && !wake && navigator.wakeLock && document.visibilityState === 'visible') wake = await navigator.wakeLock.request('screen'); else if (!on && wake) { await wake.release(); wake = null; } } catch (_) { /* not offered */ } };
  onLeave(() => { left = true; stopAsked = true; keepAwake(false); });
  try { s = await api('GET', '/api/dev'); } catch (e) { if (e.status === 403) return h('div', { class: 'card' }, h('h1', {}, 'مسار التطوير'), h('p', { class: 'muted' }, e.message)); throw e; }

  async function run() {
    running = true; stopAsked = false; err = null; draw(); keepAwake(true);
    try {
      while (!stopAsked && !s.ready) {
        const r = await keepOpen(api('POST', '/api/dev/step')); s = r.status; if (left) return; draw();
        if (r.done === 'max_steps') { toast('بلغ المسار حدّه الأعلى من الخطوات.'); break; }
        if (r.done === 'ready' || s.ready) { toast('اكتمل مسار التطوير: تعلّمت الصيغ كل ما يمكن تعلّمه من هذه الملفات.', 'ok'); break; }
        if (r.quota) { err = 'نفدت حصة Claude في حسابك الآن. تابع لاحقًا من حيث توقف المسار (التقدم محفوظ).'; break; }
      }
    } catch (e) { err = e.message || String(e); }
    finally { running = false; keepAwake(false); if (!left) draw(); }
  }

  async function publish() {      // what the owner's quizzes taught the forms reaches every student's next quiz
    publishing = true; err = null; draw();
    try { const r = await api('POST', '/api/dev/publish'); s = r.status; toast('وصل التحديث: كويزات كل الطلاب تبدأ الآن بما تعلّمته الصيغ.', 'ok'); }
    catch (e) { err = e.message || String(e); }
    finally { publishing = false; if (!left) draw(); } }

  function cellBox(c) {
    if (!c) return h('span', { class: 'fbox none' }, '·');
    const rate = c.n ? c.ok / c.n : 0; const cls = c.status === 'unfit' ? 'unfit' : c.status === 'new' ? 'new' : c.status === 'learning' ? 'learning' : rate >= 0.6 ? 'good' : 'weak';
    const why = c.top ? ` — أكثر ما تتعثر فيه: ${FAM_AR[c.top.fam] || c.top.fam} (${num(c.top.n)})` : '';
    return h('span', { class: 'fbox ' + cls + (c.tip ? ' tip' : ''), title: `الصيغة ${num(c.form + 1)}: ${s.forms[c.type][c.form]}\n${STATUS_AR[c.status]}: نجحت ${num(c.ok)} من ${num(c.n)}${why}${c.tip ? '\nيُرفق بها تذكير بالقاعدة التي تتعثر فيها' : ''}` }, `${c.ok}/${c.n}`);
  }

  function draw() {
    const by = {}; s.cells.forEach((c) => { by[`${c.type}|${c.form}|${c.dens}`] = c; });
    const reach = {}; s.cells.forEach((c) => { (reach[c.dens] ||= new Set()).add(c.type); });
    const when = (t) => (t ? new Date(t * 1000).toLocaleString('ar-u-nu-latn', { dateStyle: 'medium', timeStyle: 'short' }) : '');
    fill(root,
      h('h1', {}, 'مسار التطوير — صيغ الأسئلة'),
      h('p', { class: 'muted' }, 'كل كويز تنشئه يعلّم كويزي أيّ صيغة من صيغ الأقسام العشرة تنجح في كل نوع من المحاضرات (ثقيلة ومتوسطة وخفيفة) ولماذا تتعثر غيرها. لا يضيف صيغًا ولا يغيّر قواعد الخيارات: يختار بين الصيغ الأربع الثابتة لكل قسم، ويذكّر Claude بالقاعدة التي تتعثر فيها الصيغة. هذه الصفحة لك وحدك.'),
      // 1) what the quizzes taught, and sharing it with every student
      h('div', { class: 'card', id: 'dev-learn' },
        h('h2', {}, 'التعلّم من الكويزات'),
        h('div', { class: 'row between' }, h('div', {}, h('div', { class: 'stat', id: 'dev-pct' }, num(s.pct) + '%'), h('div', { class: 'stat-l' }, s.ready ? 'جاهز: تعلّمت الصيغ كل الفرص الممكنة' : 'نسبة ما تعلّمته الصيغ')),
          s.can_share ? h('button', { class: 'btn primary', id: 'dev-publish', disabled: !s.quizzes || publishing, onclick: () => publish() }, publishing ? 'يُحدَّث…' : 'حدّث الصيغ لكل الطلاب') : null),
        h('div', { class: 'progress', style: 'margin:.8rem 0' }, h('div', { style: `width:${Math.max(2, s.pct)}%` })),
        h('p', { class: 'small muted' }, `تعلّمت من ${num(s.quizzes)} كويز: ${num(s.learned)} من ${num(s.need)} خانة (القسم × الصيغة × نوع المحاضرة)، كل خانة بعد ${num(s.limits.ready)} محاولات أولى وتستقر عند ${num(s.limits.max)}.`),
        h('p', { class: 'small', id: 'dev-shared' }, s.shared ? `آخر تحديث وصل للطلاب: ${when(s.shared.updated_at)} (من ${num(s.shared.quizzes)} كويز).` : 'لم يصل للطلاب تحديث بعد: اضغط «حدّث» متى شئت، فتبدأ كويزاتهم كلها بما تعلّمته الصيغ.'),
        h('p', { class: 'small muted' }, 'طلاب الرابط لا يتيح لهم claude.ai أن يرسلوا نتائجهم إليك (الرابط للقراءة فقط)، فالتعلّم الذي تشاركه يأتي من كويزاتك أنت؛ وكويزات كل طالب تعلّم جهازه هو أيضًا.'),
        err && h('div', { class: 'alert warn', role: 'alert', style: 'margin-top:.6rem' }, err)),
      // 2) the ten types x four forms x three kinds of lecture
      h('div', { class: 'card tablewrap' }, h('h2', {}, 'الأقسام العشرة'),
        h('p', { class: 'small muted' }, 'لكل قسم أربع صيغ ثابتة؛ كل مربع: نجحت/جُرّبت. أخضر تنجح غالبًا، أصفر تتعثر، أحمر لا تناسب هذا النوع من المحاضرات، والخط تحت المربع: يُرفق بها تذكير بالقاعدة.'),
        h('table', { class: 'fgrid' }, h('thead', {}, h('tr', {}, h('th', {}, 'القسم'), ...['heavy', 'medium', 'light'].map((d) => h('th', {}, 'محاضرة ' + DENS_AR[d])))),
          h('tbody', {}, ...Object.keys(s.types).map((t) => h('tr', {}, h('td', {}, TYPE_AR[t] || s.types[t]),
            ...['heavy', 'medium', 'light'].map((d) => h('td', {}, reach[d] && reach[d].has(t) ? h('div', { class: 'fcell' }, ...[0, 1, 2, 3].map((i) => cellBox(by[`${t}|${i}|${d}`]))) : h('span', { class: 'muted small' }, '—')))))))),
      // 3) optional: speed the learning up on the study files shipped with the app (it uses the owner's quota)
      h('details', { class: 'card', id: 'dev-corpus', open: corpusOpen || running || undefined, ontoggle: (e) => { corpusOpen = e.target.open; } },
        h('summary', {}, h('strong', {}, 'تسريع التعلّم بالملفات الدراسية'), h('span', { class: 'small muted' }, ' — اختياري، ويستهلك من حصة Claude في حسابك')),
        h('div', { class: 'row between', style: 'margin-top:.8rem' }, h('div', { class: 'small muted' }, `الخطوات ${num(s.steps)} من ${num(s.max_steps)}`, s.unread ? ` · ملفات لم تُقرأ بعد ${num(s.unread)}` : ''),
          s.ready ? h('span', { class: 'badge ok', id: 'dev-ready' }, 'جاهز') : running ? h('button', { class: 'btn', id: 'dev-stop', onclick: () => { stopAsked = true; draw(); } }, stopAsked ? 'يتوقف بعد هذه الخطوة…' : 'أوقف')
            : h('button', { class: 'btn', id: 'dev-run', onclick: () => run() }, s.steps ? 'تابع' : 'ابدأ')),
        running && h('div', { class: 'row', role: 'status', style: 'margin-top:.6rem' }, h('span', { class: 'spin' }), h('span', { class: 'muted' }, 'خطوة جارية: يقرأ Claude ملفًا ويكتب أسئلته ويفحصها… أبقِ الصفحة مفتوحة.')),
        h('ul', { class: 'devfiles', style: 'margin-top:.8rem' }, ...s.corpus.map((l) => h('li', {}, h('span', { class: 'bidi' }, l.title), ' ', h('span', { class: 'badge' }, 'محاضرة ' + (DENS_AR[l.dens || l.density] || l.density)), ' ',
          h('span', { class: 'small muted' }, l.read ? `جولات ${num(l.runs)} · ${num(l.types.length)} أقسام تدعمها` : 'لم تُقرأ بعد')))),
        s.log.length ? h('ul', { class: 'small' }, ...s.log.map((x) => { const l = s.corpus.find((c) => c.id === x.lecture);
          return h('li', {}, `${l ? l.title : x.lecture} (${DENS_AR[x.dens] || x.dens}): نجحت ${num(x.ok)} من ${num(x.first)} صيغة كما اقتُرحت · ${num(Math.round(x.ms / 1000))} ث`); })) : null));
  }
  draw();
  return root;
}
