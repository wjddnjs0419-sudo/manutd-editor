# M9 Free Subject Crop and Deck E2E Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Select and evaluate real publisher photos with free CPU face localization, produce subject-focused 1080×1350 M9 cards, and verify a complete private-review PNG deck.

**Architecture:** Keep Deno/TypeScript responsible for publisher-page collection, exact-host validation, metadata matching, and a three-photo shortlist. A Python CPU stage will analyze shortlisted image bytes, compute a crop and quality decision from one shared JSON policy, try the next candidate when needed, and feed the existing FULL_BLEED Pillow renderer. A manual no-secret GitHub Actions workflow will verify the pinned CPU runtime; a separate local E2E will use one real publisher article, its real photo, the existing approved CTA, and no production services.

**Tech Stack:** Deno 2, Python 3.11, MediaPipe Face Detector / BlazeFace short-range, OpenCV, Pillow 11.3.0, GitHub Actions Ubuntu CPU runner.

**Spec:** `docs/superpowers/specs/2026-10-12-m9-free-person-focused-crop-design.md`

## Global Constraints

- Use `mediapipe==1.1.0` and the MediaPipe Face Detector with the versioned BlazeFace short-range model; verify the downloaded model SHA-256.
- Use CPU only; do not call OpenAI Vision, paid vision services, or image-generation APIs for photo evaluation or crop generation.
- Keep the TypeScript article collection and exact publisher image-host allowlist; keep `COVER_NEWS` / `BODY_NEWS` and a maximum three-candidate Python evaluation shortlist per slot.
- Use one shared policy for the 1080×1350 target and crop scale: ordinary quality checks through 1.5×, stricter checks above 1.5× through 1.8×, strongest checks above 1.8× through 2.0×, and reject automatic selection above 2.0×.
- Store crop and face geometry in normalized 0–1 coordinates; face detection is location evidence only and never identifies a named player.
- Preserve 1080×1350 FULL_BLEED, all existing text, colors, overlays, logo, Pretendard Bold/SemiBold, credits, and the exact fixed CTA; do not add PHOTO_PANEL or change slide-count policy.
- Output remains `PRIVATE_PREVIEW_REQUIRES_REVIEW`; never infer reuse rights, identity proof, or publish approval.
- Keep PR #10 Draft; do not modify PR #8 or #9; do not use Production Supabase, the shared local database, Telegram delivery, Instagram, migrations, or merge.
- Keep real source photos and rendered PNGs out of Git. Use the existing private preview only when an isolated non-production staging project and approved CTA are available.

## Review Focus

- Corrupt bytes and EXIF-rotated source photos: reject invalid decodes and use displayed, orientation-correct dimensions (`test_corrupt_and_exif_rotated_sources`).
- A face clipped by an image edge or too small to protect: produce a bounded crop and require review when the face cannot be preserved (`test_edge_face_is_preserved_or_flagged`).
- Two similarly sized faces: keep both detections and require review instead of selecting one (`test_similar_faces_require_manual_review`).
- Manual focus at normalized boundaries and face overlap with body text: validate coordinates and expose overlap for review without changing text placement (`test_manual_focus_bounds_and_body_text_overlap`).
- Duplicate image URLs and a blocked/failed candidate before a valid fallback: preserve the host allowlist, avoid repeated downloads, and choose the first later passing candidate (`test_bounded_fallback_and_duplicate_download_cache`).

---

### Task 1: Share crop geometry policy and improve metadata shortlist ranking

**Files:**
- Create: `supabase/functions/_shared/m9/crop_policy.json`
- Modify: `supabase/functions/_shared/m9/photo_quality.ts`
- Test: `supabase/functions/tests/m9/photo_quality_test.ts`

**Interfaces:**
- Produces policy keys `target_width`, `target_height`, `max_enlargement`, `scale_bands`, `face_detection_min_confidence: 0.50`, and `dominant_face_area_ratio: 1.75`; Python reads this same file in Task 2.
- Produces `projectedCropScale(width: number, height: number): number` and `M9PhotoAssessment.projected_crop_scale: number | null`.
- Ranking retains the existing identity, freshness, source-relevance, review, rights, and shortlist fields. It removes the landscape-only `+12`; all photo slots use `min(12, max(0, 12 * (2 - projected_crop_scale)))` crop-fit points. An over-2× candidate remains visible to Python review rather than being treated as face-evaluated here.

- [x] **Step 1: Add failing policy and projected-crop tests.** Add `landscape1600x900ProjectsTo1_5x`, `native1080x1350ProjectsTo1x`, and `landscapeNoLongerGetsAspectBonus`; assert the 1600×900 4:5 crop scale is exactly 1.5, a native target is 1.0, and equivalent fit candidates receive the same crop score regardless of orientation.
- [x] **Step 2: Run the focused Deno test and confirm the new assertions fail.** Run: `deno test -A supabase/functions/tests/m9/photo_quality_test.ts`. Expected: FAIL only on missing crop policy/scale behavior.
- [x] **Step 3: Add the shared JSON policy and implement the TypeScript scale calculation and crop-fit score.** Use target aspect `1080 / 1350`; for landscape inputs crop to target aspect before calculating output enlargement. Preserve existing shortlist size and all security checks.
- [x] **Step 4: Run focused Deno tests.** Run: `deno test -A supabase/functions/tests/m9/photo_quality_test.ts supabase/functions/tests/m9/photo_harvest_test.ts`. Expected: PASS with the old article metadata and exact-host behavior unchanged.
- [x] **Step 5: Commit.** `git add supabase/functions/_shared/m9/crop_policy.json supabase/functions/_shared/m9/photo_quality.ts supabase/functions/tests/m9/photo_quality_test.ts && git commit -m "feat: rank M9 photos by 4x5 crop fit"`

### Task 2: Add CPU face localization, crop planning, and quality gates

**Files:**
- Create: `scripts/m9_photo_analysis.py`
- Create: `scripts/requirements-m9-crop.txt`
- Create: `scripts/tests/test_m9_photo_analysis.py`
- Modify: `supabase/functions/_shared/m9/crop_policy.json` only if empirical quality thresholds need calibration; keep one shared configuration.

**Interfaces:**
- `NormalizedFace(x: float, y: float, width: float, height: float, confidence: float)` uses normalized top-left plus size.
- `CropPlan(x: float, y: float, width: float, height: float, scale: float, focus_x: float, focus_y: float, review_required: bool, flags: tuple[str, ...])` describes a normalized source rectangle at 4:5; `(x, y)` is its normalized top-left.
- `PhotoEvaluation(faces: tuple[NormalizedFace, ...], face_count: int, crop: CropPlan, quality: dict[str, float], review_required: bool, flags: tuple[str, ...], analysis_ms: float)` is the JSON-ready analysis result.
- `FaceDetector.detect(image: Image.Image) -> list[NormalizedFace]`; production implementation is `MediaPipeFaceDetector(model_path: Path)` using IMAGE mode and minimum confidence from shared policy.
- `analyze_photo(image: Image.Image, role: Literal["cover", "body"], detector: FaceDetector, manual_focus: tuple[float, float] | None = None, policy: dict | None = None) -> PhotoEvaluation` uses EXIF-correct pixels, face ROI sharpness, crop scale, dimensions, and confidence together. No-face without manual focus yields a centered crop and `REVIEW_REQUIRED`; similar-sized faces yield review; a single clearly dominant face may be protected. Never return an identity label or person count.

- [x] **Step 1: Write failing geometry, detection-policy, and quality-band tests.** Add `test_center_left_right_faces_stay_inside_crop`, `test_face_box_and_focus_are_normalized`, `test_no_face_without_focus_is_review_required`, `test_manual_focus_overrides_detected_face`, `test_similar_faces_require_manual_review`, `test_single_dominant_face_may_be_protected`, `test_scale_bands_1_5_1_8_2_0_and_above_2`, `test_edge_face_is_preserved_or_flagged`, and `test_corrupt_and_exif_rotated_sources`. Use an injected fake detector and inspect actual crop pixel markers as well as returned flags.
- [x] **Step 2: Run the focused Python test and confirm failure.** Run: `python -m unittest discover -s scripts/tests -p 'test_m9_photo_analysis.py' -v`. Expected: FAIL because the analysis interfaces do not yet exist.
- [x] **Step 3: Implement normalized crop geometry, MediaPipe adapter, and combined quality gates.** Pin `mediapipe==1.1.0`, `Pillow==11.3.0`, `numpy==2.2.6`, and `opencv-contrib-python==4.11.0.86` in `scripts/requirements-m9-crop.txt`; verify the exact set with a Python 3.11 install and `pip check`. Fetch the official short-range model only at runtime, verify a fixed SHA-256 before use, and never commit the model. Calibrate and record face-ROI sharpness thresholds in the shared JSON using the real article image plus sharp/blurred controls; tests assert just-below and at-threshold outcomes. LANCZOS resize only; no stretching.
- [x] **Step 4: Run the focused Python tests and dependency consistency check.** Run: `python -m unittest discover -s scripts/tests -p 'test_m9_photo_analysis.py' -v` and `python -m pip check`. Expected: PASS; scale tiers, review states, crop bounds, and configured thresholds are explicit in analysis output.
- [x] **Step 5: Commit.** `git add scripts/m9_photo_analysis.py scripts/requirements-m9-crop.txt scripts/tests/test_m9_photo_analysis.py supabase/functions/_shared/m9/crop_policy.json && git commit -m "feat: add free M9 face crop analysis"`

### Task 3: Evaluate candidate shortlist with ordered fallback

**Files:**
- Modify: `scripts/m9_acquire_photos.py`
- Test: `scripts/tests/test_m9_acquire_photos.py`

**Interfaces:**
- Keep `choose_media(gathered, output, allowed_hosts, downloader=fetch_bounded_image)` and add injectable `detector` / analyzer for deterministic tests.
- Evaluate `row.shortlist` in current rank order (fall back to `[row.selected]` only for old `m9-media-v1` payloads); download and decode one item at a time, stop on first crop-quality pass, and never make more than three full-image downloads per slot.
- Each selected role entry in `media.json` retains source URL, article URL, credit, original SHA-256, rights and identity caveats, and adds `crop`, `faces`, `quality`, `analysis_ms`, `review_required`, and `review_flags`. A technically feasible no-face or ambiguous-face crop may be rendered for review with `review_required: true`; reject hard geometry/quality failures and continue. If every candidate fails, write top-level `selection_status: "REVIEW_REQUIRED"` with per-candidate rejection reasons and stop before rendering; never mark a failed candidate as selected.

- [x] **Step 1: Add failing candidate-order, quality fallback, metadata, and review-state tests.** Add `test_tries_next_candidate_when_crop_gate_fails`, `test_stops_after_first_passing_candidate`, `test_limits_full_downloads_to_three_per_slot`, `test_bounded_fallback_and_duplicate_download_cache`, and `test_all_candidates_failed_returns_review_reasons`; also retain the existing source hash, credit, rights, HTTPS, and subject-metadata assertions.
- [x] **Step 2: Run the focused Python acquisition test and confirm failure.** Run: `python -m unittest discover -s scripts/tests -p 'test_m9_acquire_photos.py' -v`. Expected: FAIL on shortlist fallback and analysis fields.
- [x] **Step 3: Integrate Task 2 analysis into the ordered acquisition loop.** Instantiate the real detector once in CLI `main`; keep exact-host validation and 12 MiB body limit; reuse bytes for duplicate URLs; write chosen source bytes and a provenance-preserving `media.json`. Catch candidate-level decode/quality rejection and continue; do not catch unsafe-host or manifest-contract failures as ordinary quality rejection.
- [x] **Step 4: Run acquisition and analysis tests.** Run: `python -m unittest discover -s scripts/tests -p 'test_m9_acquire_photos.py' -v` and `python -m unittest discover -s scripts/tests -p 'test_m9_photo_analysis.py' -v`. Expected: PASS; a failed first candidate cannot block a later valid one.
- [x] **Step 5: Commit.** `git add scripts/m9_acquire_photos.py scripts/tests/test_m9_acquire_photos.py && git commit -m "feat: fall back across M9 crop candidates"`

### Task 4: Apply selected crop in existing renderer and build visual review artifacts

**Files:**
- Modify: `scripts/m9_render_news_deck.py`
- Modify: `scripts/m9_preview_workflow.py`
- Test: `scripts/tests/test_m9_render_news_deck.py`
- Test: `scripts/tests/test_m9_preview_workflow.py`

**Interfaces:**
- `full_bleed(source, *, crop=None, centering=(0.5, 0.5))` accepts a validated normalized crop rectangle; when absent, preserves current cover/body centering defaults. It crops to the policy's exact 4:5 rectangle and resizes with Pillow LANCZOS.
- Keep existing `cover_focus_x/y` precedence; carry optional `body_focus_x/y` through `prepared_render_job`, with center as the body default. Manual focus recomputes crop placement and takes precedence over the detected focus; recompute crop-dependent metrics and review flags after a manual change.
- `manifest.json` includes selected crop, effective scale, normalized detections, quality thresholds/measurements, review flags, and ordered page files. The renderer emits a `contact_sheet.png` and a `crop_audit.png` in the local review output; the audit shows original image, crop bounds/face boxes, and resulting card thumbnails.

- [x] **Step 1: Add failing crop-pixel, manual-focus, slide-order, and audit tests.** Add `test_render_uses_crop_rectangle_not_center_fit`, `test_manual_cover_and_body_focus_override_detection`, `test_manual_focus_bounds_and_body_text_overlap`, and `test_contact_sheet_crop_audit_and_manifest_order`; assert each rendered news page and the exact CTA are 1080×1350, CTA bytes are unchanged, crop markers stay visible, and body text/layout coordinates remain unchanged.
- [x] **Step 2: Run focused renderer and preview tests and confirm failure.** Run: `python -m unittest discover -s scripts/tests -p 'test_m9_render_news_deck.py' -v` and `python -m unittest discover -s scripts/tests -p 'test_m9_preview_workflow.py' -v`. Expected: FAIL only on crop handoff, body focus, audit artifact, and manifest fields.
- [x] **Step 3: Pass crop metadata through the existing renderer and produce local audits.** Preserve all current type, typography, gradient, overlay, credit, logo, and fixed CTA code paths. Mark body text overlap for review without moving text. The contact sheet contains all existing cover/body/CTA pages in actual order; the crop audit contains only local source copies and normalized crop/detection geometry.
- [x] **Step 4: Run renderer and preview regressions.** Run both focused unittest discovery commands above. Expected: PASS with existing non-crop local preview behavior unchanged.
- [x] **Step 5: Commit.** `git add scripts/m9_render_news_deck.py scripts/m9_preview_workflow.py scripts/tests/test_m9_render_news_deck.py scripts/tests/test_m9_preview_workflow.py && git commit -m "feat: render M9 cards from subject crops"`

### Task 5: Add no-secret GitHub Actions CPU validation

**Files:**
- Create: `.github/workflows/m9-crop-cpu-validation.yml`
- Create: `scripts/m9_crop_cpu_smoke.py`
- Create: `scripts/tests/test_m9_crop_cpu_smoke.py`
- Modify: `scripts/requirements-m9-crop.txt` only for verified resolver pins.

**Interfaces:**
- Manual-only `workflow_dispatch`; `ubuntu-latest`, Python 3.11, Deno 2, CPU only, `timeout-minutes: 10`, no secrets, no Storage upload, no Telegram action, no public artifact upload. Install the Ubuntu `libegl1` and `libgles2` runtime libraries required by MediaPipe Tasks and check `libmediapipe.so` linkage before inference.
- The smoke command accepts an official model path and writes one compact metrics report: model SHA-256, runtime versions, model-load/inference milliseconds, image/candidate count, output status, and total elapsed seconds. Include only generated in-memory image inputs and safe aggregate timing in the Actions job summary.

- [x] **Step 1: Add failing smoke-report tests.** Add `test_report_has_versions_hash_and_timing` and `test_smoke_path_never_requires_credentials`; assert no source pixels, source URL, or credentials are written to the report.
- [x] **Step 2: Run the focused smoke test and confirm failure.** Run: `python -m unittest discover -s scripts/tests -p 'test_m9_crop_cpu_smoke.py' -v`. Expected: FAIL because the smoke command is missing.
- [x] **Step 3: Implement the CPU smoke command and manual workflow.** Pin all direct dependencies, model URL, and model checksum; install Python and required Ubuntu runtime dependencies on a clean Python 3.11 runner; verify native linkage; run smoke, focused Python M9 tests, and focused Deno M9 photo tests. Log a per-run duration summary and candidate bounds. Use no Supabase/Telegram/OpenAI/Instagram secrets or calls.
- [x] **Step 4: Run local smoke and workflow syntax checks.** Run: `python -m unittest discover -s scripts/tests -p 'test_m9_crop_cpu_smoke.py' -v`, `python scripts/m9_crop_cpu_smoke.py --help`, and validate the workflow YAML with the repository's available YAML parser. Expected: PASS locally; the workflow is `workflow_dispatch` only and all runtime pins/model SHA checks are explicit.
- [x] **Step 5: Commit.** `git add .github/workflows/m9-crop-cpu-validation.yml scripts/m9_crop_cpu_smoke.py scripts/requirements-m9-crop.txt scripts/tests/test_m9_crop_cpu_smoke.py && git commit -m "ci: add free M9 crop CPU validation"`

### Task 6: Run real-photo E2E, M9 regressions, and update Draft PR #10

**Files:**
- No source-photo or rendered-image files added to Git.
- If a local E2E report document is useful, create: `docs/m9-photo-crop-validation.md` with only aggregate results and reproducible commands; no private URLs, credentials, or image bytes.

**Interfaces:**
- Use the existing Gary Neville TEAMtalk source if it is still accessible and its `images.ps-aws.com` source photo remains valid. Otherwise use one verified real publisher article/photo with source URL and credit preserved in a private local output directory.
- Use a local brief derived from source-backed content and the approved exact CTA asset from its Figma source; do not fetch the CTA or brief from Production Supabase. Do not call OpenAI or Telegram.
- Final local artifact directory contains `slide_01...` cover, every existing body page, last fixed CTA, `manifest.json`, `contact_sheet.png`, and `crop_audit.png`. Report source hash, candidate/face/crop/review metrics, page count, and whether isolated staging Storage was available. Upload and re-download only if a non-production staging project and approved CTA are available.

- [x] **Step 1: Run all crop scenarios against rendered crop pixels and face boxes.** Run: `python -m unittest discover -s scripts/tests -p 'test_m9_*.py' -v`. Expected: PASS for centered/left/right, multi-face, no-face, low-quality, 1.5×, 1.8–2.0×, >2.0×, manual focus, and fallback cases.
- [x] **Step 2: Run repository M9 Deno regressions.** Run: `deno test -A supabase/functions/tests/m9`. Expected: PASS; photo URL trust, harvest, fixed CTA, identity caveats, and other M9 contracts stay intact.
- [x] **Step 3: Run the real publisher-photo local E2E with uploads and messaging disabled.** Run the existing local `m9_run_pipeline.py --brief-json ... --workdir ...` path with the approved image-host allowlist, verified Pretendard Bold/SemiBold assets, logo, and exact Figma CTA. Keep all source and PNG files in a private local artifact directory outside Git. Expected: one real article source, all ordered PNG pages at 1080×1350, unchanged CTA bytes, valid crop audit/manifest, and state `PRIVATE_PREVIEW_REQUIRES_REVIEW`.
- [x] **Step 4: Review real render artifacts and run the Actions CPU workflow.** Inspect `contact_sheet.png`, `crop_audit.png`, text/credit bounds, all slide dimensions, font hashes, and crop/review flags. Manually dispatch only the new no-secret CPU validation workflow. Expected: model checksum verification and CPU inference pass within ten minutes; no existing production-backed preview workflow is dispatched.
- [x] **Step 5: Check for isolated non-production staging.** If available, test private upload and re-download of news PNGs while keeping the exact CTA object read-only. Otherwise record Storage as untested and keep local E2E complete. Never query or write Production Supabase or the shared local database.
- [x] **Step 6: Verify integration boundaries and update the existing PR head.** Run `git diff --check`, verify working-tree scope excludes unrelated changes, confirm PR #10 still targets the intended base and remains Draft, and confirm PR #8/#9 are untouched. Push a fast-forward update to the existing PR #10 branch only; do not merge or change Draft state. Record latest commit SHA and test/Actions results in the task summary.

## Self-review coverage

- Shared scale policy and removal of landscape bonus: Task 1.
- Free CPU model, model integrity, face-only identity limits, crop math, and three enlargement tiers: Task 2.
- Ordered candidate retries, no-face review path, and manifest provenance: Task 3.
- Existing design, manual focus, body text overlap review, output order, and exact CTA reuse: Task 4.
- Reproducible GitHub Actions CPU path, runtime measurements, no secrets, and no paid API: Task 5.
- Real publisher-photo full deck, contact/crop audits, optional isolated Storage, regressions, Draft PR update, and forbidden-surface checks: Task 6.
- The tasks share policy and JSON contracts sequentially; a fresh reviewer should inspect the full branch after all dependent interfaces are implemented.
