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
import re
import shutil
from pathlib import Path
from PIL import Image, ImageColor, ImageDraw, ImageFont, ImageOps
from m9_photo_analysis import (
    CropPlan, NormalizedFace, analyze_photo, apply_crop, load_crop_policy,
)
from m9_content_policy import validate_exploration_slide_count

SIZE = (1080, 1350)
YELLOW = "#FAC600"
MUTD_RED = "#F04452"
W, H = SIZE
TYPE = {
    "cover_label": 26,
    "cover_headline": 94,
    "cover_highlight": 52,
    "body_headline": 70,
    "body_text": 43,
    "body_highlight": 45,
    "fact_stat": 96,
    "analysis_note": 38,
    "body_line_advance": 60,
    "paragraph_spacing": 16,
    "highlight_line_advance": 64,
    "text_margin": 80,
    "cover_text_margin": 40,
    "safe_text_bottom": 1110,
    "body_overlay_opacity": 179,
    "cover_gradient_start_y": round(H * 0.42),
    "cover_gradient_mid_y": round(H * 0.72),
    "cover_gradient_start_opacity": 0.0,
    "cover_gradient_mid_opacity": 0.45,
    "cover_gradient_end_opacity": 1.0,
}

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


def _relative_luminance(rgb: tuple[int, int, int]) -> float:
    channels = []
    for value in rgb:
        normalized = value / 255
        channels.append(normalized / 12.92 if normalized <= 0.04045 else ((normalized + 0.055) / 1.055) ** 2.4)
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]


def _contrast_ratio(image: Image.Image, bounds: tuple[int, int, int, int], foreground: str) -> float:
    x0, y0, x1, y1 = bounds
    samples = [image.getpixel((x, y))[:3] for y in range(max(0, y0), min(H, y1), 10)
               for x in range(max(0, x0), min(W, x1), 12)]
    if not samples:
        return 0.0
    background = max(_relative_luminance(tuple(pixel)) for pixel in samples)
    foreground_luminance = _relative_luminance(ImageColor.getrgb(foreground))
    lighter, darker = max(background, foreground_luminance), min(background, foreground_luminance)
    return (lighter + 0.05) / (darker + 0.05)

def validate_photo(path: Path, *, crop_metadata: bool = False) -> Image.Image:
    if not path.is_file():
        raise FileNotFoundError(path)
    with Image.open(path) as opened:
        im = ImageOps.exif_transpose(opened).convert("RGB")
    if im.width < 1 or im.height < 1 or im.width * im.height > 60_000_000:
        raise ValueError(f"Invalid source photo dimensions: {path.name} {im.size}")
    # Selected crops have already passed the shared Python geometry and quality
    # gates. Keep the legacy floor only for old jobs without crop metadata.
    if not crop_metadata and min(im.size) < 900:
        raise ValueError(f"Source photo too small: {path.name} {im.size}")
    ratio = max(W / im.width, H / im.height)
    if not crop_metadata and ratio > 1.1:
        raise ValueError(f"Excessive upscaling for {path.name}: {ratio:.2f}")
    return im

def _crop_plan(payload: dict, source_size: tuple[int, int]) -> CropPlan:
    if not isinstance(payload, dict):
        raise ValueError("M9_CROP_RECT_INVALID")
    try:
        x, y, width, height = (float(payload[key]) for key in ("x", "y", "width", "height"))
    except (KeyError, TypeError, ValueError):
        raise ValueError("M9_CROP_RECT_INVALID") from None
    if not all(math.isfinite(value) for value in (x, y, width, height)):
        raise ValueError("M9_CROP_RECT_INVALID")
    if width <= 0 or height <= 0 or x < 0 or y < 0 or x + width > 1.000001 or y + height > 1.000001:
        raise ValueError("M9_CROP_RECT_INVALID")
    source_width, source_height = source_size
    crop_width_px = int(round(width * source_width))
    crop_height_px = int(round(height * source_height))
    if crop_width_px < 1 or crop_height_px < 1:
        raise ValueError("M9_CROP_RECT_INVALID")
    try:
        focus_x = float(payload.get("focus_x", x + width / 2))
        focus_y = float(payload.get("focus_y", y + height / 2))
    except (TypeError, ValueError):
        raise ValueError("M9_CROP_FOCUS_INVALID") from None
    if not all(math.isfinite(value) and 0 <= value <= 1 for value in (focus_x, focus_y)):
        raise ValueError("M9_CROP_FOCUS_INVALID")
    target_aspect = W / H
    if abs(crop_width_px / crop_height_px - target_aspect) > 0.001:
        raise ValueError("M9_CROP_ASPECT_INVALID")
    scale = max(W / crop_width_px, H / crop_height_px)
    supplied_scale = payload.get("scale")
    if supplied_scale is not None:
        try:
            if not math.isfinite(float(supplied_scale)) or abs(float(supplied_scale) - scale) > 0.015:
                raise ValueError("M9_CROP_SCALE_MISMATCH")
        except (TypeError, ValueError):
            raise ValueError("M9_CROP_SCALE_MISMATCH") from None
    flags = payload.get("flags", [])
    if not isinstance(flags, list) or any(not isinstance(flag, str) for flag in flags):
        raise ValueError("M9_CROP_FLAGS_INVALID")
    review_required = payload.get("review_required", False)
    if not isinstance(review_required, bool):
        raise ValueError("M9_CROP_REVIEW_INVALID")
    return CropPlan(
        x=x, y=y, width=width, height=height, scale=scale,
        focus_x=focus_x, focus_y=focus_y,
        review_required=review_required,
        flags=tuple(flags),
    )


def full_bleed(source: Image.Image, *, crop: dict | CropPlan | None = None,
               centering: tuple[float, float] = (0.5, 0.5)) -> Image.Image:
    # One genuine source photo fills entire card; no blurred duplicate side strips.
    if crop is not None:
        payload = ({"x": crop.x, "y": crop.y, "width": crop.width, "height": crop.height,
                    "scale": crop.scale, "focus_x": crop.focus_x, "focus_y": crop.focus_y,
                    "review_required": crop.review_required, "flags": list(crop.flags)}
                   if isinstance(crop, CropPlan) else crop)
        plan = _crop_plan(payload, source.size)
        return apply_crop(source, plan, SIZE).convert("RGBA")
    return ImageOps.fit(source, SIZE, method=Image.Resampling.LANCZOS,
                        centering=centering).convert("RGBA")


def _clean_source_markup(text: object) -> tuple[str, bool]:
    """Remove citations and URLs from visible copy without editing its claims."""
    original = str(text or "")
    visible_lines: list[str] = []
    for raw_line in original.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if re.match(r"^(?:출처|원문|source(?:\s+url)?|reference)\s*[:：]", line, re.IGNORECASE):
            continue
        line = re.sub(r"\s*(?:[|｜·•]\s*)?(?:출처|원문|source|reference)\s*[:：].*$", "", line,
                      flags=re.IGNORECASE)
        line = re.sub(r"https?://\S+", "", line, flags=re.IGNORECASE)
        line = re.sub(r"\s*[|｜·•]\s*$", "", line)
        line = re.sub(r"\s+", " ", line).strip()
        if line:
            visible_lines.append(line)
    visible = "\n".join(visible_lines)
    return visible, visible != original.strip()


def _source_label(data: dict) -> str:
    publisher = str(data.get("source_publisher") or "").strip()
    if not publisher:
        from urllib.parse import urlsplit
        publisher = (urlsplit(str(data.get("article_url") or "")).hostname or "").removeprefix("www.")
    return f"SOURCE: {publisher}" if publisher else "SOURCE: ORIGINAL ARTICLE"


def _cover_gradient_mask() -> Image.Image:
    """A smooth alpha ramp: clear at 42%, 45% at 72%, black at the bottom."""
    start = TYPE["cover_gradient_start_y"]
    middle = TYPE["cover_gradient_mid_y"]
    end = H - 1
    alpha = Image.new("L", SIZE, 0)
    draw = ImageDraw.Draw(alpha)
    for y in range(start, H):
        if y <= middle:
            amount = (y - start) / max(1, middle - start)
            opacity = TYPE["cover_gradient_mid_opacity"] * amount
        else:
            amount = (y - middle) / max(1, end - middle)
            opacity = TYPE["cover_gradient_mid_opacity"] + (
                TYPE["cover_gradient_end_opacity"] - TYPE["cover_gradient_mid_opacity"]
            ) * amount
        draw.line((0, y, W, y), fill=round(min(1.0, max(0.0, opacity)) * 255))
    return alpha


def _apply_cover_gradient(image: Image.Image) -> Image.Image:
    layer = Image.new("RGBA", SIZE, (0, 0, 0, 0))
    layer.putalpha(_cover_gradient_mask())
    return Image.alpha_composite(image, layer)


def _display_crop(crop: dict | None, source_size: tuple[int, int], faces: list[dict],
                  offset_x: float) -> dict | None:
    """Pan within the approved crop while keeping detected subjects in frame."""
    if not isinstance(crop, dict) or abs(offset_x) < 0.0001:
        return crop
    x = float(crop["x"])
    y = float(crop["y"])
    width = float(crop["width"])
    height = float(crop["height"])
    minimum = 0.0
    maximum = max(0.0, 1.0 - width)
    if faces:
        face_left = min(float(face["x"]) for face in faces)
        face_right = max(float(face["x"]) + float(face["width"]) for face in faces)
        margin = 0.02
        minimum = max(minimum, face_right + margin - width)
        maximum = min(maximum, face_left - margin)
    if minimum > maximum:
        return crop
    x = min(maximum, max(minimum, x + offset_x))
    source_width, source_height = source_size
    scale = max(W / max(1, round(width * source_width)), H / max(1, round(height * source_height)))
    result = {**crop, "x": x, "scale": scale,
              "focus_x": min(1.0, max(0.0, x + width / 2)),
              "focus_y": min(1.0, max(0.0, y + height / 2)),
              "flags": list(crop.get("flags", []))}
    return result

class _StoredFaceDetector:
    def __init__(self, faces: list[NormalizedFace]):
        self.faces = faces

    def detect(self, image: Image.Image) -> list[NormalizedFace]:
        return list(self.faces)


def _stored_faces(data: dict, role: str) -> list[NormalizedFace]:
    rows = data.get(f"{role}_faces", [])
    if not isinstance(rows, list):
        raise ValueError("M9_FACE_METADATA_INVALID")
    faces = []
    try:
        for row in rows:
            if not isinstance(row, dict):
                raise ValueError
            face = NormalizedFace(*(float(row[key]) for key in
                                    ("x", "y", "width", "height", "confidence")))
            if not all(math.isfinite(value) for value in
                       (face.x, face.y, face.width, face.height, face.confidence)):
                raise ValueError
            if (face.x < 0 or face.y < 0 or face.width <= 0 or face.height <= 0
                    or face.x + face.width > 1.000001 or face.y + face.height > 1.000001
                    or not 0 <= face.confidence <= 1):
                raise ValueError
            faces.append(face)
    except (KeyError, TypeError, ValueError):
        raise ValueError("M9_FACE_METADATA_INVALID") from None
    return faces


def _manual_focus(data: dict, role: str) -> tuple[float, float] | None:
    x_key, y_key = f"{role}_focus_x", f"{role}_focus_y"
    if x_key not in data and y_key not in data:
        return None
    defaults = (0.5, 0.36) if role == "cover" else (0.5, 0.5)
    try:
        focus = (float(data.get(x_key, defaults[0])), float(data.get(y_key, defaults[1])))
    except (TypeError, ValueError):
        raise ValueError("M9_MANUAL_FOCUS_INVALID") from None
    if not all(math.isfinite(value) for value in focus):
        raise ValueError("M9_MANUAL_FOCUS_INVALID")
    if not all(0 <= value <= 1 for value in focus):
        raise ValueError("M9_MANUAL_FOCUS_OUT_OF_BOUNDS")
    return focus


def _photo_state(source: Image.Image, data: dict, role: str) -> dict:
    faces = _stored_faces(data, role)
    raw_crop = data.get(f"{role}_crop")
    manual_focus = _manual_focus(data, role)
    if manual_focus is not None or (raw_crop is None and faces):
        evaluation = analyze_photo(source, role, _StoredFaceDetector(faces), manual_focus=manual_focus)
        crop = evaluation.crop
        crop_data = {
            "x": crop.x, "y": crop.y, "width": crop.width, "height": crop.height,
            "scale": crop.scale, "focus_x": crop.focus_x, "focus_y": crop.focus_y,
            "review_required": crop.review_required, "flags": list(crop.flags),
        }
        return {
            "crop": crop_data, "scale": crop.scale,
            "faces": [vars(face) for face in evaluation.faces],
            "quality": evaluation.quality,
            "review_required": evaluation.review_required,
            "review_flags": list(evaluation.flags),
            "analysis_ms": evaluation.analysis_ms,
            "manual_focus": ({"x": manual_focus[0], "y": manual_focus[1]}
                             if manual_focus is not None else None),
            "text_bounds": [], "text_overlap": False,
        }

    crop = _crop_plan(raw_crop, source.size) if raw_crop is not None else None
    crop_data = ({
        "x": crop.x, "y": crop.y, "width": crop.width, "height": crop.height,
        "scale": crop.scale, "focus_x": crop.focus_x, "focus_y": crop.focus_y,
        "review_required": crop.review_required, "flags": list(crop.flags),
    } if crop else None)
    quality = data.get(f"{role}_quality", {})
    if not isinstance(quality, dict):
        raise ValueError("M9_QUALITY_METADATA_INVALID")
    flags = data.get(f"{role}_review_flags", list(crop.flags) if crop else [])
    if not isinstance(flags, list) or any(not isinstance(flag, str) for flag in flags):
        raise ValueError("M9_REVIEW_FLAGS_INVALID")
    review_required = bool(data.get(f"{role}_review_required", False)) or bool(
        crop.review_required if crop else True
    )
    if crop is None and "CROP_ANALYSIS_UNAVAILABLE" not in flags:
        flags = [*flags, "CROP_ANALYSIS_UNAVAILABLE"]
    return {
        "crop": crop_data, "scale": crop.scale if crop else quality.get("crop_scale"),
        "faces": [vars(face) for face in faces], "quality": quality,
        "review_required": review_required or crop is None,
        "review_flags": list(dict.fromkeys(flags)),
        "analysis_ms": data.get(f"{role}_analysis_ms"),
        "manual_focus": None, "text_bounds": [], "text_overlap": False,
    }


def render_cover(source: Image.Image, data: dict, face: ImageFont.FreeTypeFont,
                 photo_state: dict | None = None,
                 logo_path: Path | None = None) -> Image.Image:
    selected_crop = (photo_state.get("render_crop") or photo_state.get("crop")) if photo_state else None
    im = full_bleed(source, crop=selected_crop,
                    centering=(float(data.get("cover_focus_x", 0.5)),
                               float(data.get("cover_focus_y", 0.36))))
    im = _apply_cover_gradient(im)
    draw = ImageDraw.Draw(im)
    text_bounds: list[dict] = []
    label, _ = _clean_source_markup(data.get("eyebrow", "맨유 에디터 · 경기 브리핑"))
    line_one, _ = _clean_source_markup(data["cover_line_one"])
    line_two, _ = _clean_source_markup(data.get("cover_line_two", ""))
    title_font = ImageFont.truetype(face.path, TYPE["cover_headline"])
    support_font = ImageFont.truetype(face.path, TYPE["cover_highlight"])
    title_lines = wrap_text(draw, line_one, title_font, 1000) if line_one else []
    support_lines = wrap_text(draw, line_two, support_font, 1000) if line_two else []
    if len(title_lines) + len(support_lines) > 2:
        raise ValueError("Cover hook too long for two readable lines")

    def draw_cover(text: str, origin: tuple[int, int], text_font: ImageFont.FreeTypeFont,
                   color: str, kind: str) -> None:
        bounds = draw.textbbox(origin, text, font=text_font)
        if bounds[0] < 0 or bounds[1] < 0 or bounds[2] > W or bounds[3] > H:
            raise ValueError("M9_COVER_TEXT_BOUNDING_BOX_INVALID")
        contrast = _contrast_ratio(im, bounds, color)
        if contrast < 3.0:
            raise ValueError("M9_COVER_TEXT_CONTRAST_TOO_LOW")
        draw.text(origin, text, font=text_font, fill=color)
        text_bounds.append({"kind": kind, "origin": list(origin), "bounds": list(bounds),
                            "contrast_ratio": round(contrast, 2)})

    if logo_path:
        if not logo_path.is_file():
            raise FileNotFoundError(logo_path)
        with Image.open(logo_path) as opened:
            logo = opened.convert("RGBA")
        logo.thumbnail((104, 104), Image.Resampling.LANCZOS)
        im.alpha_composite(logo, (40, 40))
    if label:
        label_font = ImageFont.truetype(face.path, TYPE["cover_label"])
        draw_cover(label[:48], (TYPE["cover_text_margin"], 950), label_font, "#f1eeee", "eyebrow")
    title_y = 1010 if len(title_lines) + len(support_lines) > 1 else 1050
    for line in title_lines:
        draw_cover(line, (TYPE["cover_text_margin"], title_y), title_font, "#ffffff", "headline")
        title_y += 104
    for line in support_lines:
        draw_cover(line, (TYPE["cover_text_margin"], title_y), support_font, MUTD_RED, "highlight")
        title_y += 72
    source_font = ImageFont.truetype(face.path, 22)
    source = _source_label(data)
    draw_cover(source, (TYPE["cover_text_margin"], 1295), source_font, "#dedede", "source")
    data["_rendered_cover_text_bounds"] = text_bounds
    return im

def wrap_text(draw: ImageDraw.ImageDraw, text: str, face: ImageFont.FreeTypeFont,
              max_width: int) -> list[str]:
    if measure(draw, text, face) <= max_width:
        return [text]
    lines: list[str] = []
    current = ""
    # Prefer Korean word boundaries, while still splitting long unspaced runs
    # safely when a publisher sentence contains a long name or URL-like token.
    for word in re.findall(r"\S+\s*", text):
        if measure(draw, current + word, face) <= max_width:
            current += word
            continue
        if current.strip():
            lines.append(current.rstrip())
            current = ""
        token = word
        while token and measure(draw, token, face) > max_width:
            piece = ""
            while token and measure(draw, piece + token[0], face) <= max_width:
                piece += token[0]
                token = token[1:]
            if not piece:
                raise ValueError("M9_TEXT_GLYPH_EXCEEDS_WIDTH")
            lines.append(piece)
        current = token
    if current.strip():
        lines.append(current.rstrip())
    return lines

def render_body(source: Image.Image, data: dict, face: ImageFont.FreeTypeFont,
                logo_path: Path | None, heading_face: ImageFont.FreeTypeFont | None = None,
                photo_state: dict | None = None) -> Image.Image:
    selected_crop = ((photo_state.get("render_crop") or photo_state.get("crop"))
                     if photo_state else None)
    centering = data.get("photo_centering", (0.5, 0.5))
    im = full_bleed(source, crop=selected_crop, centering=centering)
    role = str(data.get("role") or "BODY").strip().upper()
    template = {"KEY_FACT": "FACT", "CONTEXT": "CONTEXT", "IMPLICATION": "ANALYSIS"}.get(role, "CONTEXT")
    overlay_top, overlay_bottom = {
        "FACT": (0.42, 0.68),
        "CONTEXT": (0.52, 0.74),
        "ANALYSIS": (0.48, 0.78),
    }[template]
    overlay = Image.new("RGBA", SIZE, (0, 0, 0, 0))
    alpha = Image.new("L", SIZE, 0)
    alpha_draw = ImageDraw.Draw(alpha)
    for row in range(H):
        value = overlay_top + (overlay_bottom - overlay_top) * row / max(1, H - 1)
        alpha_draw.line((0, row, W, row), fill=round(value * 255))
    overlay.putalpha(alpha)
    im = Image.alpha_composite(im, overlay)
    draw = ImageDraw.Draw(im)
    text_bounds: list[dict] = []

    def draw_content(text: str, origin: tuple[int, int], text_font: ImageFont.FreeTypeFont,
                     fill: str, kind: str) -> None:
        bounds = draw.textbbox(origin, text, font=text_font)
        contrast = _contrast_ratio(im, bounds, fill)
        if contrast < 3.0:
            raise ValueError("M9_BODY_TEXT_CONTRAST_TOO_LOW")
        draw.text(origin, text, font=text_font, fill=fill)
        text_bounds.append({
            "kind": kind, "origin": [origin[0], origin[1]],
            "bounds": list(bounds), "contrast_ratio": round(contrast, 2),
        })

    headline, headline_cleaned = _clean_source_markup(data["body_headline"])
    if not headline:
        raise ValueError("M9_BODY_HEADLINE_REQUIRED")
    content_width = 430
    headline_size = {"FACT": 48, "CONTEXT": 50, "ANALYSIS": 54}[template]
    headline_lines: list[str] = []
    heading_font = face
    for candidate_size in range(headline_size, 37, -2):
        candidate = ImageFont.truetype((heading_face or face).path, candidate_size)
        candidate_lines = wrap_text(draw, headline, candidate, content_width)
        if len(candidate_lines) <= 2:
            heading_font, headline_lines = candidate, candidate_lines
            break
    if not headline_lines:
        raise ValueError("BODY_NEWS headline too long for two readable lines")
    paragraphs = []
    source_markup_removed = headline_cleaned
    for value in data.get("body_paragraphs", []):
        cleaned, changed = _clean_source_markup(value)
        source_markup_removed = source_markup_removed or changed
        if cleaned:
            paragraphs.append(cleaned)
    source_body = data.get("source_body")
    if not isinstance(source_body, str):
        source_body = "\n".join(str(value) for value in data.get("body_paragraphs", []))
    visible_body = "\n".join(paragraphs)
    highlight_source = data.get("source_highlight", data.get("body_highlight", ""))
    highlight, highlight_cleaned = _clean_source_markup(data.get("body_highlight", ""))
    source_markup_removed = source_markup_removed or highlight_cleaned
    closing_source = str(data.get("closing_line") or "")
    closing_line, closing_cleaned = _clean_source_markup(closing_source)
    source_markup_removed = source_markup_removed or closing_cleaned

    sentence_text = " ".join(paragraphs)
    sentence_count = len(re.findall(r"[.!?。](?=[\s\"'”’」』)\]]|$)", sentence_text))
    content_review_flags: list[str] = []
    if sentence_count > 2:
        content_review_flags.append("BODY_SENTENCE_LIMIT_REVIEW")

    tag_font = ImageFont.truetype(face.path, 24)
    draw.rectangle((TYPE["text_margin"], 205, TYPE["text_margin"] + 7, 241), fill=MUTD_RED)
    tag = {"FACT": "KEY FACT", "CONTEXT": "MATCH CONTEXT", "ANALYSIS": "IMPLICATION · ANALYSIS"}[template]
    draw_content(tag, (TYPE["text_margin"] + 24, 204), tag_font, "#ffffff", "template_label")

    if template == "FACT":
        headline_y, content_y, body_font_size, highlight_y_gap = 300, 650, 29, 12
        highlight_font_size, highlight_line_advance = 34, 40
    elif template == "ANALYSIS":
        headline_y, content_y, body_font_size, highlight_y_gap = 300, 500, 34, 24
        highlight_font_size, highlight_line_advance = TYPE["body_highlight"], TYPE["highlight_line_advance"]
    else:
        headline_y, content_y, body_font_size, highlight_y_gap = 300, 500, 36, 24
        highlight_font_size, highlight_line_advance = TYPE["body_highlight"], TYPE["highlight_line_advance"]

    heading_y = headline_y
    for line in headline_lines:
        draw_content(line, (TYPE["text_margin"], heading_y), heading_font, "#ffffff", "headline")
        heading_y += heading_font.size + 10

    if template == "FACT":
        stat, stat_cleaned = _clean_source_markup(data.get("stat_emphasis", ""))
        source_markup_removed = source_markup_removed or stat_cleaned
        if stat:
            stat_font = ImageFont.truetype((heading_face or face).path, 74)
            stat_lines = wrap_text(draw, stat, stat_font, content_width)
            if len(stat_lines) > 1:
                stat_font = ImageFont.truetype((heading_face or face).path, 62)
                stat_lines = wrap_text(draw, stat, stat_font, content_width)
            if len(stat_lines) > 2:
                stat_font = ImageFont.truetype((heading_face or face).path, 52)
                stat_lines = wrap_text(draw, stat, stat_font, content_width)
            if len(stat_lines) > 2:
                raise ValueError("M9_FACT_STAT_TOO_LONG")
            stat_y = max(450, heading_y + 18)
            for line in stat_lines:
                origin = (TYPE["text_margin"] + 16, stat_y)
                bounds = draw.textbbox(origin, line, font=stat_font)
                panel = (bounds[0] - 12, bounds[1] - 8, bounds[2] + 12, bounds[3] + 8)
                draw.rounded_rectangle(panel, radius=16, fill=MUTD_RED)
                draw_content(line, origin, stat_font, "#ffffff", "stat")
                stat_y = bounds[3] + 20
            content_y = max(content_y, stat_y + 12)

    if template == "CONTEXT":
        draw.rectangle((TYPE["text_margin"], heading_y + 12, TYPE["text_margin"] + 72, heading_y + 17), fill=MUTD_RED)

    body_font = ImageFont.truetype(face.path, body_font_size)
    wrapped_paragraphs = [wrap_text(draw, value, body_font, content_width) for value in paragraphs]
    line_count = sum(len(lines) for lines in wrapped_paragraphs)
    if line_count > 6:
        content_review_flags.append("BODY_DENSITY_REVIEW")
    y = max(content_y, heading_y + 36)
    line_advance = body_font_size + (7 if template == "FACT" else 16)
    paragraph_gap = 12 if template == "CONTEXT" else (0 if template == "FACT" else 8)
    for paragraph_index, lines in enumerate(wrapped_paragraphs):
        for line in lines:
            draw_content(line, (TYPE["text_margin"], y), body_font, "#ffffff", "paragraph")
            y += line_advance
        if paragraph_index < len(wrapped_paragraphs) - 1:
            y += paragraph_gap

    if highlight:
        y += highlight_y_gap
        highlight_font = ImageFont.truetype((heading_face or face).path, highlight_font_size)
        for line in wrap_text(draw, highlight, highlight_font, content_width):
            draw_content(line, (TYPE["text_margin"], y), highlight_font, MUTD_RED, "highlight")
            y += highlight_line_advance
    visible_closing_line = ""
    if template == "ANALYSIS" and closing_line:
        note_top = max(y + 24, 880)
        note_x = TYPE["text_margin"] + 22
        selected_note: tuple[ImageFont.FreeTypeFont, list[tuple[str, int]]] | None = None
        source_paragraphs = [part for part in closing_line.splitlines() if part.strip()]
        for point_size in range(TYPE["analysis_note"], 21, -2):
            candidate_font = ImageFont.truetype(face.path, point_size)
            candidate_lines = [
                wrapped
                for paragraph in source_paragraphs
                for wrapped in wrap_text(draw, paragraph, candidate_font, content_width - 22)
            ]
            cursor = note_top + 48
            positions: list[tuple[str, int]] = []
            fits = bool(candidate_lines)
            for line in candidate_lines:
                bounds = draw.textbbox((note_x, cursor), line, font=candidate_font)
                if bounds[3] > TYPE["safe_text_bottom"]:
                    fits = False
                    break
                positions.append((line, cursor))
                cursor = max(cursor + candidate_font.size + 8, bounds[3] + 8)
            if fits:
                selected_note = (candidate_font, positions)
                break
        if selected_note is None:
            content_review_flags.append("ANALYSIS_NOTE_REVIEW")
        else:
            analysis_font, note_lines = selected_note
            draw.rectangle((TYPE["text_margin"], note_top, TYPE["text_margin"] + 5,
                            note_top + 52), fill=MUTD_RED)
            draw_content("해석", (TYPE["text_margin"] + 22, note_top - 2), tag_font,
                         MUTD_RED, "analysis_label")
            for line, line_y in note_lines:
                draw_content(line, (note_x, line_y), analysis_font, "#ffffff", "analysis_note")
            visible_closing_line = closing_line
    if any(box["bounds"][0] < 0 or box["bounds"][1] < 0 or
           box["bounds"][2] > W or box["bounds"][3] > TYPE["safe_text_bottom"]
           for box in text_bounds):
        raise ValueError("BODY_NEWS text bounding box outside safe region")
    if y > TYPE["safe_text_bottom"]:
        raise ValueError("BODY_NEWS content overflows safe text region")
    if source_markup_removed:
        content_review_flags.append("SOURCE_MARKUP_REMOVED_FOR_VISUALS")
    if logo_path:
        if not logo_path.is_file():
            raise FileNotFoundError(logo_path)
        with Image.open(logo_path) as opened:
            logo = opened.convert("RGBA")
        logo.thumbnail((104, 104), Image.Resampling.LANCZOS)
        im.alpha_composite(logo, (40, 40))
    draw = ImageDraw.Draw(im)
    source_font = ImageFont.truetype(face.path, 22)
    source_label = _source_label(data)
    source_origin = (TYPE["text_margin"], 1295)
    source_bounds = draw.textbbox(source_origin, source_label, font=source_font)
    if source_bounds[0] < 0 or source_bounds[1] < 0 or source_bounds[2] > W or source_bounds[3] > H:
        raise ValueError("M9_BODY_SOURCE_BOUNDING_BOX_INVALID")
    source_contrast = _contrast_ratio(im, source_bounds, "#dedede")
    if source_contrast < 3.0:
        raise ValueError("M9_BODY_TEXT_CONTRAST_TOO_LOW")
    draw.text(source_origin, source_label, font=source_font, fill="#dedede")
    text_bounds.append({"kind": "source", "origin": list(source_origin), "bounds": list(source_bounds),
                        "contrast_ratio": round(source_contrast, 2)})
    data["_rendered_text_bounds"] = text_bounds
    data["_content_review_flags"] = list(dict.fromkeys(content_review_flags))
    data["_rendered_content"] = {
        "role": role,
        "layout_template": template,
        "source_headline": data.get("source_headline", data["body_headline"]),
        "source_body": source_body,
        "source_highlight": highlight_source,
        "source_closing_line": closing_source,
        "visible_headline": headline,
        "visible_body": visible_body,
        "visible_highlight": highlight,
        "visible_closing_line": visible_closing_line,
        "source_label": source_label,
    }
    return im


def _legacy_crop_rect(source_size: tuple[int, int], centering: tuple[float, float]) -> dict:
    source_width, source_height = source_size
    target_aspect = W / H
    if source_width / source_height > target_aspect:
        crop_height = source_height
        crop_width = int(round(source_height * target_aspect))
        left = int(round((source_width - crop_width) * min(1.0, max(0.0, centering[0]))))
        top = 0
    else:
        crop_width = source_width
        crop_height = int(round(source_width / target_aspect))
        left = 0
        top = int(round((source_height - crop_height) * min(1.0, max(0.0, centering[1]))))
    return {"x": left / source_width, "y": top / source_height,
            "width": crop_width / source_width, "height": crop_height / source_height}


def _face_card_box(face: dict, crop: dict) -> list[float]:
    return [
        (float(face["x"]) - float(crop["x"])) / float(crop["width"]) * W,
        (float(face["y"]) - float(crop["y"])) / float(crop["height"]) * H,
        (float(face["x"]) + float(face["width"]) - float(crop["x"])) / float(crop["width"]) * W,
        (float(face["y"]) + float(face["height"]) - float(crop["y"])) / float(crop["height"]) * H,
    ]


def _intersects(a: list[float], b: list[float]) -> bool:
    return min(a[2], b[2]) > max(a[0], b[0]) and min(a[3], b[3]) > max(a[1], b[1])


def _record_body_text_overlap(state: dict) -> None:
    crop = state.get("render_crop") or state.get("crop")
    if not crop:
        state["face_boxes_card"] = []
        state["text_overlap"] = False
        return
    face_boxes = []
    for index, face in enumerate(state["faces"]):
        box = _face_card_box(face, crop)
        face_boxes.append({"face_index": index, "bounds": box,
                           "confidence": face["confidence"]})
    overlap = any(
        _intersects(face_box["bounds"], text["bounds"])
        for face_box in face_boxes for text in state["text_bounds"]
    )
    state["face_boxes_card"] = face_boxes
    state["text_overlap"] = overlap
    if overlap:
        state["review_flags"] = list(dict.fromkeys([*state["review_flags"], "FACE_OVERLAPS_BODY_TEXT"]))


def _photo_job(job: dict, role: str, photo: dict | None) -> dict:
    if not isinstance(photo, dict):
        return job
    result = dict(job)
    detection = photo.get("subject_detection_result")
    if not isinstance(detection, dict):
        detection = {}
    mapping = {
        "crop": photo.get("crop") or photo.get("crop_coordinates"),
        "faces": photo.get("faces", detection.get("faces", [])),
        "quality": photo.get("quality", {}),
        "analysis_ms": photo.get("analysis_ms", detection.get("analysis_ms")),
        "review_required": photo.get("review_required", detection.get("review_required", False)),
        "review_flags": photo.get("review_flags", detection.get("review_flags", [])),
    }
    for field, value in mapping.items():
        result[f"{role}_{field}"] = value
    manual_focus = photo.get("manual_focus")
    if isinstance(manual_focus, dict):
        result[f"{role}_focus_x"] = manual_focus.get("x")
        result[f"{role}_focus_y"] = manual_focus.get("y")
    return result


def _template_for_role(role: str) -> str:
    normalized = str(role or "BODY").strip().upper()
    return {"KEY_FACT": "FACT", "CONTEXT": "CONTEXT", "IMPLICATION": "ANALYSIS"}.get(
        normalized, "CONTEXT"
    )


def _composition_for_role(role: str) -> tuple[float, tuple[float, float]]:
    normalized = str(role or "BODY").strip().upper()
    return {
        "KEY_FACT": (-0.12, (0.58, 0.50)),
        "CONTEXT": (-0.10, (0.44, 0.50)),
        "IMPLICATION": (-0.075, (0.52, 0.42)),
    }.get(normalized, (0.0, (0.50, 0.50)))


def _draw_contact_sheet(output_dir: Path, slides: list[dict]) -> None:
    columns = min(3, max(1, len(slides)))
    rows = math.ceil(len(slides) / columns)
    thumb = (240, 300)
    gap, label_height = 18, 26
    width = gap + columns * (thumb[0] + gap)
    height = gap + rows * (thumb[1] + label_height + gap)
    sheet = Image.new("RGB", (width, height), "#202327")
    draw = ImageDraw.Draw(sheet)
    label_font = ImageFont.load_default()
    for index, entry in enumerate(slides):
        row, column = divmod(index, columns)
        x, y = gap + column * (thumb[0] + gap), gap + row * (thumb[1] + label_height + gap)
        with Image.open(output_dir / entry["file"]) as opened:
            card = ImageOps.fit(opened.convert("RGB"), thumb, method=Image.Resampling.LANCZOS)
        sheet.paste(card, (x, y + label_height))
        draw.text((x, y + 5), f"{entry['slide_number']:02d} {entry['kind']}",
                  font=label_font, fill="#ffffff")
    sheet.save(output_dir / "contact_sheet.png", "PNG", optimize=True)


def _draw_crop_audit(output_dir: Path,
                     pages: list[tuple[int, Image.Image, dict, tuple[float, float], Image.Image]]) -> None:
    source_frame = (480, 300)
    card_frame = (216, 270)
    left_margin, top_margin, row_height, gap = 22, 20, 350, 16
    width, height = left_margin * 2 + source_frame[0] + gap + card_frame[0], top_margin * 2 + row_height * len(pages)
    audit = Image.new("RGB", (width, height), "#202327")
    draw = ImageDraw.Draw(audit)
    label_font = ImageFont.load_default()
    for row, (slide_number, source_image, state, centering, card_image) in enumerate(pages):
        source = source_image.convert("RGB")
        crop = state.get("render_crop") or state.get("crop") or _legacy_crop_rect(source.size, centering)
        y = top_margin + row * row_height
        x = left_margin
        draw.text((x, y), f"PAGE {slide_number:02d} SOURCE / CROP", font=label_font, fill="#ffffff")
        frame_y = y + 22
        contained = ImageOps.contain(source, source_frame, method=Image.Resampling.LANCZOS)
        source_x = x + (source_frame[0] - contained.width) // 2
        source_y = frame_y + (source_frame[1] - contained.height) // 2
        audit.paste(contained, (source_x, source_y))
        sx, sy = contained.width / source.width, contained.height / source.height
        crop_bounds = [
            source_x + float(crop["x"]) * source.width * sx,
            source_y + float(crop["y"]) * source.height * sy,
            source_x + (float(crop["x"]) + float(crop["width"])) * source.width * sx,
            source_y + (float(crop["y"]) + float(crop["height"])) * source.height * sy,
        ]
        draw.rectangle(crop_bounds, outline="#ffdf00", width=3)
        for face in state["faces"]:
            bounds = [
                source_x + face["x"] * source.width * sx,
                source_y + face["y"] * source.height * sy,
                source_x + (face["x"] + face["width"]) * source.width * sx,
                source_y + (face["y"] + face["height"]) * source.height * sy,
            ]
            draw.rectangle(bounds, outline="#00ff75", width=2)
        card_x = left_margin + source_frame[0] + gap
        draw.text((card_x, y), f"PAGE {slide_number:02d} CARD", font=label_font, fill="#ffffff")
        result = ImageOps.fit(card_image.convert("RGB"), card_frame, method=Image.Resampling.LANCZOS)
        audit.paste(result, (card_x, frame_y))
    audit.save(output_dir / "crop_audit.png", "PNG", optimize=True)

def render(job: dict, workdir: Path, output_dir: Path,
           face_path: Path, logo_path: Path | None, cta_path: Path | None,
           body_font_path: Path | None = None) -> dict:
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
    body_face = font(str(body_font_path or face_path), 40)
    page_photos = job.get("page_photos") if isinstance(job.get("page_photos"), dict) else {}
    cover_info = page_photos.get("1") if isinstance(page_photos.get("1"), dict) else None
    cover_photo = (workdir / str((cover_info or {}).get("file", job["cover_photo"]))).resolve()
    body_photo = (workdir / str(job["body_photo"])).resolve()
    # Avoid using one input from outside trusted workdir.
    for file in (cover_photo, body_photo):
        if not file.is_relative_to(workdir.resolve()):
            raise ValueError("Photo path escapes job directory")
    cover_job = _photo_job(job, "cover", cover_info)
    crop_inputs = {
        "cover": cover_job.get("cover_crop") is not None or any(
            key in job for key in ("cover_focus_x", "cover_focus_y")),
        "body": job.get("body_crop") is not None or any(
            key in job for key in ("body_focus_x", "body_focus_y")),
    }
    coversrc = validate_photo(cover_photo, crop_metadata=crop_inputs["cover"] or bool(cover_info))
    bodysrc = validate_photo(body_photo, crop_metadata=crop_inputs["body"])
    if cover_info and cover_info.get("source_sha256") and sha256(cover_photo) != cover_info["source_sha256"]:
        raise ValueError("M9_MEDIA_HASH_MISMATCH")
    photo_states = {"cover": _photo_state(coversrc, cover_job, "cover")}
    photo_states["cover"]["render_crop"] = _display_crop(
        photo_states["cover"].get("crop"), coversrc.size,
        photo_states["cover"].get("faces", []), 0.01,
    )
    if photo_states["cover"]["render_crop"] is None:
        photo_states["cover"]["render_crop"] = _legacy_crop_rect(
            coversrc.size,
            (float(job.get("cover_focus_x", 0.5)), float(job.get("cover_focus_y", 0.36))),
        )
    output_files = []
    body_slides = job.get("body_slides")
    if not isinstance(body_slides, list) or not body_slides:
        body_slides = [{
            "body_headline": job["body_headline"],
            "body_paragraphs": job["body_paragraphs"],
            "body_highlight": job.get("body_highlight", ""),
        }]
    news_slide_count = 1 + len(body_slides)
    validate_exploration_slide_count(
        job.get("brief_status"), job.get("generation_intent"),
        job.get("content_mode"), news_slide_count,
    )
    if len(body_slides) > 5:
        raise ValueError("M9_NEWS_SLIDE_LIMIT")
    cover_image = render_cover(coversrc, job, face, photo_states["cover"], logo_path)
    rendered = [(1, "COVER_NEWS", cover_image)]
    render_sources: list[tuple[int, Image.Image, dict, tuple[float, float], Image.Image]] = [
        (1, coversrc, photo_states["cover"],
         (float(job.get("cover_focus_x", 0.5)), float(job.get("cover_focus_y", 0.36))), cover_image)
    ]
    page_records: list[dict[str, Any]] = []
    seen_image_hashes = {sha256(cover_photo): 1}
    for index, body_slide in enumerate(body_slides, start=2):
        if not isinstance(body_slide, dict):
            raise ValueError("M9_BODY_SLIDE_INVALID")
        for field in ("body_headline", "body_paragraphs"):
            if field not in body_slide:
                raise ValueError("M9_BODY_SLIDE_INVALID")
        photo_info = body_slide.get("photo") if isinstance(body_slide.get("photo"), dict) else page_photos.get(str(index))
        photo_path = (workdir / str(photo_info.get("file"))).resolve() if photo_info else body_photo
        if not photo_path.is_relative_to(workdir.resolve()):
            raise ValueError("Photo path escapes job directory")
        page_src = validate_photo(photo_path, crop_metadata=bool(photo_info and (photo_info.get("crop") or photo_info.get("crop_coordinates"))))
        if photo_info and photo_info.get("source_sha256") and sha256(photo_path) != photo_info["source_sha256"]:
            raise ValueError("M9_MEDIA_HASH_MISMATCH")
        role = "body" if index == 2 else f"slide_{index:02d}"
        page_job = _photo_job(job, role, photo_info) if photo_info else job
        state = _photo_state(page_src, page_job, role) if photo_info else _photo_state(bodysrc, job, "body")
        content_role = str(body_slide.get("role") or "BODY").strip().upper()
        crop_offset, photo_centering = _composition_for_role(content_role)
        state["render_crop"] = _display_crop(
            state.get("crop"), page_src.size, state.get("faces", []), crop_offset,
        )
        if state["render_crop"] is None:
            state["render_crop"] = _legacy_crop_rect(page_src.size, photo_centering)
        data = {**job, **body_slide, "slide_number": index,
                "role": content_role,
                "layout_template": _template_for_role(content_role),
                "photo_centering": photo_centering,
                "layout_variant": "ALTERNATE" if index % 2 == 1 else "STANDARD"}
        if photo_info and isinstance(photo_info.get("credit"), str):
            data["body_photo_credit"] = photo_info["credit"]
        body_image = render_body(page_src, data, body_face, logo_path, face, state)
        state["text_bounds"] = [{"slide_number": index, **row}
                                 for row in data.get("_rendered_text_bounds", [])]
        state["content_review_flags"] = data.get("_content_review_flags", [])
        state["rendered_content"] = data.get("_rendered_content", {})
        _record_body_text_overlap(state)
        photo_states[str(index)] = state
        render_sources.append((index, page_src, state, (0.5, 0.5), body_image))
        rendered.append((index, "BODY_NEWS", body_image))
        source_url = (photo_info or {}).get("source_url") or job["body_photo_source"]
        source_article_url = (photo_info or {}).get("article_url") or job.get("body_source_article_url", job["article_url"])
        credit = (photo_info or {}).get("credit") or job["body_photo_credit"]
        digest = sha256(photo_path)
        duplicate_of = seen_image_hashes.get(digest)
        reuse_status = (photo_info or {}).get("image_reuse_status")
        if duplicate_of is not None:
            # Older two-slot manifests reuse BODY_NEWS for every later page and
            # cannot declare page-level reuse. Derive exact reuse from bytes.
            reuse_status = "REUSED_EXACT"
        elif reuse_status not in ("REUSED_EXACT", "REUSED_PERCEPTUAL"):
            reuse_status = "UNIQUE"
        seen_image_hashes.setdefault(digest, index)
        declared_duplicate = (photo_info or {}).get("duplicate_of_slide_number")
        if not isinstance(declared_duplicate, int):
            declared_duplicate = duplicate_of
        page_records.append({
            "slide_number": index, "kind": "BODY_NEWS", "photo_source_url": source_url,
            "role": content_role, "layout_template": data["layout_template"],
            "source_index": body_slide.get("source_index", body_slide.get("slide_number")),
            "source_article_url": source_article_url, "credit": credit, "photo_sha256": digest,
            "crop_coordinates": state.get("render_crop") or state["crop"],
            "analysis_crop_coordinates": state["crop"], "scale": state["scale"],
            "subject_detection_result": {"faces": state["faces"], "review_required": state["review_required"],
                                          "review_flags": state["review_flags"], "analysis_ms": state["analysis_ms"]},
            "image_reuse_status": reuse_status,
            "duplicate_of_slide_number": declared_duplicate if reuse_status != "UNIQUE" else None,
            "text_bounds": state["text_bounds"],
            "face_boxes_card": state.get("face_boxes_card", []),
            "text_overlap": state["text_overlap"],
            "content": state["rendered_content"],
            "content_review_flags": state["content_review_flags"],
            "stat_emphasis": body_slide.get("stat_emphasis", ""),
        })
    for number, kind, result in rendered:
        dest = output_dir / f"slide_{number:02d}_{kind.lower()}.png"
        result.convert("RGB").save(dest, "PNG", optimize=True)
        record = {"slide_number": number, "kind": kind, "file": dest.name,
                  "width": W, "height": H}
        if kind == "COVER_NEWS":
            cover_digest = sha256(cover_photo)
            record.update({
                "role": str(job.get("cover_source_role") or "HOOK").strip().upper(),
                "source_index": job.get("cover_source_index"),
                "layout_template": "COVER",
                "photo_source_url": (cover_info or {}).get("source_url", job["cover_photo_source"]),
                "source_article_url": (cover_info or {}).get("article_url", job.get("cover_source_article_url", job["article_url"])),
                "credit": (cover_info or {}).get("credit", job["cover_photo_credit"]),
                "photo_sha256": cover_digest,
                "crop_coordinates": photo_states["cover"].get("render_crop") or photo_states["cover"]["crop"],
                "analysis_crop_coordinates": photo_states["cover"]["crop"],
                "scale": photo_states["cover"]["scale"],
                "subject_detection_result": {"faces": photo_states["cover"]["faces"],
                    "review_required": photo_states["cover"]["review_required"],
                    "review_flags": photo_states["cover"]["review_flags"],
                    "analysis_ms": photo_states["cover"]["analysis_ms"]},
                "image_reuse_status": "UNIQUE",
                "text_bounds": job.get("_rendered_cover_text_bounds", []),
                "content": {
                    "role": str(job.get("cover_source_role") or "HOOK").strip().upper(),
                    "layout_template": "COVER",
                    "source_headline": job.get("cover_source_headline") or job["cover_line_one"],
                    "source_highlight": job.get("cover_source_highlight") or job.get("cover_line_two", ""),
                    "visible_headline": _clean_source_markup(job["cover_line_one"])[0],
                    "visible_highlight": _clean_source_markup(job.get("cover_line_two", ""))[0],
                    "source_label": _source_label(job),
                },
            })
        else:
            record.update(next(page for page in page_records if page["slide_number"] == number))
        output_files.append(record)
    cta_integrity = None
    if cta_path:
        with Image.open(cta_path) as cta:
            if cta.size != SIZE:
                raise ValueError("CTA asset must be 1080x1350")
        dest = output_dir / f"slide_{len(rendered) + 1:02d}_cta.png"
        input_sha = sha256(cta_path)
        shutil.copyfile(cta_path, dest)  # Exact fixed CTA bytes reused, never regenerated.
        output_sha = sha256(dest)
        if output_sha != input_sha:
            raise ValueError("M9_CTA_BYTE_IDENTITY_FAILED")
        cta_integrity = {
            "input_file": cta_path.name,
            "input_sha256": input_sha,
            "output_file": dest.name,
            "output_sha256": output_sha,
            "byte_identical": True,
            "historical_storage_match_verified": False,
        }
        output_files.append({"slide_number": len(rendered) + 1, "kind": "CTA",
                             "file": dest.name, "width": W, "height": H,
                             "sha256": output_sha, "byte_identical_to_input": True,
                             "role": "CTA", "layout_template": "CTA"})
    _draw_contact_sheet(output_dir, output_files)
    _draw_crop_audit(output_dir, render_sources)
    crop_policy = load_crop_policy()
    quality_thresholds = {
        "max_enlargement": crop_policy["max_enlargement"],
        "scale_bands": crop_policy["scale_bands"],
        "quality": crop_policy["quality"],
    }
    photos_report = {}
    for role, state in photo_states.items():
        photos_report[role] = {
            "crop": state["crop"], "display_crop": state.get("render_crop"),
            "effective_scale": state["scale"],
            "faces": state["faces"], "quality_measurements": state["quality"],
            "quality_thresholds": quality_thresholds,
            "review_required": state["review_required"],
            "review_flags": state["review_flags"],
            "analysis_ms": state["analysis_ms"],
            "manual_focus": state["manual_focus"],
        }
        if role.isdigit():
            photos_report[role].update({
                "text_bounds": state["text_bounds"],
                "face_boxes_card": state.get("face_boxes_card", []),
                "text_overlap": state["text_overlap"],
            })
    if "2" in photos_report:
        photos_report["body"] = photos_report["2"]
    report = {
        "state": "PRIVATE_PREVIEW_REQUIRES_REVIEW",
        "approval": {"visual_subject_crop": False, "image_reuse_rights": False,
                     "auto_publishing_allowed": False},
        "article_url": job["article_url"],
        "source_publisher": job.get("source_publisher"),
        "article_published_at": job["article_published_at"],
        "cta_integrity": cta_integrity,
        "generation_context": {
            "content_mode": job.get("content_mode"),
            "brief_status": job.get("brief_status"),
            "generation_intent": job.get("generation_intent"),
        },
        "caption_draft": job.get("caption_draft", ""),
        "typography": {
            "cover_font_role": "BOLD_FACE_FONT",
            "body_headline_font_role": "BOLD_HEADING_FONT",
            "body_font_role": "SEMIBOLD_BODY_FONT",
            "configured_cover_font": Path(face_path).name,
            "configured_body_font": Path(body_font_path or face_path).name,
            "settings": TYPE,
            "text_bounds_checked": True,
            "layout_variants": sorted({_template_for_role(slide.get("role")) for slide in body_slides}),
        },
        "photo_summary": {
            "candidate_count": job.get("photo_candidate_count"),
            "selected_page_count": len(page_records) + 1,
            "unique_image_count": len({entry["photo_sha256"] for entry in output_files if entry["kind"] != "CTA"}),
            "reused_page_count": sum(entry["image_reuse_status"] != "UNIQUE" for entry in output_files if entry["kind"] != "CTA"),
            "photo_shortage": job.get("photo_shortage"),
        },
        "sources": [{
            "slide_number": entry["slide_number"], "kind": entry["kind"],
            "role": entry.get("role"), "layout_template": entry.get("layout_template"),
            "source_index": entry.get("source_index"),
            "photo_url": entry["photo_source_url"], "credit": entry["credit"],
            "article_url": entry["source_article_url"], "sha256": entry["photo_sha256"],
            "crop_coordinates": entry["crop_coordinates"], "scale": entry["scale"],
            "subject_detection_result": entry["subject_detection_result"],
            "image_reuse_status": entry["image_reuse_status"],
            "original_dimensions": list(coversrc.size if entry["slide_number"] == 1 else render_sources[entry["slide_number"] - 1][1].size),
        } for entry in output_files if entry["kind"] != "CTA"],
        "photos": photos_report,
        "review_artifacts": {
            "contact_sheet": "contact_sheet.png",
            "contact_sheet_pages": [page["file"] for page in output_files],
            "crop_audit": "crop_audit.png",
        },
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
    parser.add_argument("--body-font")
    parser.add_argument("--logo")
    parser.add_argument("--cta")
    args = parser.parse_args()
    job_path = Path(args.job).resolve()
    job = json.loads(job_path.read_text(encoding="utf-8"))
    report = render(job, job_path.parent, Path(args.output).resolve(),
                    Path(args.font), Path(args.logo) if args.logo else None,
                    Path(args.cta) if args.cta else None,
                    Path(args.body_font) if args.body_font else None)
    print(json.dumps({"status": report["state"], "slides": report["slides"]},
                     ensure_ascii=False, indent=2))

if __name__ == "__main__":
    main()
