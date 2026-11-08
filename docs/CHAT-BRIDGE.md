# النقل اليدوي إلى ChatGPT/Claude: أُزيل

**8 نوفمبر 2026:** بطلب صاحب المشروع أُزيل النقل اليدوي (نسخ الطلب ولصق رد JSON) من موقع GitHub Pages كاملًا: الواجهة، ومسار `/api/quizzes/{id}/chat-bridge` في `shared/api-core.js`، واختباره `run_web_chat_bridge.js`. السبب: كثرة الخيارات تربك الطالب، والمطلوب توليد تلقائي لا نسخ ولصق.

البديل النظامي: صفحة `#/smart` بمسارين يولّدان تلقائيًا من حساب الطالب الشخصي داخل الخدمة نفسها:

- **Claude:** نسخة كويزي داخل claude.ai (<https://claude.ai/artifact/DdmX7Yx3yuqH9gZChPVmNN>). تستعمل Claude من حساب من يفتحها، وهي ميزة رسمية في claude.ai. يلزم أن يشاركها المالك من قائمة Share («أي شخص لديه الرابط») ليصل إليها الطلاب.
- **ChatGPT:** تطبيق كويزي داخل ChatGPT (`chatgpt-app/`). يعمل من حساب المستخدم داخل chatgpt.com. إتاحته لغير المالك تحتاج نشره في تطبيقات ChatGPT عبر OpenAI.

استعمال حساب ChatGPT أو Claude الشخصي من داخل موقع خارجي غير مسموح دون موافقة المزوّد (راجع [CHATGPT-CONNECTION.md](CHATGPT-CONNECTION.md)).
