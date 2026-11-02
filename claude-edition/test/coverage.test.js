// node claude-edition/test/coverage.test.js — the WHOLE lecture is asked about: every slide that carries content gets a question once the count allows it,
// including the shapes slides really have (an outline list «• Physical Assessment / ◦ Inspection …», a numbered list under a lead, a numbered heading over items,
// «Title / Is the science of …», a topic continued over several slides); and a list continued over slides is never asked as complete («which is NOT listed»).
global.window = {}; require('../engine.js'); require('../rules.js'); const E = window.QZE, R = E.rules; const assert = require('assert');
const mk = (arr) => arr.map((t, i) => ({ ref: 'd1p' + (i + 1), text: t, doc_id: 'd', page_no: i + 1 }));
const pages = mk([
  'Assessment Techniques\n• Physical Assessment\n◦ Inspection\n◦ Palpation\n◦ Auscultation\n◦ Percussion',
  'Uses of Documentation Forms\nKardex\nMedication administration record\nFlow sheets and checklists\nCare plans',
  'Uses of Documentation Forms (continued_1)\nIncident report\nDocument out-of-the-ordinary\nBe objective\nInclude incident and action taken',
  'Cholinergic Neurons\nThe neurons that are cholinergic\n(1) all preganglionic neurons,\n(2) all parasympathetic postganglionic neurons,\n(3) sympathetic postganglionic neurons that innervate sweat glands, and',
  'Microbial Genetics\nIs the science of heredity; includes the study of genes and how they are expressed.',
  'Breaking the Chain\n4. Mode of transmission\nHand hygiene\nPersonal protective equipment\nFood safety\nCleaning and disinfection',
  'Oxygen Requirements\nObligate aerobes require oxygen to live.\nFacultative anaerobes can grow with or without oxygen.\nMicroaerophiles require low oxygen concentrations to grow.',
  'Temperature Classes\nPsychrophiles grow best at cold temperatures below fifteen degrees.\nMesophiles grow best at moderate temperatures near body temperature.\nThermophiles grow best at high temperatures above forty five degrees.',
  'Key Terms\nGenotype: the genetic makeup of an organism carried in its DNA.\nPhenotype: the observable characteristics of an organism such as colour.\nMutation: a permanent change in the base sequence of the DNA.']);
const st = (n) => ({ count: n, focus: 'balanced', field: 'health', difficulty: 'mixed', language: 'source', external_mode: 'source_only' });
(async () => {
  // 1) the shapes are read
  const m = R.mine(pages); const L = (lead) => m.lists.find((l) => l.lead === lead);
  assert(L('Physical Assessment') && L('Physical Assessment').items.join('|') === 'Inspection|Palpation|Auscultation|Percussion', 'outline list: ' + JSON.stringify(m.lists.map((l) => l.lead)));
  assert(!m.lists.some((l) => l.items.includes('Physical Assessment')), 'no list mixing the two outline levels');
  const ch = L('The neurons that are cholinergic'); assert(ch && ch.items.length === 3 && ch.items.every((it) => !/,?\s*and$/.test(it)), 'numbered items under a lead: ' + JSON.stringify(ch));
  assert(L('Mode of transmission') && L('Mode of transmission').items.length === 4, 'a numbered heading over plain items');
  assert(L('Incident report') && L('Incident report').partial, 'a list on a continued slide is incomplete'); assert(m.lists.filter((l) => l.topic === L('Incident report').topic).every((l) => l.partial), 'all parts of a continued topic are incomplete');
  assert(m.defs.some((d) => d.term === 'Microbial Genetics' && /science of heredity/.test(d.tail)), '«Title / Is the science of …» is a definition');
  console.log('1) outline list, numbered list, numbered heading, continued topic, «Title / Is …» definition: all read');

  // 2) with as many questions as slides, every slide is asked about; with fewer, every TOPIC first
  const gen = async (n) => (await R.generate(E.buildPlan(R.analyse(pages), st(n), E.support(pages.map((p) => p.text), 'health')), pages, st(n), () => {})).accepted;
  const q = await gen(18); const per = {}; q.forEach((c) => new Set(c.evidence.map((e) => e.page)).forEach((p) => { per[p] = (per[p] || 0) + 1; }));
  const missed = pages.filter((p) => !per[p.ref]).map((p) => p.ref); console.log(`2) 18 questions over 9 slides: ${9 - missed.length}/9 slides asked about`, JSON.stringify(per));
  assert.deepStrictEqual(missed, [], 'every slide gets a question');
  const q7 = await gen(8); const topics = new Set(q7.flatMap((c) => c.evidence.map((e) => (pages.find((p) => p.ref === e.page).text.split('\n')[0]).replace(/\s*\(cont[^)]*\)$/, ''))));
  assert(topics.size >= 7, '8 questions reach at least 7 of the 8 topics: ' + topics.size); console.log(`   8 questions reach ${topics.size} of 8 topics`);

  // 3) never «which is NOT listed» / «which set» from an incomplete list; wrong options never from the rest of its topic
  const bad = q.filter((c) => ['listNot', 'setOf'].includes(c.form) && c.evidence.some((e) => ['d1p2', 'd1p3'].includes(e.page)));
  assert.deepStrictEqual(bad.map((c) => c.stem), [], 'no NOT-listed / set question from a continued list');
  q.filter((c) => c.form === 'listBelongs' && c.evidence.some((e) => ['d1p2', 'd1p3'].includes(e.page))).forEach((c) => {
    const topicText = E.norm(pages[1].text + ' ' + pages[2].text); c.options.filter((_, i) => i !== c.correct_index).forEach((o) => assert(!topicText.includes(E.norm(o)), 'a wrong option is not from the same topic: ' + o)); });
  console.log('3) continued lists: no «NOT listed», wrong options from other topics');
  console.log('coverage tests ok');
})().catch((e) => { console.error(e); process.exit(1); });
