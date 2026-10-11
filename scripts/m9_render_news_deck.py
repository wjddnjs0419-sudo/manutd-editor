#!/usr/bin/env python3
"""Code-based ManUtd Editor cover/body carousel renderer — M9 private preview.

Uses previously approved Figma compositions (COVER_NEWS v3, BODY_NEWS v1).
No generative image model, no photo substitution or image search in this file.
Inputs are local, provenance-tracked, editorially selected real photographs.
This renderer is not a publication/licensing approval engine.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import shutil
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageOps

SIZE = (1080, 1350)
YELLOW = "#FAC600"
W, H = SIZE

def font(path: str, point_size: int) -> ImageFont.FreeTypeFont:
    if not Path(path).is_file():
        raise FileNotFoundError(f"Korean font file not found: {path}")
    return ImageFont.truetype(path, point_size)

def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()

def measure(draw: ImageDraw.ImageDraw, text: str, f: ImageFont.FreeTypeFont) -> int:
    box = draw.textbbox((0, 0), text, font=f)
    return box[2] - box[0]

def validate_photo(path: Path) -> Image.Image:
    if not path.is_file():
        raise FileNotFoundError(path)
    im = ImageOps.exif_transpose(Image.open(path)).convert("RGB")
    if min(im.size) < 900:
        raise ValueError(f"Source photo too small: {path.name} {im.size}")
    ratio = max(W / im.width, H / im.height)
    if ratio > 1.1:
        raise ValueError(f"Excessive upscaling for {path.name}: {ratio:.2f}")
    return im

def full_bleed(source: Image.Image, centering: tuple[float, float]) -> Image.Image:
    # One genuine source photo fills entire card; no blurred duplicate side strips.
    return ImageOps.fit(source, SIZE, method=Image.Resampling.LANCZOS,
                        centering=centering).convert("RGBA")

def render_cover(source: Image.Image, data: dict, face: ImageFont.FreeTypeFont) -> Image.Image:
    im = full_bleed(source, (float(data.get("cover_focus_x", 0.5)),
                             float(data.get("cover_focus_y", 0.36))))
    gradient = Image.new("RGBA", SIZE)
    painter = ImageDraw.Draw(gradient)
    for row in range(940, H):
        t = (row - 940) / (H - 940)
        opacity = round(min(249, (0.09 + 0.89 * (t ** 1.18)) * 255))
        painter.line((0, row, W, row), fill=(0, 0, 0, opacity))
    im = Image.alpha_composite(im, gradient)
    draw = ImageDraw.Draw(im)
    label = str(data.get("eyebrow", "■  MATCH  |  SOURCE")).strip()
    line_one = str(data["cover_line_one"]).strip()
    line_two = str(data["cover_line_two"]).strip()
    for text, size, y, color in (
        (label, 29, 1035, "#f4e5e5"),
        (line_one, 61, 1103, "#ffffff"),
        (line_two, 79, 1191, YELLOW),
    ):
        f = ImageFont.truetype(face.path, size)
        if measure(draw, text, f) > 998:
            raise ValueError(f"Cover text too long at {size}px: {text}")
        draw.text((40, y), text, font=f, fill=color)
    credit = str(data.get("cover_photo_credit", "")).strip()
    if credit:
        draw.text((40, 1311), credit[:100],
                  font=ImageFont.truetype(face.path, 16), fill="#dadada")
    return im

def wrap_text(draw: ImageDraw.ImageDraw, text: str, face: ImageFont.FreeTypeFont,
              max_width: int) -> list[str]:
    if measure(draw, text, face) <= max_width:
        return [text]
    lines: list[str] = []
    current = ""
    for char in text:
        if current and measure(draw, current + char, face) > max_width:
            lines.append(current)
            current = char
        else:
            current += char
    if current:
        lines.append(current)
    return lines

def render_body(source: Image.Image, data: dict, face: ImageFont.FreeTypeFont,
                logo_path: Path | None) -> Image.Image:
    im = full_bleed(source, (0.5, 0.5))
    im = Image.alpha_composite(im, Image.new("RGBA", SIZE, (0, 0, 0, 179)))
    draw = ImageDraw.Draw(im)
    headline = str(data["body_headline"]).strip()
    f80 = ImageFont.truetype(face.path, 80)
    if measure(draw, headline, f80) > 915:
        raise ValueError("BODY_NEWS headline overflow: shorten rather than shrink")
    draw.text((80, 168), headline, font=f80, fill="#ffffff")
    draw.rectangle((80, 324, 653, 326), fill="#d9d9d9")
    y = 375
    f40 = ImageFont.truetype(face.path, 40)
    for paragraph in data["body_paragraphs"]:
        if not paragraph:
            y += 35
            continue
        for line in wrap_text(draw, str(paragraph), f40, 916):
            draw.text((80, y), line, font=f40, fill="#ffffff")
            y += 62
        y += 9
    highlight = str(data.get("body_highlight", "")).strip()
    if highlight:
        y += 25
        f50 = ImageFont.truetype(face.path, 50)
        for line in wrap_text(draw, highlight, f50, 916):
            draw.text((80, y), line, font=f50, fill=YELLOW)
            y += 76
    if y > 1110:
        raise ValueError("BODY_NEWS content overflows safe text region")
    if logo_path:
        if not logo_path.is_file():
            raise FileNotFoundError(logo_path)
        logo = Image.open(logo_path).convert("RGBA")
        logo.thumbnail((86, 86), Image.Resampling.LANCZOS)
        im.alpha_composite(logo, (40, 40))
    draw = ImageDraw.Draw(im)
    f20 = ImageFont.truetype(face.path, 20)
    footer = "맨유 에디터 @manutd_editor"
    draw.text(((W - measure(draw, footer, f20)) // 2, 1286),
              footer, font=f20, fill="#d9d9d9")
    source_label = str(data.get("body_photo_credit", "")).strip()
    if source_label:
        if measure(draw, source_label, f20) > 960:
            raise ValueError("Source credit too long")
        draw.text((W - measure(draw, source_label, f20) - 50, 1130),
                  source_label, font=f20, fill="#d9d9d9")
    return im

def render(job: dict, workdir: Path, output_dir: Path,
           face_path: Path, logo_path: Path | None, cta_path: Path | None) -> dict:
    output_dir.mkdir(parents=True, exist_ok=True)
    for field in ("article_url", "article_published_at", "cover_line_one",
                  "cover_line_two", "body_headline", "body_paragraphs",
                  "cover_photo", "body_photo", "cover_photo_credit",
                  "body_photo_credit", "cover_photo_source", "body_photo_source"):
        if field not in job:
            raise ValueError(f"Required field missing: {field}")
    if not str(job["article_url"]).startswith("https://"):
        raise ValueError("Source article must be an HTTPS URL")
    face = font(str(face_path), 40)
    cover_photo = (workdir / str(job["cover_photo"])).resolve()
    body_photo = (workdir / str(job["body_photo"])).resolve()
    # Avoid using one input from outside trusted workdir.
    for file in (cover_photo, body_photo):
        if not file.is_relative_to(workdir.resolve()):
            raise ValueError("Photo path escapes job directory")
    coversrc = validate_photo(cover_photo)
    bodysrc = validate_photo(body_photo)
    output_files = []
    for number, kind, result in (
        (1, "COVER_NEWS", render_cover(coversrc, job, face)),
        (2, "BODY_NEWS", render_body(bodysrc, job, face, logo_path)),
    ):
        dest = output_dir / f"slide_{number:02d}_{kind.lower()}.png"
        result.convert("RGB").save(dest, "PNG", optimize=True)
        output_files.append({"slide_number": number, "kind": kind, "file": dest.name,
                             "width": W, "height": H})
    if cta_path:
        with Image.open(cta_path) as cta:
            if cta.size != SIZE:
                raise ValueError("CTA asset must be 1080x1350")
        dest = output_dir / "slide_03_cta.png"
        shutil.copyfile(cta_path, dest)  # Exact fixed CTA bytes reused, never regenerated.
        output_files.append({"slide_number": 3, "kind": "CTA",
                             "file": dest.name, "width": W, "height": H})
    report = {
        "state": "PRIVATE_PREVIEW_REQUIRES_REVIEW",
        "approval": {"visual_subject_crop": False, "image_reuse_rights": False,
                     "auto_publishing_allowed": False},
        "article_url": job["article_url"],
        "article_published_at": job["article_published_at"],
        "sources": [
            {"kind": "cover", "photo_url": job["cover_photo_source"],
             "credit": job["cover_photo_credit"],
             "article_url": job.get("cover_source_article_url", job["article_url"]),
             "sha256": sha256(cover_photo),
             "original_dimensions": list(coversrc.size)},
            {"kind": "body", "photo_url": job["body_photo_source"],
             "credit": job["body_photo_credit"],
             "article_url": job.get("body_source_article_url", job["article_url"]),
             "sha256": sha256(body_photo),
             "original_dimensions": list(bodysrc.size)}
        ],
        "slides": output_files
    }
    (output_dir / "manifest.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return report

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--job", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--font", required=True)
    parser.add_argument("--logo")
    parser.add_argument("--cta")
    args = parser.parse_args()
    job_path = Path(args.job).resolve()
    job = json.loads(job_path.read_text(encoding="utf-8"))
    report = render(job, job_path.parent, Path(args.output).resolve(),
                    Path(args.font), Path(args.logo) if args.logo else None,
                    Path(args.cta) if args.cta else None)
    print(json.dumps({"status": report["state"], "slides": report["slides"]},
                     ensure_ascii=False, indent=2))

if __name__ == "__main__":
    main()
