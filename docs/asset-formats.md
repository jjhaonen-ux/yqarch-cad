# صيغ الأصول المستخرجة (assets/)

يصف هذا الملف كل ملف تنتجه المرحلة الأولى، حتى يبني عليه محرّك الرسم في المرحلة الثانية مباشرة.
كل الملفات JSON بترميز UTF-8. الإحداثيات بوحدات الرسم الأصلية (غالباً مم). **الزوايا في الكتل (blocks) بالراديان وعكس عقارب الساعة**، أما في الأنماط (patterns.json) فبالدرجات كما في ملف ‎.pat الأصلي.

```
assets/
├── manifest.json           ملخص التشغيل: المصادر، الأعداد، الملفات المستبعدة
├── report.md               تقرير مقروء بالأعداد والتحذيرات
├── commands.json           كتالوج أوامر YQArch (477 أمراً في 22 فئة)
├── panels.json             لوحات الأزرار من yqpanel.txt
├── patterns.json           كل أنماط التهشير (.pat)
├── linetypes.json          أنواع الخطوط (yqarch.lin)
├── profiles/
│   ├── index.json          قائمة البروفايلات وملفاتها
│   └── <user1|user2|userHBA|userCCD>/*.json
├── thumbnails/
│   ├── index.json          فهرس الصور المصغّرة وربطها بملفات DWG والأنماط
│   └── **/*.svg            شرائح SLD/SLB محوّلة إلى SVG
├── fonts/
│   ├── index.json
│   └── <FONT>.json         خطوط SHX محوّلة إلى مسارات متجهية
└── blocks/
    ├── index.json          فهرس ملفات DWG المحوّلة (من tools/dwg-convert)
    └── **/*.json           رسم واحد لكل ملف DWG
```

---

## commands.json

```jsonc
{
  "source": ["shortcut_6.7.4c.yqs", "yqshortcut.txt"],
  "version": "6.7.4c",
  "categories": [
    { "id": "systemsetup", "zh": "系统设定", "en": "System Setup", "panelCommand": "yq_systemsetup", "panelAlias": "sys", "order": 1 }
  ],
  "commands": [
    { "id": "yqarch", "zh": "源泉总览命令", "en": "YQArch Command Pandect", "category": "systemsetup",
      "group": 0, "order": 1, "alias": "yq", "stars": 5, "description": "源泉设计命令总览", "notes": [] }
  ]
}
```

| الحقل | المعنى |
|---|---|
| `id` | اسم الأمر الداخلي في YQArch (مفتاح فريد) |
| `alias` | الاختصار الافتراضي (يمكن لكل بروفايل تغييره، انظر `alias-overrides`) |
| `group` | رقم المجموعة داخل الفئة (الفاصل `--` في ملف yqs يبدأ مجموعة جديدة) |
| `stars` | تقييم الأهمية من yqshortcut.txt (1–5) |
| `notes` | ملاحظات الإصدارات المرتبطة بالأمر |

## panels.json

`panels[] → { zh, en, buttonsPerColumn, alias, sections[] → { zh, en, hint, items[] → { zh, en, command, alias, separator } } }`
حقل `command` قد يكون اسم أمر أو تعبير LISP كما هو في الملف الأصلي؛ يُحفظ حرفياً.

## profiles/&lt;name&gt;/*.json

كل ملف بالشكل `{ "source": "<الملف الأصلي>", "data": ... }`.

| الملف الناتج | المصدر | محتوى `data` |
|---|---|---|
| `config.json` | config.txt | `{ sections[], entries[] { key, raw, value, label, comment, notes, section }, values{} }` القيم مُنمّطة: أرقام، yes/no → boolean، قوائم أرقام |
| `layers.json` | layers.txt | `[{ name, color, linetype, lineweight, plot, description }]` |
| `layer-relay.json` | relay01.txt | `[{ from, to: LayerDef }]` تحويل أسماء الطبقات القديمة |
| `text-styles.json` | styles.txt | `[{ name, fonts[], isTrueType }]` |
| `quick-hatch.json` | hatching.txt | `[{ label, pattern, angle, scale, extra[] }]` |
| `pattern-picks-N.json` | patternsN.txt | `[{ pattern, fields[], description }]` |
| `hatch-keys.json` | hatchkey.txt | `[{ alias, pattern, scale, angle, extra[] }]` |
| `linetype-keys.json` | ltypekey.txt | `[{ alias, linetype, scale, extra[] }]` |
| `layer-keys.json` | layerkey.txt | `[{ alias, layer: LayerDef }]` |
| `wildcard-layer-keys.json` | wlaykey.txt | `[{ alias, pattern, description }]` |
| `numbers.json` | numbers.txt | `[{ raw, values[] }]` حيث `3*600 1200` ← `[600,600,600,1200]` |
| `dictionary.json`, `drawing-titles.json` | dict.txt, dwgtitle.txt | `[{ title, entries[] { code, zh, en } }]` |
| `user-panels.json` | userpanel.txt | نفس بنية panels |
| `pgp-aliases.json` | acad_.pgp | `{ aliases{}, external[] }` |
| `command-settings.json` | settings.txt | `{ command: [values...] }` (t/nil في LISP ← true/null) |
| `alias-overrides.json` | shortcut.yqs | `{ commandId: alias }` فقط الاختصارات المختلفة عن الافتراضي |

> الحقول التي لا يوثّقها YQArch تُحفظ خاماً في `extra` / `fields` بدل تخمين معناها.

## patterns.json

```jsonc
{ "sources": ["ACAD.PAT", ...], "patterns": [
  { "key": "ANGLE", "source": "ACAD.PAT", "name": "ANGLE", "description": "角钢", "units": null,
    "lines": [ { "angle": 0, "origin": [0,0], "delta": [0,0.275], "dashes": [0.2,-0.075] } ] }
]}
```
- `angle` بالدرجات، `delta[0]` إزاحة على امتداد الخط، `delta[1]` المسافة بين الخطوط المتوازية.
- `dashes`: موجب = خط، سالب = فراغ، صفر = نقطة. قائمة فارغة = خط متصل.
- عند تكرار الاسم في أكثر من ملف (مثل ACAD.PAT و ACADiso.PAT) يصبح المفتاح `NAME@<اسم الملف>`.

## linetypes.json

`linetypes[] → { source, name, description, alignment, patternLength, elements[] }` حيث العنصر أحد:
- `{ kind: "dash", length }`
- `{ kind: "text", text, style, params{ S, R, X, Y, ... } }`
- `{ kind: "shape", shape, file, params{} }` (مثل `TRACK1` من ltypeshp.shx أو yqshape.shx)

## thumbnails/index.json

```jsonc
{ "id": "blocks/00_动态块说明", "name": "00 动态块说明", "source": "blocks/00 动态块说明.sld",
  "svg": "thumbnails/blocks/00_动态块说明.svg", "dwg": "blocks/00 动态块说明.dwg", "pattern": null, "segments": 1611 }
```
- ملفات SVG بلا خلفية؛ لون ACI 7 مرسوم بـ `currentColor` لتتبع ثيم الواجهة (فاتح/داكن).
- `dwg` يربط الصورة بملف الكتلة المقابل (216 رابطاً)، و`pattern` يربطها بنمط تهشير بنفس الاسم.
- عناصر مكتبات الشرائح (yqarch.slb و patterns.slb) تحت `thumbnails/slb/<library>/`.

## fonts/&lt;FONT&gt;.json

```jsonc
{ "name": "romand", "kind": "shapes|bigfont|unifont", "isFont": true, "above": 21, "below": 7, "mode": 2,
  "encoding": "ascii|gbk|unicode", "escapeRanges": [], "glyphCount": 111, "notice": "...حقوق الخط...",
  "glyphs": { "L": { "code": 76, "w": 17, "p": [[4,21,4,0], ...] } } }
```
- مفتاح `glyphs` هو الحرف نفسه (Unicode). للخطوط الصينية (bigfont) يُحوَّل رمز GBK إلى الحرف.
- `p`: قائمة خطوط متعددة، كل واحدة مصفوفة مسطّحة `[x0,y0,x1,y1,...]` بوحدات الشكل؛ `w` عرض التقدّم.
- المقياس: ارتفاع النص `h` ⇒ معامل `h / above`.
- رموز خاصة: `°` (‎%%d)، `±` (‎%%p)، `⌀` (‎%%c).
- مكتبات الأشكال غير الحرفية (yqshape.shx) تُفهرس باسم الشكل (`isFont: false`).

## blocks/**/*.json — صيغة `yqweb-drawing@1`

```jsonc
{
  "format": "yqweb-drawing@1", "source": "blocks/五金/BVV93ZL3.dwg", "version": "2007",
  "units": 4,                 // INSUNITS: 4 = mm, 5 = cm, 6 = m, 1 = inch, 0 = بلا وحدة
  "base": [0,0], "bbox": [minX,minY,maxX,maxY], "headerExtents": [...]|null, "ltscale": 1,
  "layers":   [{ "name","color","trueColor?","linetype","lineweight","off","frozen","locked","plot" }],
  "linetypes":[{ "name","description","length","pattern":[...] }],
  "styles":   [{ "name","font","bigFont","height","widthFactor","oblique" }],
  "blocks":   { "<name>": { "base":[x,y], "anonymous?":true, "entities":[...] } },
  "entities": [...],          // فضاء النموذج
  "stats":    { "entities":{}, "unsupported":{}, "ignored":{}, "flaggedInvisible":0, "blocks":0, "missingBlocks":[] }
}
```

حقول مشتركة لكل كيان: `type`, `layer`, و اختيارياً `color` (ACI؛ غيابه = ByLayer، و0 = ByBlock)، `trueColor`، `linetype` (غيابه = ByLayer)، `ltScale`، `lineweight` (1/100 مم؛ ‎-2 ByBlock، ‎-3 Default).

| type | الحقول |
|---|---|
| `LINE` | `a`, `b` |
| `POINT` | `p` |
| `CIRCLE` | `c`, `r` |
| `ARC` | `c`, `r`, `a0`, `a1` (عكس عقارب الساعة من a0 إلى a1) |
| `ELLIPSE` | `c`, `major` (متجه نصف المحور الأكبر)، `ratio`, `a0`, `a1` (بارامترات) |
| `LWPOLYLINE` | `pts: [[x,y,bulge?]]`, `closed`, `width?`؛ و`source` = POLYLINE2D/POLYLINE3D إن حُوّلت منها |
| `SPLINE` | `degree`, `knots`, `ctrl`, `weights?`, `fit?`, `closed`, و`pts` نقاط معاينة جاهزة |
| `SOLID` | `pts` أربع زوايا بترتيب AutoCAD (1,2,3,4 ← يُرسم 1-2-4-3) |
| `TEXT` | `text`, `p`, `p2?`, `h`, `rot`, `style`, `halign?`, `valign?`, `widthFactor?`, `oblique?`, `mirrored?` |
| `MTEXT` | `text` (برموز تنسيق MTEXT الخام)، `p`, `h`, `rot`, `attach` (1–9)، `width?`, `style` |
| `ATTDEF` | كحقول TEXT + `tag`, `prompt`, `invisible` (يُرسم فقط عند عرض الكتلة نفسها، لا عند إدراجها) |
| `INSERT` | `name`, `p`, `sx`, `sy`, `rot`, `cols?/rows?/colSpacing?/rowSpacing?`, `attribs[]` (ATTRIB بحقول TEXT + `tag`) |
| `DIMENSION` | `block` (كتلة ‎*D تحتوي الرسم الجاهز)، `dimType`, `measurement`, `text`, `style`, `textPoint` |
| `HATCH` | `pattern`, `solid`, `loops: [[[x,y]...]]` (حدود مُسطّحة)، ولغير المصمت: `scale`, `angle`, `lines[] { angle, base, offset, dashes }` (خطوط التعريف بعد تطبيق المقياس والزاوية) |
| `WIPEOUT` | `loop` حدود منطقة الإخفاء (تُملأ بلون الخلفية) |

**تحويل الإحداثيات (OCS):** الكيانات ذات `extrusion.z < 0` (معكوسة في AutoCAD) حُوّلت إلى إحداثيات العالم: عكس x والانحناءات، القوس `(π−a1, π−a0)`، الإدراج `rot → −rot` و `sx → −sx`، والنص يُعلَّم `mirrored: true`. لا يحتاج المستهلك للتعامل مع OCS.

**ملاحظات:**
- `flaggedInvisible`: مكتبة القراءة تعلّم كثيراً من كيانات ملفات 2004/2007 بأنها مخفية، وتبيّن بالفحص أن ذلك غير موثوق (رسم ستارة كان سيظهر منه عنصران فقط من 204)، لذا تُرسم كل الكيانات ويُكتفى بالعدّ.
- `ATTRIB` المستقلة مُتجاهَلة لأنها مضمّنة داخل `INSERT.attribs`، و`VIEWPORT` غير مستخدمة في المكتبات.
- القيمة الافتراضية لـ ATTDEF غير متاحة من مكتبة القراءة حالياً (`text` فارغ غالباً).
