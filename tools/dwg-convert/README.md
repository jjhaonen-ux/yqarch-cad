# tools/dwg-convert — محوّل DWG المعزول

يحوّل كل ملفات ‎.dwg في مجلد YQArch إلى JSON بصيغة `yqweb-drawing@1` (موثقة في `docs/asset-formats.md`).

```bash
npm install                # مرة واحدة داخل هذا المجلد
node convert-dwg.mjs --src <مجلد YQArch> --out ../../assets/blocks [--only <جزء من المسار>]
```

النتيجة على مستودع YQArch v6.7.4c: **261/261 ملفاً بلا أخطاء في ~7 ثوانٍ** (إصدارات R12 و R14 و 2004 و 2007).
رسائل `Open dwg file with error code: 4/64/68` تحذيرات قابلة للتعافي من libredwg، وتُسجّل في `readerCode` داخل index.json.

## لماذا هو معزول؟ (الترخيص)

يعتمد على [`@mlightcad/libredwg-web`](https://www.npmjs.com/package/@mlightcad/libredwg-web) ‏0.8.3، وهو مبني على GNU LibreDWG
ومرخّص **GPL-3.0**. لذلك:

- هذا المجلد أداة بناء مستقلة (`package.json` خاص به، الترخيص GPL-3.0-or-later)، **لا يُستورد** من كود التطبيق.
- التطبيق يستهلك فقط ملفات JSON الناتجة، وهي بيانات مشتقة من رسومات YQArch وليست جزءاً من LibreDWG.
- إن أردت لاحقاً فتح ملفات DWG داخل المتصفح نفسه (في التطبيق)، فسيصبح التطبيق خاضعاً لـ GPL؛ البديل: تحويل DWG على الخادم بهذه الأداة، أو مكتبة تجارية (مثل ODA).

## ما يُنتجه لكل رسم

طبقات، أنواع خطوط، أنماط نص، كل تعريفات الكتل (بما فيها المجهولة ‎*U / ‎*D للكتل الديناميكية والأبعاد)، كيانات فضاء النموذج،
مستطيل الإحاطة المحسوب، وإحصاءات (أنواع الكيانات، غير المدعوم، المتجاهَل، الكتل المفقودة).

الكيانات المدعومة: LINE, ARC, CIRCLE, ELLIPSE, LWPOLYLINE, POLYLINE2D/3D (← LWPOLYLINE), SPLINE, SOLID/TRACE, TEXT, MTEXT,
ATTDEF, INSERT (+ATTRIB), DIMENSION, HATCH (حدود مسطّحة + خطوط النمط), WIPEOUT, POINT.
