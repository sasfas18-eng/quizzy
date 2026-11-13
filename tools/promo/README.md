# المقطع التعريفي لكويزي

يُسجَّل من واجهة كويزي الحقيقية (نسخة كلود) بمقاس الجوال، مع شرح عربي فوق كل خطوة. كلود فيه محاكى
(`claude-edition/test/shim.js` + `promo_model.js`) حتى يُظهر المقطع الخطوات التي يصفها تمامًا، ولا يخرج شيء من الجهاز.

```bash
python3 claude-edition/build.py /tmp/ce-dist
python3 tools/promo/make_lecture.py "/tmp/Cardiac Cycle - Lecture 3.pdf"
node tools/promo/record.js /tmp/ce-dist "/tmp/Cardiac Cycle - Lecture 3.pdf" /tmp/promo
ffmpeg -ss "$(cat /tmp/promo/trim.txt)" -i /tmp/promo/*.webm -c:v libx264 -crf 20 -pix_fmt yuv420p -r 30 -movflags +faststart quizzy_intro.mp4
```

بعد أي تحديث في الواجهة يُعاد تسجيله بالأوامر نفسها.
