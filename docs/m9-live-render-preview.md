**Font note (2026-10-12):** This document describes a historical Noto Sans CJK private-preview sample. The updated GitHub Actions M9 renderer uses **Pretendard Bold v1.3.9**; a separate Pretendard smoke render was verified at 1080×1350 for all three slides with no overflow. The static CTA image is byte-identical. Existing linked historical samples are not retroactively changed.

# M9 news photo → code-rendered carousel: live-source private-preview smoke

Date: 2026-10-11. This is a **manual-input, code-based private preview** of actual October 10, 2026 news imagery. Not a production job or an automatic license clearance.

## Sources and actual photos

- Original article (Carrick): https://www.theguardian.com/football/2026/oct/10/michael-carrick-manchester-united-tottenham-roberto-de-zerbi
- Cover image: Michael Carrick; **Phil Noble/Reuters** via The Guardian. Verified actual served source photo: **1920×1536 JPEG**, obtained from Guardian page's own signed `srcsets` (not from Wikimedia or AI generation).
- Second article (match report): https://www.theguardian.com/football/2026/oct/10/manchester-united-tottenham-premier-league-match-report
- Body image: Dominic Solanke / Tottenham equaliser celebration; **Dave Thompson/AP** via The Guardian, **1920×1536 JPEG**, from the signed publisher `srcsets`.
- Actual publisher HTML test: each subject matched against the media **caption**, not only the news headline. Image dimensions were successfully read by the existing M9 image byte probe.

## Output and design contract

- `scripts/m9_render_news_deck.py`: Pillow renderer for approved Figma `COVER_NEWS v3` (`234:27150`) and `BODY_NEWS v1` (`234:27156`).
- 1P: Carrick real photo, single full-bleed source (no duplicate blurry side strip), lower dark fade, white/yellow two-line hook.
- 2P: real match photo, black 70% overlay, top-left original Figma ManUtd Editor logo, body and yellow highlight, bottom photo credit.
- 3P: original approved CTA PNG copied byte-for-byte. SHA256: `65d40cfa3421d343616eeb6d8412c1feac3aa1d051c3793f8086a0710ccfa88c`.
- Output for each slide **1080×1350 PNG**. Additional `manifest.json` lists photo URLs, article URLs, original dimensions, hashes, credit and unpublished/private-preview QA flags.

## Verified execution

- Deno 2.9.7 M9 tests: **29 passed / 0 failed**, including signed publisher `srcsets` extraction, subject metadata matching, real image byte/quality checks, CTA handling and Telegram mock adapter.
- Python Pillow render tests: **4 passed / 0 failed**, covering 3 PNG render outputs, immutable CTA bytes, too-small image rejection, headline overflow and unsafe source paths.
- Actual article HTML and two signed 1920px JPEG photo bytes fetched and processed in a controlled test sandbox. Cover and body and CTA images were generated successfully.
- The sample link responds 200 while the sandbox is running:
  - preview contact sheet: https://sb-3pqfy0tas96j.vercel.run/cards/preview_contact_sheet.jpg
  - package of 3 slides, source metadata, render code and README (no font files, no unmodified source photos): https://sb-3pqfy0tas96j.vercel.run/M9_real_Guardian_carousel_preview_20261011.zip

## Limits and next steps

- Photo publisher/agency redistribution rights remain **UNVERIFIED**, so this is an editorial/design preview only. Attribution or noncommercial intent does not by itself grant publication rights.
- Image-subject confirmation currently relies on caption metadata, and the full-bleed subject crop still requires visual QA. No face identification capability is claimed.
- Rendering currently consumes local selected photos and JSON, rather than the full automated discovery→Storage→renderer pipeline.
- Main production source discovery, grounding, Telegram Bot and Instagram publishing have **not** been changed or invoked.
- Next: renderer worker that consumes reviewed photo candidates, stores outputs in Supabase with idempotent job IDs, and sends owner-authorized Telegram previews for approval. Do not merge this draft before completing integration tests.

## Reproduction

Obtain suitably licensed/authorized local photographs and a Korean font available in your environment. Do not distribute font assets with this repository.

    python3 -m pip install Pillow
    python3 scripts/m9_render_news_deck.py --job article_job.json --output ./rendered --font /path/to/Korean-bold-font.otf --logo ./assets/logo.png --cta ./assets/cta.png

The JSON file must reference local photo filenames under its own directory. See the private-preview ZIP for the exact tested payload and source metadata.
