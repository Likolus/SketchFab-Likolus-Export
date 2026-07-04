# SketchFab Likolus Export

**English** | [Русский](#русский)

---

## English

A Tampermonkey UserScript that exports Sketchfab models **exactly as they look in the viewer** — as a **single, whole OBJ + MTL + textures** with correctly mapped materials, so that opening in **Maya** or **Blender** loses nothing: geometry, UVs, normals, PBR textures and their paths all survive.

The model is exported as **one combined `.obj` file** containing every part as an internal group (`o` / `usemtl`) — never split into `model_0.obj`, `model_1.obj`, `model_2.obj`… the way older rippers did. A multi-material model (e.g. an aircraft with 30+ parts) lands as one `ModelName.obj` with 30+ groups inside, plus one `ModelName.mtl` that maps every group to its PBR textures.

### Result

The downloaded ZIP looks like:

```
ModelName/
├── ModelName.obj          # ONE combined file: every part as an o/usemtl group
├── ModelName.mtl          # materials, all PBR maps (map_Kd/map_Bump/map_Pr/...)
├── metadata.json          # source url, author, date, sketchfab id
└── textures/
    ├── Body_albedo.jpg     # original full-res, original format
    ├── Body_normal.png
    ├── Body_roughness.jpg
    └── Metal_albedo.png
```

Open the `.obj` in Maya or Blender → the MTL loads automatically, textures resolve from the relative `textures/` path, and the model looks the same as on Sketchfab.

### Features

- **Single combined OBJ** — every captured geometry becomes a group (`o name` + `usemtl name`) inside one `ModelName.obj`, with continuous global vertex/uv/normal indexing across groups. No more pile of loose `model_N.obj` files.
- **Real MTL** — a proper `.mtl` is generated and referenced via `mtllib`. Each group has its own material assigned with `usemtl`, so materials actually show up in Maya/Blender.
- **Correct material → texture linking** — each material is bound to its textures by (a) capturing the currently-bound GL texture at draw time, and (b) name-prefix matching against the geometry's stateset name.
- **Full-resolution original textures** — textures are downloaded from their **original URLs** via `GM_xmlhttpRequest`, preserving full resolution, original format (`.jpg`/`.png`) and correct orientation. `readPixels` is only a fallback.
- **Complete PBR map set** — albedo, normal, roughness, metallic, specular, emissive, opacity and AO are all classified and emitted with the right MTL keys.
- **Relative texture paths** — textures live in a `textures/` subfolder and the MTL references them as `textures/...`, so paths resolve on any OS without editing.
- **GLTF export** — alternative GLTF + `.bin` output (with PBR textures) for pipelines that prefer it.
- **Rig + animation export** — when enabled, the script also captures the skeleton (bones hierarchy with TRS), skin weights (JOINTS_0/WEIGHTS_0), inverse-bind matrices and keyframe animations, and writes them into the glTF. The rigged model opens in Maya/Blender with a working armature and playable animations. (OBJ cannot carry rig data — this requires glTF.)
- **Progress UI** — per-stage progress bar (linking materials → fetching textures → writing OBJ/MTL → packaging) with live geometry/texture/bone/animation counts.

### Rig & animation export

Animated/rigged models need a skeleton (bones), skin weights (which vertices each bone influences), inverse-bind matrices, and keyframe animations. None of this can live in OBJ — OBJ is purely static geometry. The script therefore exports rig data through **glTF**, which has native `skins`, `joints`, `weights`, `inverseBindMatrices` and `animations` — all supported by Maya and Blender.

To export a rigged model:

1. Tick **Rig + Anim** in the panel. This forces the **GLTF** format (OBJ is disabled because it cannot carry rig data).
2. Let the model fully load, and play/scrub the animation at least once so the viewer uploads the skeleton and animation tracks.
3. Click **EXPORT & DOWNLOAD**. The script captures bones (with their local TRS and parent hierarchy), per-vertex joint indices + weights, inverse-bind matrices, and every animation track (per-bone translation/rotation/scale keyframes).
4. The resulting `ModelName.gltf` + `ModelName.bin` open in Blender (`File → Import → glTF`) or Maya (`File → Import`) with a working armature and playable animations.

> **Note on capture reliability:** Sketchfab's viewer is minified and does not expose a documented rig API. The script probes many possible internal property names for skin / joints / weights / skeleton / animations. On most rigged models this succeeds; if a particular model exposes skinning under unusual names, the Bones/Anims counters may stay 0 — in that case enable the browser console and look for `[LikolusExport]` lines to see what was probed.

### PBR map support

Each captured texture is classified by name and emitted with the appropriate MTL key (Blender & Maya 2018+ extended MTL):

| Texture name keyword | MTL key |
|---|---|
| albedo / basecolor / diffuse / color | `map_Kd` |
| normal / bump | `map_Bump` + `norm` |
| roughness | `map_Pr` |
| metallic / metalness | `map_Pm` |
| specular / spec | `map_Ks` |
| emissive / emission | `map_Ke` |
| opacity / alpha / mask | `map_d` |
| occlusion / ao | `# map_ao` (no standard key) |

### Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) (Chrome / Edge / Firefox).
2. Enable **Developer Mode** in your browser's extensions page (required for userscripts in Manifest V3 Chrome).
3. Open the Tampermonkey dashboard → **Create a new script** → paste the contents of [`SketchFabLikolusExport.user.js`](./SketchFabLikolusExport.user.js) → **Ctrl+S** to save.
4. Make sure the script is **enabled** (toggle ON).

### Use

1. Open any Sketchfab model page (e.g. `https://sketchfab.com/3d-models/<slug>-<id>`).
2. **Wait until the model has FULLY loaded** (the script can only capture what the viewer has uploaded to the GPU — partially-loaded models give partial exports).
3. A small panel appears in the bottom-right corner: **"SketchFab Likolus Export"**.
4. Pick the format:
   - **OBJ + MTL + Textures** (default) — for Maya / Blender.
   - GLTF + .bin — alternative.
5. Adjust **Scale** (try `0.01` or `0.1` if the model is huge in Unity/Blender).
6. Optionally toggle **Flip UV V** (only if textures come out upside-down — normally leave off) or **Textures only**.
7. Click **EXPORT & DOWNLOAD**.
8. Wait for the progress bar to reach 100% — a ZIP downloads automatically.

> Tip: orbit / zoom the model a little before exporting so the viewer uploads all texture mip levels to the GPU. The script also downloads textures directly from their original URLs (full-res), so even un-viewed textures are captured if their metadata was registered.

### How it works

The Sketchfab viewer is a minified WebGL application. The script intercepts the viewer's JS before it executes (via a `MutationObserver`-based `onbeforescriptexecute` shim) and regex-patches five known injection points:

| Patch | Purpose |
|---|---|
| `renderInto(n,E,R` → `…,i` | capture texture-pipeline variable |
| `renderInto=function(e,i,r` → `…,image_data` | thread image data |
| `drawArrays(TRIANGLES,0,6)` → `…,window.drawhookimg(gl,t)` | texture-pass capture |
| `getResourceImage:function(e,t){` → `…; e = window.drawhookcanvas(e,this._imageModel);` | texture metadata + URL capture |
| `drawGeometry(this._graphicContext,t)` → `…; window.attachbody(t,this._graphicContext);` | geometry capture + bound-texture read |

At draw time:

- **`attachbody(t, glCtx)`** records the geometry (vertices, normals, UVs, indices, primitive modes) **and** queries `glCtx.getParameter(TEXTURE_BINDING_2D)` to find the currently-bound texture, linking the geometry's material to that texture directly.
- **`drawhookcanvas(e, imageModel)`** records each texture's name, PBR type (classified by name), and **original download URL** (largest power-of-two variant).
- A global `texImage2D` hook builds a `WebGLTexture → URL` map used both for bound-texture resolution and as a readPixels fallback.

At export time:

1. `buildMaterials()` creates one material per geometry and links textures by (a) the bound texture captured at draw time, then (b) name-prefix matching against the geometry's stateset name, then (c) for single-geometry models, assigning all textures by type.
2. `fetchAllTextures()` downloads each texture from its original URL via `GM_xmlhttpRequest` (full-res, original `.jpg`/`.png`, correct orientation). If a URL fetch fails, it falls back to `readPixels` from a framebuffer (with correct vertical flip).
3. `buildObj()` writes **one** combined `.obj` with `o`/`usemtl` per group and correct per-group vertex/uv/normal index offsets — so a 30-part model is one file with 30 groups, not 30 files.
4. `buildMtl()` writes the `.mtl` with `map_Kd`/`map_Bump`/`map_Pr`/`map_Pm`/`map_Ks`/`map_Ke`/`map_d` referencing `textures/…`.
5. JSZip packages everything; FileSaver triggers the download.

### Notes & limitations

- The regex patches target the current Sketchfab viewer minification. If Sketchfab updates their viewer and the patches stop matching, capture silently breaks (panel shows 0 geometries). Check the browser console for `[LikolusExport] patch … ok` lines.
- Some Sketchfab models use compressed (`KTX2`) textures. The URL-download path still grabs the original source image (usually `.jpg`/`.png`); if only KTX2 is available, the readPixels fallback (PNG) is used.
- Sketchfab texture URLs are token-signed and time-limited. Export **while the model page is open** — don't leave it overnight and then click export.
- Very large models can take a while to ZIP in-browser; the progress bar reflects the current stage.

### Credits

Built on the Sketchfab viewer hooking technique pioneered by **Risk** / [gamedev44](https://github.com/gamedev44/Fabulous-Ripper) and [WulfSkol](https://github.com/WulfSkol/SUR-SketchfabUtilityRipper). OBJ/MTL PBR export, original-texture fetching, material linking and the combined single-file OBJ writer by **Likolus**.

### License

Provided as-is for personal use. Respect Sketchfab's Terms of Service and individual model licenses — only export models you have the right to download.

---
---

## Русский

[English](#english) | **Русский**

UserScript для Tampermonkey, экспортирующий модели Sketchfab **ровно в том виде, в каком они отображаются во вьювере** — как **единый OBJ + MTL + текстуры** с корректно наложенными материалами, чтобы при открытии в **Maya** или **Blender** ничего не терялось: геометрия, UV-развёртка, нормали, PBR-текстуры и пути к ним сохраняются полностью.

Модель экспортируется как **один объединённый файл `.obj`**, где каждая часть оформлена как внутренняя группа (`o` / `usemtl`) — а не разбивается на `model_0.obj`, `model_1.obj`, `model_2.obj`… как в старых рипперах. Многоматериальная модель (например, самолёт из 30+ деталей) получается одним `ModelName.obj` с 30+ группами внутри плюс один `ModelName.mtl`, привязывающий к каждой группе её PBR-текстуры.

### Результат

Скачанный ZIP выглядит так:

```
ModelName/
├── ModelName.obj          # ОДИН файл: каждая часть как группа o/usemtl
├── ModelName.mtl          # материалы, все PBR-карты (map_Kd/map_Bump/map_Pr/...)
├── metadata.json          # исходный url, автор, дата, id sketchfab
└── textures/
    ├── Body_albedo.jpg     # оригинал в полном разрешении, исходный формат
    ├── Body_normal.png
    ├── Body_roughness.jpg
    └── Metal_albedo.png
```

Откройте `.obj` в Maya или Blender → MTL подхватится автоматически, текстуры найдутся по относительному пути `textures/`, и модель будет выглядеть так же, как на Sketchfab.

### Возможности

- **Единый объединённый OBJ** — каждая захваченная геометрия становится группой (`o имя` + `usemtl имя`) внутри одного `ModelName.obj` со сквозной глобальной нумерацией вершин/UV/нормалей между группами. Никакой кучи отдельных `model_N.obj`.
- **Настоящий MTL** — генерируется корректный `.mtl`, на который ссылается `mtllib`. Каждой группе назначается свой материал через `usemtl`, поэтому материалы действительно отображаются в Maya/Blender.
- **Корректная связь материал → текстура** — каждый материал привязывается к своим текстурам (а) захватом активной GL-текстуры в момент отрисовки и (б) сопоставлением префикса имени с именем stateset геометрии.
- **Оригинальные текстуры в полном разрешении** — текстуры скачиваются по **оригинальным URL** через `GM_xmlhttpRequest`, сохраняя полное разрешение, исходный формат (`.jpg`/`.png`) и правильную ориентацию. `readPixels` используется только как запасной вариант.
- **Полный набор PBR-карт** — albedo, normal, roughness, metallic, specular, emissive, opacity и AO классифицируются и выводятся с нужными MTL-ключами.
- **Относительные пути к текстурам** — текстуры лежат в подпапке `textures/`, а MTL ссылается на них как `textures/...`, поэтому пути работают на любой ОС без правок.
- **Экспорт в GLTF** — альтернативный вывод GLTF + `.bin` (с PBR-текстурами) для пайплайнов, где это удобнее.
- **Экспорт рига и анимации** — при включении скрипт дополнительно захватывает скелет (иерархию костей с TRS), скин-веса (`JOINTS_0`/`WEIGHTS_0`), обратные матрицы связывания (inverse-bind) и покадровые анимации и записывает их в glTF. Ригованная модель открывается в Maya/Blender с рабочей арматурой и воспроизводимыми анимациями. (OBJ не может нести данные рига — для этого нужен glTF.)
- **Индикатор прогресса** — прогресс-бар по стадиям (связывание материалов → загрузка текстур → запись OBJ/MTL → упаковка) с живым счётчиком геометрий/текстур/костей/анимаций.

### Экспорт рига и анимации

Анимированные/ригованные модели требуют скелета (костей), скин-весов (какие вершины влияет на каждую кость), обратных матриц связывания и покадровых анимаций. Ничто из этого не может жить в OBJ — OBJ чисто статическая геометрия. Поэтому скрипт экспортирует данные рига через **glTF**, в котором есть нативные `skins`, `joints`, `weights`, `inverseBindMatrices` и `animations` — всё поддерживается Maya и Blender.

Чтобы экспортировать ригованную модель:

1. Отметьте **Rig + Anim** на панели. Это принудительно включит формат **GLTF** (OBJ отключён, так как не несёт данные рига).
2. Дождитесь полной загрузки модели и проиграйте/прокрутите анимацию хотя бы один раз, чтобы вьювер загрузил скелет и дорожки анимации.
3. Нажмите **EXPORT & DOWNLOAD**. Скрипт захватывает кости (с их локальными TRS и иерархией родителей), индексы суставов + веса на вершину, обратные матрицы связывания и каждую дорожку анимации (покадровые translation/rotation/scale на кость).
4. Полученные `ModelName.gltf` + `ModelName.bin` открываются в Blender (`File → Import → glTF`) или Maya (`File → Import`) с рабочей арматурой и воспроизводимыми анимациями.

> **О надёжности захвата:** вьювер Sketchfab минифицирован и не предоставляет документированного API рига. Скрипт пробует множество возможных внутренних имён свойств для skin / joints / weights / skeleton / animations. На большинстве ригованных моделей это срабатывает; если конкретная модель хранит скиннинг под необычными именами, счётчики Bones/Anims могут остаться 0 — в таком случае включите консоль браузера и ищите строки `[LikolusExport]`, чтобы увидеть, что именно проверялось.

### Поддержка PBR-карт

Каждая захваченная текстура классифицируется по имени и выводится с соответствующим MTL-ключом (расширенный MTL для Blender и Maya 2018+):

| Ключевое слово в имени текстуры | MTL-ключ |
|---|---|
| albedo / basecolor / diffuse / color | `map_Kd` |
| normal / bump | `map_Bump` + `norm` |
| roughness | `map_Pr` |
| metallic / metalness | `map_Pm` |
| specular / spec | `map_Ks` |
| emissive / emission | `map_Ke` |
| opacity / alpha / mask | `map_d` |
| occlusion / ao | `# map_ao` (без стандартного ключа) |

### Установка

1. Установите [Tampermonkey](https://www.tampermonkey.net/) (Chrome / Edge / Firefox).
2. Включите **Режим разработчика** на странице расширений браузера (обязательно для userscript-ов в Chrome на Manifest V3).
3. Откройте панель Tampermonkey → **Создать новый скрипт** → вставьте содержимое [`SketchFabLikolusExport.user.js`](./SketchFabLikolusExport.user.js) → **Ctrl+S** для сохранения.
4. Убедитесь, что скрипт **включён** (переключатель ON).

### Использование

1. Откройте страницу любой модели Sketchfab (например, `https://sketchfab.com/3d-models/<slug>-<id>`).
2. **Дождитесь ПОЛНОЙ загрузки модели** (скрипт может захватить только то, что вьювер загрузил в GPU — у частично загруженной модели будет частичный экспорт).
3. В правом нижнем углу появится панель: **«SketchFab Likolus Export»**.
4. Выберите формат:
   - **OBJ + MTL + Textures** (по умолчанию) — для Maya / Blender.
   - GLTF + .bin — альтернатива.
5. Настройте **Scale** (попробуйте `0.01` или `0.1`, если модель огромная в Unity/Blender).
6. При необходимости включите **Flip UV V** (только если текстуры выходят перевёрнутыми — обычно выключено) или **Textures only**.
7. Нажмите **EXPORT & DOWNLOAD**.
8. Дождитесь, пока прогресс-бар дойдёт до 100% — ZIP скачается автоматически.

> Совет: покрутите/приблизьте модель перед экспортом, чтобы вьювер загрузил все уровни mipmap текстур в GPU. Скрипт также скачивает текстуры напрямую по оригинальным URL (в полном разрешении), поэтому даже непросмотренные текстуры захватываются, если их метаданные были зарегистрированы.

### Как это работает

Вьювер Sketchfab — минифицированное WebGL-приложение. Скрипт перехватывает JS вьювера перед выполнением (через основанный на `MutationObserver` механизм `onbeforescriptexecute`) и патчит регулярками пять известных точек инъекции:

| Патч | Назначение |
|---|---|
| `renderInto(n,E,R` → `…,i` | захват переменной текстурного конвейера |
| `renderInto=function(e,i,r` → `…,image_data` | передача данных изображения |
| `drawArrays(TRIANGLES,0,6)` → `…,window.drawhookimg(gl,t)` | захват текстурного прохода |
| `getResourceImage:function(e,t){` → `…; e = window.drawhookcanvas(e,this._imageModel);` | захват метаданных текстуры + URL |
| `drawGeometry(this._graphicContext,t)` → `…; window.attachbody(t,this._graphicContext);` | захват геометрии + чтение связанной текстуры |

Во время отрисовки:

- **`attachbody(t, glCtx)`** записывает геометрию (вершины, нормали, UV, индексы, режимы примитивов) **и** опрашивает `glCtx.getParameter(TEXTURE_BINDING_2D)`, чтобы найти текущую привязанную текстуру — напрямую связывая материал геометрии с этой текстурой.
- **`drawhookcanvas(e, imageModel)`** записывает имя каждой текстуры, её PBR-тип (определяется по имени) и **оригинальный URL скачивания** (наибольший вариант со степенью двойки).
- Глобальный хук `texImage2D` строит карту `WebGLTexture → URL`, используемую как для разрешения связанных текстур, так и как запасной вариант для readPixels.

Во время экспорта:

1. `buildMaterials()` создаёт по одному материалу на геометрию и привязывает текстуры (а) по захваченной при отрисовке активной текстуре, затем (б) по совпадению префикса имени с именем stateset геометрии, затем (в) для моделей с одной геометрией — назначая все текстуры по типу.
2. `fetchAllTextures()` скачивает каждую текстуру по её оригинальному URL через `GM_xmlhttpRequest` (полное разрешение, исходный `.jpg`/`.png`, правильная ориентация). Если загрузка по URL не удалась, используется запасной `readPixels` из framebuffer (с корректным вертикальным отражением).
3. `buildObj()` записывает **один** объединённый `.obj` с `o`/`usemtl` на группу и корректными смещениями индексов вершин/UV/нормалей для каждой группы — поэтому модель из 30 частей это один файл с 30 группами, а не 30 файлов.
4. `buildMtl()` записывает `.mtl` с `map_Kd`/`map_Bump`/`map_Pr`/`map_Pm`/`map_Ks`/`map_Ke`/`map_d`, ссылающимися на `textures/…`.
5. JSZip упаковывает всё; FileSaver инициирует скачивание.

### Замечания и ограничения

- Регулярки патчей привязаны к текущей минификации вьювера Sketchfab. Если Sketchfab обновит вьювер и патчи перестанут совпадать, захват молча сломается (панель покажет 0 геометрий). Проверьте консоль браузера на наличие строк `[LikolusExport] patch … ok`.
- Некоторые модели Sketchfab используют сжатые (`KTX2`) текстуры. Загрузка по URL всё равно берёт исходное изображение источника (обычно `.jpg`/`.png`); если доступен только KTX2, используется запасной вариант readPixels (PNG).
- URL текстур Sketchfab подписаны токеном и ограничены по времени. Экспортируйте **пока страница модели открыта** — не оставляйте на ночь и потом не нажимайте экспорт.
- Очень большие модели могут упаковываться в ZIP в браузере довольно долго; прогресс-бар отражает текущую стадию.

### Авторство

Основано на технике перехвата вьювера Sketchfab, предложенной **Risk** / [gamedev44](https://github.com/gamedev44/Fabulous-Ripper) и [WulfSkol](https://github.com/WulfSkol/SUR-SketchfabUtilityRipper). Экспорт OBJ/MTL с PBR, загрузка оригинальных текстур, связывание материалов и писатель единого объединённого OBJ — **Likolus**.

### Лицензия

Предоставляется как есть для личного использования. Уважайте Условия использования Sketchfab и лицензии отдельных моделей — экспортируйте только те модели, на которые у вас есть право скачивания.
