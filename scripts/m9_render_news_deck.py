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
from m9_photo_analysis import (
    CropPlan, NormalizedFace, analyze_photo, apply_crop, load_crop_policy,
)

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
    if manual_focus is not None:
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
            "manual_focus": {"x": manual_focus[0], "y": manual_focus[1]},
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
                 photo_state: dict | None = None) -> Image.Image:
    selected_crop = photo_state["crop"] if photo_state else None
    im = full_bleed(source, crop=selected_crop,
                    centering=(float(data.get("cover_focus_x", 0.5)),
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
                logo_path: Path | None, heading_face: ImageFont.FreeTypeFont | None = None,
                photo_state: dict | None = None) -> Image.Image:
    selected_crop = photo_state["crop"] if photo_state else None
    im = full_bleed(source, crop=selected_crop, centering=(0.5, 0.5))
    im = Image.alpha_composite(im, Image.new("RGBA", SIZE, (0, 0, 0, 179)))
    draw = ImageDraw.Draw(im)
    text_bounds: list[dict] = []

    def draw_content(text: str, origin: tuple[int, int], text_font: ImageFont.FreeTypeFont,
                     fill: str, kind: str) -> None:
        draw.text(origin, text, font=text_font, fill=fill)
        text_bounds.append({
            "kind": kind, "origin": [origin[0], origin[1]],
            "bounds": list(draw.textbbox(origin, text, font=text_font)),
        })

    headline = str(data["body_headline"]).strip()
    f80 = ImageFont.truetype((heading_face or face).path, 80)
    if measure(draw, headline, f80) > 915:
        raise ValueError("BODY_NEWS headline overflow: shorten rather than shrink")
    draw_content(headline, (80, 168), f80, "#ffffff", "headline")
    draw.rectangle((80, 324, 653, 326), fill="#d9d9d9")
    y = 375
    f40 = ImageFont.truetype(face.path, 40)
    for paragraph in data["body_paragraphs"]:
        if not paragraph:
            y += 35
            continue
        for line in wrap_text(draw, str(paragraph), f40, 916):
            draw_content(line, (80, y), f40, "#ffffff", "paragraph")
            y += 62
        y += 9
    highlight = str(data.get("body_highlight", "")).strip()
    if highlight:
        y += 25
        f50 = ImageFont.truetype(face.path, 50)
        for line in wrap_text(draw, highlight, f50, 916):
            draw_content(line, (80, y), f50, YELLOW, "highlight")
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
    data["_rendered_text_bounds"] = text_bounds
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
    crop = state.get("crop")
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
        state["review_required"] = True
        state["review_flags"] = list(dict.fromkeys([*state["review_flags"], "FACE_OVERLAPS_BODY_TEXT"]))


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


def _draw_crop_audit(output_dir: Path, sources: dict[str, Image.Image],
                     states: dict[str, dict], legacy_centering: dict[str, tuple[float, float]],
                     rendered: list[tuple[int, str, Image.Image]]) -> None:
    source_frame = (480, 300)
    card_frame = (216, 270)
    left_margin, top_margin, row_height, gap = 22, 20, 350, 16
    width, height = left_margin * 2 + source_frame[0] + gap + card_frame[0], top_margin * 2 + row_height * 2
    audit = Image.new("RGB", (width, height), "#202327")
    draw = ImageDraw.Draw(audit)
    label_font = ImageFont.load_default()
    final_cards = {}
    for _, kind, image in rendered:
        final_cards.setdefault(kind, image.convert("RGB"))
    for row, role in enumerate(("cover", "body")):
        source = sources[role].convert("RGB")
        state = states[role]
        crop = state.get("crop") or _legacy_crop_rect(source.size, legacy_centering[role])
        y = top_margin + row * row_height
        x = left_margin
        draw.text((x, y), f"{role.upper()} SOURCE / CROP", font=label_font, fill="#ffffff")
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
        draw.text((card_x, y), f"{role.upper()} CARD", font=label_font, fill="#ffffff")
        result = ImageOps.fit(final_cards["COVER_NEWS" if role == "cover" else "BODY_NEWS"],
                              card_frame, method=Image.Resampling.LANCZOS)
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
    cover_photo = (workdir / str(job["cover_photo"])).resolve()
    body_photo = (workdir / str(job["body_photo"])).resolve()
    # Avoid using one input from outside trusted workdir.
    for file in (cover_photo, body_photo):
        if not file.is_relative_to(workdir.resolve()):
            raise ValueError("Photo path escapes job directory")
    crop_inputs = {
        "cover": job.get("cover_crop") is not None or any(
            key in job for key in ("cover_focus_x", "cover_focus_y")),
        "body": job.get("body_crop") is not None or any(
            key in job for key in ("body_focus_x", "body_focus_y")),
    }
    coversrc = validate_photo(cover_photo, crop_metadata=crop_inputs["cover"])
    bodysrc = validate_photo(body_photo, crop_metadata=crop_inputs["body"])
    photo_states = {
        "cover": _photo_state(coversrc, job, "cover"),
        "body": _photo_state(bodysrc, job, "body"),
    }
    output_files = []
    body_slides = job.get("body_slides")
    if not isinstance(body_slides, list) or not body_slides:
        body_slides = [{
            "body_headline": job["body_headline"],
            "body_paragraphs": job["body_paragraphs"],
            "body_highlight": job.get("body_highlight", ""),
        }]
    rendered = [(1, "COVER_NEWS", render_cover(coversrc, job, face, photo_states["cover"]))]
    body_text_bounds: list[dict] = []
    for index, body_slide in enumerate(body_slides, start=2):
        if not isinstance(body_slide, dict):
            raise ValueError("M9_BODY_SLIDE_INVALID")
        for field in ("body_headline", "body_paragraphs"):
            if field not in body_slide:
                raise ValueError("M9_BODY_SLIDE_INVALID")
        data = {**job, **body_slide}
        body_image = render_body(bodysrc, data, body_face, logo_path, face, photo_states["body"])
        body_text_bounds.extend({"slide_number": index, **row}
                                for row in data.get("_rendered_text_bounds", []))
        rendered.append((index, "BODY_NEWS", body_image))
    photo_states["body"]["text_bounds"] = body_text_bounds
    _record_body_text_overlap(photo_states["body"])
    for number, kind, result in rendered:
        dest = output_dir / f"slide_{number:02d}_{kind.lower()}.png"
        result.convert("RGB").save(dest, "PNG", optimize=True)
        output_files.append({"slide_number": number, "kind": kind, "file": dest.name,
                             "width": W, "height": H})
    if cta_path:
        with Image.open(cta_path) as cta:
            if cta.size != SIZE:
                raise ValueError("CTA asset must be 1080x1350")
        dest = output_dir / f"slide_{len(rendered) + 1:02d}_cta.png"
        shutil.copyfile(cta_path, dest)  # Exact fixed CTA bytes reused, never regenerated.
        output_files.append({"slide_number": len(rendered) + 1, "kind": "CTA",
                             "file": dest.name, "width": W, "height": H})
    _draw_contact_sheet(output_dir, output_files)
    legacy_centering = {
        "cover": (float(job.get("cover_focus_x", 0.5)),
                  float(job.get("cover_focus_y", 0.36))),
        "body": (0.5, 0.5),
    }
    _draw_crop_audit(output_dir, {"cover": coversrc, "body": bodysrc},
                     photo_states, legacy_centering, rendered)
    crop_policy = load_crop_policy()
    quality_thresholds = {
        "max_enlargement": crop_policy["max_enlargement"],
        "scale_bands": crop_policy["scale_bands"],
        "quality": crop_policy["quality"],
    }
    photos_report = {}
    for role, state in photo_states.items():
        photos_report[role] = {
            "crop": state["crop"], "effective_scale": state["scale"],
            "faces": state["faces"], "quality_measurements": state["quality"],
            "quality_thresholds": quality_thresholds,
            "review_required": state["review_required"],
            "review_flags": state["review_flags"],
            "analysis_ms": state["analysis_ms"],
            "manual_focus": state["manual_focus"],
        }
        if role == "body":
            photos_report[role].update({
                "text_bounds": state["text_bounds"],
                "face_boxes_card": state.get("face_boxes_card", []),
                "text_overlap": state["text_overlap"],
            })
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
