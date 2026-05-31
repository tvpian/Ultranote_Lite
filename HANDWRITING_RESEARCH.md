# Handwriting → Text Research Report

_For UltraNote Lite. Purpose: pick a path before writing any code._

## TL;DR (the 60-second version)

Handwriting note-taking on the web has two distinct problems, and they want
different solutions:

1. **Capture (ink)** — Easy. Pointer Events + `<canvas>` is fully solved on
   every device that matters. iPad Safari 13+, Surface Edge, Android Chrome
   all give you pressure, tilt, palm-rejection, and stylus-vs-finger
   discrimination out of the box.
2. **Recognition (ink → text)** — Hard. There is no good universal answer.
   You pick one of three tradeoffs: pay per page, eat ~50–250 MB of
   client-side model weights, or stay ink-only and never recognize at all.

The "killer" apps you mentioned (Notability, GoodNotes, Apple Notes,
OneNote) all solve recognition by being **native apps** that call OS-level
recognizers (Apple PencilKit / Windows Ink). The web has no equivalent.
The closest thing — the Web Handwriting Recognition API — is **only**
shipped on ChromeOS, has been a WICG draft since 2021, and is not visible
in caniuse.com data (effectively dead for cross-platform use).

So the realistic menu for a web app in 2026 is:
- **A** Ink-only, no recognition (search by stroke, not text)
- **B** Cloud OCR on render-to-image (Google/Azure/AWS)
- **C** In-browser model (transformers.js TrOCR or similar)
- **D** Commercial SDK (MyScript iink) — best quality, paid license
- **E** Hybrid: capture ink locally, batch-OCR on a "convert" button

---

## 1. Capture: the easy half (solved)

The Pointer Events API is the right primitive. It is **Baseline Widely
Available** (Chrome 55, Firefox 59, Safari 13, Edge 12), works identically
for mouse / finger / stylus, and exposes everything a note app needs.

| Property         | Use                                              |
|------------------|--------------------------------------------------|
| `pointerType`    | `'pen'` vs `'touch'` — palm rejection            |
| `pressure`       | 0–1, used for variable stroke width              |
| `tiltX/tiltY`    | -90°…90°, shading effects                        |
| `button === 5`   | Apple Pencil / Surface Pen eraser barrel button  |
| `coalescedEvents`| Sub-frame sample density for smooth strokes      |
| `predictedEvents`| Latency hiding (essential on iPad)               |
| `pointerId`      | Multi-touch tracking                             |

Critical CSS: `touch-action: none` on the canvas so the browser doesn't
hijack pen drags for pan/zoom. Use `setPointerCapture(pointerId)` on
`pointerdown` so a stroke that wanders off the canvas still completes.

**On iPad Safari** (the most likely device for handwritten notes), all of
this works in pure PWA mode. No native shell needed. iOS 13+ has had it
since 2019. The newer altitude/azimuth angles arrived in Safari 18.2 (Dec
2024) but those are nice-to-have, not required.

A minimal capture engine is ~200 lines of JS. Stroke data is just an array
of `{x, y, t, p}` points per stroke. That's our internal format regardless
of which recognition path we pick.

---

## 2. Recognition: the hard half — option comparison

### Option A — Ink-only (no recognition at all)

Save strokes as vector data alongside the typed note. Render as SVG.
Searchable only by note title / tags, not by handwritten content.

| | |
|--|--|
| **Pros** | Zero recurring cost. Zero privacy concern. Works offline. Tiny code. Strokes are 100% lossless and editable. |
| **Cons** | Can't grep your handwriting. Loses the main reason most people want this feature. |
| **Best for** | Quick sketches, diagrams, signatures, margin annotations. |
| **Effort** | ~1 day. |

### Option B — Cloud OCR (Google / Azure / AWS)

Render the canvas to PNG/JPEG, POST to a cloud OCR endpoint, store the
returned text alongside the ink.

**Google Cloud Vision — DOCUMENT_TEXT_DETECTION**
- Pricing: **$1.50 / 1000 pages**, first 1000/month free
- Specifically tuned for handwriting (language hint `en-t-i0-handwrit`)
- Returns paragraph / line / word / bounding-poly structure
- EU data residency endpoint available
- Industry consensus: **best handwriting accuracy** of the big three on
  English cursive/print
- Note: Google forwarded the docs URL to `docs.cloud.google.com`

**Azure Vision v4.0 Read OCR**
- Pricing: $1.00–1.50 / 1000 transactions depending on tier
- Unified API for printed + handwritten in one call
- Returns word-level confidence, bounding polygons
- Microsoft says it's "built on universal script-based models"

**AWS Textract DetectDocumentText**
- Pricing: $1.50 / 1000 pages (first 1M); higher tiers for tables/forms
- Strongest on document forms, weaker on freeform handwriting compared to
  Google
- Sync `DetectDocumentText` and async `StartDocumentTextDetection` modes

| | |
|--|--|
| **Pros** | Best accuracy available. Zero client-side model size. Works on any device that can render a canvas. ~1 second latency per page. |
| **Cons** | Recurring cost (~$0.0015/page). Privacy: your handwritten notes leave your machine. Requires server-side proxy (don't expose API key to the browser). Requires network. |
| **Best for** | A "Convert to text" button you press once per page. |
| **Effort** | ~2 days (server proxy + canvas-to-PNG + result merging). |

**At your usage scale** (245 notes today, growing): even at 10 conversions
per day, you'd never leave the $1500/month "first 5M pages" tier, so it'd
cost ~$0.45 / month. Cost is not a real concern; privacy might be.

### Option C — In-browser model

Run inference locally with WebAssembly / WebGPU. No data leaves the device.

**Tesseract.js** — wrong tool. Tesseract is trained on printed text and
performs poorly on cursive / messy handwriting. Skip.

**transformers.js + TrOCR-handwritten** — Microsoft's TrOCR model
fine-tuned on the IAM handwriting dataset, runnable via Hugging Face's
JS port of transformers.
- Model size: ~250 MB (base) or ~80 MB (small, lower accuracy)
- Cold start: 5–15 seconds on first load (cached after)
- Inference: 1–3 seconds per line on a modern laptop, 5–10s on iPad
- Quality: decent on neat print, mediocre on cursive — clearly behind
  Google's cloud model
- Requires line segmentation as a separate step (TrOCR works one line at
  a time)

**ONNX Runtime Web** — same idea, different runtime. Custom-trained models
possible but you'd have to bring one.

| | |
|--|--|
| **Pros** | Local, private, offline-capable. No cost. |
| **Cons** | 80–250 MB download. iPad battery hit. Recognition quality clearly below cloud. Requires segmentation pipeline you build yourself. iOS Safari WebGPU shipped in 18 but still rough. |
| **Best for** | Privacy-first users who write neatly and have desktop devices. |
| **Effort** | ~1–2 weeks (segmentation + UX for slow inference + caching). |

### Option D — MyScript iink SDK

The commercial standard. Used by Nebo, Samsung Notes, Wacom Bamboo.
Recognizes prose, math, diagrams, music notation. Has both a JS SDK
(REST + WS) and an offline iink runtime.

| | |
|--|--|
| **Pros** | **Best-in-class** quality. Math + diagrams + prose in one engine. Real-time recognition while you write. Live conversion / interactive ink. |
| **Cons** | Per-seat / per-app license, not transparent pricing — typically thousands of USD/year for indie. Vendor lock-in. Closed source. |
| **Best for** | If recognition is *the* feature and budget exists. |
| **Effort** | ~1 week (their SDK is well-documented). |

### Option E — Web Handwriting Recognition API (Chrome only)

`navigator.createHandwritingRecognizer({languages:['en']})` — feeds raw
stroke data (not images) to the OS recognizer (ChromeOS ML Service on
Chromebook; Windows Ink on Edge in theory).

| | |
|--|--|
| **Pros** | Native quality, zero download, structured stroke input. |
| **Cons** | **ChromeOS only in practice.** Not on iPad Safari (the device that matters for stylus). Not on Firefox. Spec is WICG draft (July 2025), not on caniuse. Dead-ish. |
| **Best for** | Nothing today. Worth a `feature detect → use if present` fallback layer, nothing more. |

---

## 3. How the leading apps actually do it

| App | Capture | Recognition |
|--|--|--|
| Apple Notes (Scribble) | Native iPadOS | Apple PencilKit + on-device CoreML, real-time |
| GoodNotes 6 | Native | Mix: on-device + AI-assisted cloud lookups |
| Notability | Native | On-device CoreML (Apple's recognizer) |
| OneNote | Native | Windows Ink Analyzer / cloud |
| Nebo | Native | **MyScript iink** under the hood |
| Notion | Web | **No handwriting recognition.** Pencil notes are images. |
| Obsidian | Web/Electron | Same — community plugins do cloud OCR only |
| Excalidraw | Web | Pure ink, no OCR |

**Pattern:** every app that recognizes handwriting well is either (a)
native using an OS API, or (b) licensing MyScript. Web apps with great UX
(Notion, Obsidian, Excalidraw) all punted on recognition.

---

## 4. Recommendation

Given UltraNote Lite is:
- A self-hosted PWA (no app store, no native shell)
- Used primarily by you (privacy posture is "my server, my data")
- Already low-frills and pragmatic
- Running on a small Node backend you control

I'd suggest a phased plan:

**Phase 1 — Ink capture, lossless (Option A)**

Add a "Sketch" note type. PointerEvents → canvas → SVG. Pressure-aware
strokes. Pen vs finger discrimination. Eraser button support. Saved as
a new field on the note (`note.ink: { strokes: [...] }`) so it round-trips
through your existing `/api/db` save flow without touching the schema in
breaking ways. Renders inline like an image.

This alone gives you 80% of the value (capture notes, sketch diagrams,
sign things) and ships in ~1 day. You can stop here.

**Phase 2 — Optional "Convert to text" button (Option B, Google Vision)**

When the user explicitly taps "Convert", render canvas to PNG, POST it to
a new server route `/api/ocr` that proxies to Google Vision with a key
you keep in `.env`. Insert the returned text into the note body, keep
the ink as an attachment for verification.

Why Google over Azure/AWS: best handwriting accuracy; same price; the
language hint `en-t-i0-handwrit` is the cleanest API for this exact
problem. EU endpoint exists if you ever want that.

Why a manual "Convert" button vs auto-OCR-on-save: cost predictability +
explicit user consent for the data leaving the device + lets you skim
the result before committing.

**Skip Phase 3 unless a real need appears.** TrOCR-in-browser and
MyScript are both overkill for personal note-taking volume. Revisit only
if (a) you decide you want zero cloud dependency or (b) recognition
quality on cursive becomes a daily blocker.

---

## 5. Open questions for you

Before I write any code:

1. **Privacy posture** — Are you OK sending handwritten note images to
   Google Cloud Vision on demand (for the "Convert" button), or do you
   want strictly local? If strictly local → Phase 1 only, no Phase 2.
2. **Primary device** — Is the stylus target an iPad with Apple Pencil,
   an Android tablet, or a Surface? (Changes nothing for capture; changes
   defaults for what `touch-action` and palm-rejection look like.)
3. **Math/diagrams?** — Plain prose only, or do you also want
   `∫ x²dx = x³/3` to recognize? Only MyScript handles math. If you need
   math, Phase 2 doesn't deliver it — we'd have to revisit Option D.
4. **Where does the ink live?** — Inline inside a normal note alongside
   text, or its own "Sketch" note type? (Affects render/UI not data.)

Once you answer these I can scope Phase 1 precisely (file list, lines of
code, where it slots into `app.js` and `server.js`) and we can ship.
