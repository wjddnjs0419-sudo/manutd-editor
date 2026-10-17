# M9 Photo Crop Validation

**Date:** 2026-10-12

**PR:** [#10](https://github.com/wjddnjs0419-sudo/manutd-editor/pull/10), remains Draft

**Local E2E output:** `/tmp/m9-photo-crop-e2e/run-002/slides`

## Local real-photo E2E

- Publisher source: TEAMtalk, article published 2026-10-11. The source URL, downloaded photo, article brief, fonts, and rendered cards remain local or are public source material; none are copied into this report or Git.
- Source photo: 1600×900, SHA-256 `749c1154693f82811805668ca1f4bb9e2a0b08f20c7ed9db7a3114f57dd194a8`.
- Metadata discovery returned 8 image candidates. Cover and body selection reused the same image bytes, so only one unique image was downloaded. Each role passed the first evaluated candidate.
- MediaPipe CPU detection returned one face-location box at confidence `0.941836`; this is location evidence only and does not establish identity.
- Both crops use normalized rectangle `(x=0.28625, y=0, width=0.45, height=1)` at `1.5×` enlargement. Face ROI sharpness measured `355.73` against the `20` basic-band minimum.
- Cover review flag: `UPSCALE_BASIC`. Body review flags: `UPSCALE_BASIC`, `FACE_OVERLAPS_BODY_TEXT`; the body role requires human review. The existing body text and its placement were preserved, and the reviewed card remained legible under the existing overlay.
- The output contains four news pages and the fixed CTA page, all `1080×1350`: `slide_01_cover_news.png`, `slide_02_body_news.png`, `slide_03_body_news.png`, `slide_04_body_news.png`, and `slide_05_cta.png`. The manifest, contact sheet, and crop audit are present.
- Manifest state is `PRIVATE_PREVIEW_REQUIRES_REVIEW`; visual-subject crop approval, image-reuse rights approval, and auto-publishing approval are all false.

## Approved assets

- Logo SHA-256: `fdbcbae71688899ace303a3c2801efbfd82668a5c2f993ef2060b7fd2395e562`.
- Pretendard Bold v1.3.9 SHA-256: `2e91915fab54df71cc9598ebf608b2bdb54c6fe3c066ac61dff0bc44fca71cc7`.
- Pretendard SemiBold v1.3.9 SHA-256: `c89bc43027dc7cde5726e96223376f8eec09302b2fc1f8147fd5b57cfc376118`.
- CTA was exported from the approved Figma frame `E25nG2ygwWaTkGjUQ8gQFK`, node `125:284`. The input and rendered `slide_05_cta.png` are byte-identical at 1,404,448 bytes with SHA-256 `a783796b5ee2279313899af9d3571bdad7b45c35c7b0fd0a8e85cb163c4e8e13`.
- The historical private Storage object hash in the existing renderer is different. Production Storage was not read, so equivalence with that stored object is unverified; the local run used the approved Figma frame export.

## Regression and workflow validation

- Python M9 suite: `74 passed`.
- Deno M9 suite: `38 passed`.
- Local generated-image CPU smoke passed using the hash-pinned model `b4578f35940bf5a1a655214a1cce5cab13eba73c1297cd78e1a04c2380b0152f`.
- Manual GitHub Actions CPU workflow: [run 38228596585](https://github.com/wjddnjs0419-sudo/manutd-editor/actions/runs/38228596585) passed in 47 seconds. The run installed and verified the Linux EGL/GLES runtime linkage, verified the model SHA, completed generated-image CPU inference, and passed both regression suites.

## Boundaries

- No isolated non-production Supabase Storage project was configured or found. Storage upload and re-download are untested.
- No Production Supabase or shared local database access, Telegram, Instagram, OpenAI, paid vision, or publishing action was used.
- Source photo, brief, CTA image, fonts, model, PNG pages, contact sheet, and crop audit remain outside Git. The shared Draft PR branch contains source, tests, workflow, plan, and this aggregate report only.
