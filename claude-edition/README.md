# كويزي — نسخة Claude
نفس الواجهة، لكن تعمل كصفحة داخل claude.ai: التوليد عبر `sample` (Claude المشاهد)، والحفظ في `db` (بيانات خاصة لكل شخص)، والاستخراج في المتصفح (pdf.js وJSZip).
البناء: `python3 build.py` (يُنتج `dist/`) ثم النشر كـ artifact مع القدرات `db` و`user` و`sample`.
النسختان المنشورتان المعتمدتان (يُحدَّث الاثنان معًا بنفس `dist/` على رابطيهما نفسيهما): **نسخة المالك الخاصة** <https://claude.ai/artifact/Rvd496jv1D69cNBYTrsmWH>، و**نسخة الطلاب** <https://claude.ai/artifact/YJBtGzSVM3TkaHSkmttCfd> (هي التي تُعطى للطلاب). الرابط القديم `DdmX7Yx3yuqH9gZChPVmNN` لم يعد موجودًا.
الاختبار المحلي: `NODE_PATH=<playwright> node test/run.js dist file.pdf deck.pptx` (يستخدم `test/shim.js` لمحاكاة المنصة؛ لا يُنشر).
حدود: يتطلب تسجيل دخول claude.ai، بلا PDF ولا إدارة، والتوليد يعمل ما دامت الصفحة مفتوحة.
