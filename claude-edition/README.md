# كويزي — نسخة Claude
نفس الواجهة، لكن تعمل كصفحة داخل claude.ai: التوليد عبر `sample` (Claude المشاهد)، والحفظ في `db` (بيانات خاصة لكل شخص)، والاستخراج في المتصفح (pdf.js وJSZip).
البناء: `python3 build.py` (يُنتج `dist/`) ثم النشر كـ artifact مع القدرات `db` و`user` و`sample`.
الاختبار المحلي: `NODE_PATH=<playwright> node test/run.js dist file.pdf deck.pptx` (يستخدم `test/shim.js` لمحاكاة المنصة؛ لا يُنشر).
حدود: يتطلب تسجيل دخول claude.ai، بلا PDF ولا إدارة، والتوليد يعمل ما دامت الصفحة مفتوحة.
