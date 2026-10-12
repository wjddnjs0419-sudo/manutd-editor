# M9 Free Face Detection, Subject Crop, and Deck Generation Design

**Date:** 2026-10-12  
**Repository:** `wjddnjs0419-sudo/manutd-editor`  
**Target:** existing Draft PR #10, based on head `99f39126816715e42fbf879911982f56d66f99b9`

## Goal

Extend the existing M9 publisher-photo pipeline so it can select a usable source photo, locate visible faces without a paid vision service, crop a 1080×1350 FULL_BLEED card around the selected visual subject, and render a complete private-review PNG deck. Keep the current M6–M9 brief, source provenance, layout, and manual review boundaries.

## Current behavior and gaps

- `photo_quality.ts` gives landscape COVER_NEWS and BODY_NEWS photos 12 composition points, regardless of the resulting 4:5 crop.
- `m9_render_news_deck.py` rejects a photo when the calculated fit scale exceeds 1.10. A 1600×900 source needs 1.50× enlargement for a 1080×1350 crop when its full height is used.
- Deno gathers and metadata-ranks photo candidates, but `m9_acquire_photos.py` downloads only the selected candidate. Python cannot reject it for crop quality and try the next candidate.
- The renderer already supports one cover, multiple body slides, and a byte-identical supplied CTA asset. The private upload path accepts up to five news-slide PNGs; it must accommodate the existing cover plus up to five content slides.
- PR #10 is open and Draft. PR #8 and PR #9 remain unchanged. The active checkout contains unrelated uncommitted work, so implementation and artifacts use an isolated worktree at PR #10's approved head.

## Selected approach

Keep the existing TypeScript collection/security boundary and add a CPU-only visual evaluation stage in the Python pipeline. Do not move article parsing or host validation into Python, add a separate service, or add a person-detection model in this phase.

### Candidate collection and ranking

1. Deno continues to fetch publisher article pages, enforce exact image-host allowlists, probe image headers, and match candidate metadata against subject aliases. Metadata matches remain association evidence only; they do not establish visual identity or reuse rights.
2. Remove the landscape `+12` composition bonus. Rank by existing relevance/freshness evidence plus the projected 4:5 crop's effective output scale and available crop dimensions. TypeScript and Python read the same JSON crop-geometry policy so they use one target size, aspect ratio, and enlargement calculation. Keep the COVER_NEWS and BODY_NEWS slot contract and return the existing top-three shortlist per slot.
3. Python evaluates shortlisted candidates sequentially. It downloads only the candidate being evaluated, tries the next candidate after a failed quality/crop gate, and keeps the first candidate that passes. The maximum photo download attempts remain bounded by the existing three candidates per each of two slots.

### Face location and review state

- Use `mediapipe==1.1.0` with the MediaPipe Face Detector and the versioned BlazeFace short-range model. Use its face bounding boxes and confidence only. The model does not identify a person.
- Use the OpenCV dependency already required by MediaPipe for sharpness measurements; use Pillow for image validation, crop geometry, rendering, and PNG output. Pin all direct dependencies and the model artifact checksum in the implementation.
- Start without a separate person detector. If face detection returns no usable face, use an explicit manual focus coordinate when supplied. Otherwise create a safe centered crop candidate and mark it `REVIEW_REQUIRED`; do not record automatic subject-detection success.
- When several faces are present, automatically protect a face only when one is clearly dominant by visible size and the crop geometry can preserve it. Similar-sized or otherwise ambiguous faces return `REVIEW_REQUIRED`; never infer which detected face is the named player.
- Store detections and focus coordinates as normalized 0–1 values. Record the detection count, bounding boxes, confidence, chosen crop, scale, quality metrics, reason flags, and elapsed analysis time in the review manifest.

MediaPipe is selected because its Python task returns face bounding boxes and its official model card is Apache-2.0. BlazeFace is optimized for relatively large, forward-facing, close-range faces and explicitly does not cover people counting, turned-away faces, or backs of heads. Those conditions therefore use manual focus or review instead of a claim of successful detection. The model is a locator only.

### Crop and enlargement policy

- Define the source crop rectangle at the 4:5 target ratio, constrain it within the source bounds, preserve the source aspect ratio, and resize with the existing Pillow LANCZOS path. Never stretch an image.
- Place a single selected face with headroom and keep its box outside the cover's lower title band when feasible. Use the existing dark overlay for body slides; report overlap with body text regions for review without moving or resizing text.
- Existing explicit `cover_focus_x/y` values take priority over automatic cover focus. Add optional body focus coordinates to the existing media/render data so a manual body focus also takes priority; absent body focus keeps the current center default. When detection is unavailable, a supplied manual focus remains usable but is labeled manual.
- Compute effective enlargement from the actual crop rectangle, not from the original image aspect ratio alone. Permit 1.0–1.5× subject to basic image quality; permit 1.5–1.8× only after sharpness and crop checks; permit 1.8–2.0× only after stricter sharpness, face-size, and artifact checks. Keep a configurable default ceiling of 2.0×. Above 2.0×, reject the candidate and try the next one; if none pass, return `REVIEW_REQUIRED` with reasons.
- Combine effective scale, decoded dimensions, crop size, face size/confidence, and an OpenCV blur/sharpness measure. Do not accept or reject solely from one blur score. Keep exact geometry and quality thresholds in the shared JSON crop-policy configuration and expose applied thresholds in the manifest so test results can be audited.

### Rendering and delivery

- Reuse the current FULL_BLEED 1080×1350 cover/body renderer, gradient overlay, logo, Pretendard Bold/SemiBold files with SHA-256 checks, source credits, and exact static CTA PNG. Keep all current text sizes, line limits, page counts, content types, and CTA behavior.
- Use the selected cover photo on the cover and the selected body photo on the existing body-slide sequence. Do not introduce PHOTO_PANEL or alter the page-generation policy.
- Render cover + every current body slide + the existing CTA to a local review directory. Include ordered output entries and source/crop provenance in the manifest and create a contact sheet for inspection. Do not commit source photos or rendered images to Git.
- Expand the existing private upload filename guard to cover the maximum existing news slide set (cover plus five body slides). The shared CTA remains the existing exact Storage object and is not regenerated or overwritten.
- Verify upload and re-download only when an isolated non-production Supabase staging project and the approved CTA asset are available. Never point this validation at Production Supabase. If no staging project is available, finish and report local full-deck PNG generation and mark Storage verification untested.

## Runtime and cost boundary

- Run on `ubuntu-latest` with Python 3.11 and CPU only. Pin package versions, the model version and SHA-256, set a finite workflow timeout, and record candidate count, analysis time, total run time, and one workflow invocation per manual run.
- Keep the existing preview workflow manually dispatched. Do not enable a schedule, automatic Telegram delivery, or Instagram publishing. Do not call OpenAI or paid image-analysis/image-generation APIs.
- A GitHub Actions run is not required to upload anything. Use local rendering for the primary E2E artifact; a cloud CPU validation run may use a no-secret validation path. Do not trigger the production-backed upload path for this work.

## E2E and regression acceptance

Test centered, left, right, multiple-face, no-face, low-quality, 1.5×, 1.8–2.0×, >2.0×, and manual-focus cases. Tests must inspect crop output pixels/boxes and review flags, not only function return values. Use one real article and publisher-hosted source photo for the complete deck; keep it in a private local artifact directory and preserve URL, credit, and source hash. Do not describe synthetic or mock output as an actual article result.

The complete local deck must contain the cover, all body PNGs, and exact CTA in order; each page must be a 1080×1350 PNG. Inspect the rendered text bounds, credits, typography, selected crop, and contact sheet. A generated deck remains `PRIVATE_PREVIEW_REQUIRES_REVIEW`; passing code checks does not claim aesthetic approval, identity proof, or photo reuse rights.

Run focused M9 tests and repository regressions needed for the touched code. Do not run production migrations, modify Production Supabase or the shared local database, send Telegram, invoke real OpenAI generation, merge the PR, or change its Draft status.

## Out of scope

- New card-news system, new page types, or PHOTO_PANEL design.
- Human identity recognition, automatic publishing, or photo-rights approval.
- Separate person detection until real-photo results show face-only detection is insufficient.
- Typography, layout, content density, page-count, or CTA redesign.
- PR #8, PR #9, Telegram automation, Production Supabase, Instagram, or production rollout.

## References

- [MediaPipe Face Detector Python guide](https://developers.google.com/edge/mediapipe/solutions/vision/face_detector/python)
- [MediaPipe Face Detector overview and models](https://developers.google.com/edge/mediapipe/solutions/vision/face_detector)
- [BlazeFace short-range model card](https://storage.googleapis.com/mediapipe-assets/MediaPipe%20BlazeFace%20Model%20Card%20%28Short%20Range%29.pdf)
- [MediaPipe 1.1.0 package metadata and platform wheels](https://pypi.org/project/mediapipe/1.1.0/)
