/* The simulated Claude of the intro video (loaded after claude-edition/test/shim.js): questions written the way a good model writes them, every one quoting its slide
 * of the sample lecture (tools/promo/make_lecture.py) word for word; the reviewer agrees with the key; the smart correction, the tutor and the similar question of
 * the question the video gets wrong (the second heart sound) are written out in full. Everything else is left to the shim. */
(() => {
  const BANK = {
    2: [
      ['Which phase of the cardiac cycle is defined as ventricular contraction?', ['Systole', 'Diastole', 'Atrial diastole', 'Rapid filling'], 'Systole is the phase of ventricular contraction, and diastole is the phase of ventricular relaxation.', 'The lecture defines systole as the phase of ventricular contraction.'],
      ['During isovolumetric contraction, which valves are closed?', ['All four heart valves', 'Only the atrioventricular valves', 'Only the semilunar valves', 'Only the aortic valve'], 'During isovolumetric contraction, all four heart valves are closed and ventricular pressure rises rapidly.', 'In isovolumetric contraction all four valves are closed while ventricular pressure rises.'],
      ['Ventricular ejection begins when ventricular pressure exceeds which pressure?', ['Aortic pressure', 'Atrial pressure', 'Venous pressure', 'Pleural pressure'], 'Ventricular ejection begins when ventricular pressure exceeds aortic pressure and the semilunar valves open.', 'Ejection starts once ventricular pressure is higher than aortic pressure, opening the semilunar valves.'],
    ],
    3: [
      ['Closure of which valves produces the second heart sound (S2)?', ['Semilunar valves', 'Atrioventricular valves', 'Venous valves', 'Coronary valves'], 'The second heart sound (S2) is produced by closure of the semilunar valves.', 'The lecture states that S2 is produced by closure of the semilunar valves.'],
      ['In which direction do the atrioventricular valves prevent backflow of blood?', ['From the ventricles into the atria', 'From the arteries into the ventricles', 'From the atria into the veins', 'From the aorta into the lungs'], 'The atrioventricular valves prevent backflow of blood from the ventricles into the atria.', 'The AV valves stop blood flowing back from the ventricles into the atria.'],
    ],
    4: [
      ['Which volume is the blood remaining in each ventricle after ejection?', ['End-systolic volume', 'End-diastolic volume', 'Stroke volume', 'Cardiac output'], 'End-systolic volume is the volume of blood remaining in each ventricle after ejection.', 'The blood left in the ventricle after ejection is the end-systolic volume.'],
      ['Stroke volume equals end-diastolic volume minus which volume?', ['End-systolic volume', 'Cardiac output', 'Ejection fraction', 'Atrial volume'], 'Stroke volume equals end-diastolic volume minus end-systolic volume.', 'Stroke volume is end-diastolic volume minus end-systolic volume.'],
      ['Ejection fraction is the stroke volume divided by which volume?', ['End-diastolic volume', 'End-systolic volume', 'Cardiac output', 'Atrial volume'], 'Ejection fraction is the stroke volume divided by the end-diastolic volume.', 'The lecture defines ejection fraction as stroke volume divided by end-diastolic volume.'],
    ],
    5: [
      ['Cardiac output equals heart rate multiplied by which quantity?', ['Stroke volume', 'Ejection fraction', 'End-systolic volume', 'Arterial pressure'], 'Cardiac output equals heart rate multiplied by stroke volume.', 'Cardiac output is heart rate multiplied by stroke volume.'],
      ['What is the effect of parasympathetic stimulation through the vagus nerve?', ['It decreases heart rate', 'It increases heart rate', 'It increases contractility', 'It increases stroke volume'], 'Parasympathetic stimulation through the vagus nerve decreases heart rate.', 'Vagal (parasympathetic) stimulation decreases heart rate.'],
    ],
  };
  const KEY = {}; Object.values(BANK).flat().forEach(([stem, opts]) => { KEY[stem] = opts[0]; });
  const used = {};
  const between = (s, a, b) => { const i = s.indexOf(a) + a.length; return b ? s.slice(i, s.indexOf(b, i)) : s.slice(i); };
  const line = (s, k) => (s.match(new RegExp(k + ': (.*)')) || [])[1] || '';
  const S2 = 'Closure of which valves produces the second heart sound (S2)?';
  const answer = (input) => {
    if (input.includes('Write one question per slot')) {
      const slots = JSON.parse(between(input, 'SLOTS:\n', '\nPAGES:\n'));
      return { questions: slots.map((s) => { const ref = s.pages[0], n = +String(ref).replace(/^d\d+p/, ''); const list = BANK[n] || []; const k = (used[n] = (used[n] || 0) + 1) - 1;
        if (k >= list.length) return { slot: s.slot, unwritable_reason: 'Every fact on this slide is already asked.' };
        const [stem, options, quote, explanation] = list[k];
        return { slot: s.slot, type: s.type, unwritable_reason: null, stem, options, correct_index: 0, explanation, purpose: 'Checks one fact the slide teaches: ' + quote.slice(0, 50), reasoning_pattern: s.type, evidence: [{ page: ref, quote }], uses_external: false }; }) };
    }
    if (input.includes('strict, independent exam reviewer')) {
      const qs = JSON.parse(between(input, '\nQUESTIONS:\n', '\nReturn JSON'));
      return { results: qs.map((q) => ({ id: q.id, chosen_index: Math.max(0, q.options.indexOf(KEY[q.stem])), answerable_from_source: true, single_best_answer: true, sufficient_data: true, needs_outside_knowledge: false, flaws: [], severity: 'none', weak_options: [] })) };
    }
    if (input.includes('STUDENT ASKS:')) {
      const ask = line(input, 'STUDENT ASKS');
      if (/أبسط/.test(ask)) return { ar: 'تخيّل دقة القلب «لَبّ-دَبّ»: «لَبّ» هي S1 حين تُغلق الصمامات الأذينية البطينية Atrioventricular valves، و«دَبّ» هي S2 حين تُغلق الصمامات الهلالية Semilunar valves. الأول للأذيني البطيني، والثاني للهلالي.' };
      return { ar: 'لأن المحاضرة تربط كل صوت بصمامات مختلفة: S1 يحدث عند إغلاق Atrioventricular valves (الصمامات الأذينية البطينية)، و S2 يحدث عند إغلاق Semilunar valves (الصمامات الهلالية). السؤال عن S2، واختيارك يخص الصوت الأول لا الثاني.' };
    }
    if (input.includes('ORIGINAL QUESTION:')) {
      return { stem: 'Closure of the semilunar valves produces which heart sound?', options: ['The second heart sound (S2)', 'The first heart sound (S1)', 'A sound during ejection', 'A sound during atrial filling'], correct_index: 0,
        explanation: 'المحاضرة تقول إن إغلاق الصمامات الهلالية semilunar valves يُحدث الصوت الثاني S2.', quote: 'The second heart sound (S2) is produced by closure of the semilunar valves.', page: 'p3' };
    }
    if (input.includes('Arabic-speaking tutor') && line(input, 'QUESTION') === S2) {
      return { ar: 'الصواب: Semilunar valves (الصمامات الهلالية). اختيارك Atrioventricular valves صحيح لصوت آخر: إغلاقها يُحدث الصوت الأول S1، أما S2 فيأتي من إغلاق الصمامات الهلالية. تذكّر: الأول للأذيني البطيني، والثاني للهلالي.' };
    }
    return null;
  };
  const t = setInterval(() => { const c = window.claude; if (!c || c.__promo) return; clearInterval(t); c.__promo = true; const use = c.use.bind(c);
    c.use = async (n) => { const s = await use(n); if (n !== 'sample' || !s || s.__promo) return s; const j = s.json.bind(s);
      s.json = async (input, o) => { const r = answer(input); if (r) { await new Promise((ok) => setTimeout(ok, 400 + Math.random() * 500)); return r; } return j(input, o); }; s.__promo = true; return s; }; }, 1);
})();
