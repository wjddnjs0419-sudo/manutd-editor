"""Single source of truth for the approved ManUtd Editor M9 visual tokens."""
from __future__ import annotations

SIZE = (1080, 1350)
W, H = SIZE

COLORS = {
    "text": "#FFFFFF",
    "overlay": "#000000",
    "accent": "#F04452",
    "muted": "#DEDEDE",
    "eyebrow": "#F1EEEE",
}

TYPOGRAPHY = {
    "cover_title": 80,
    "page_title": 60,
    "body": 40,
    "emphasis": 48,
    "source": 20,
    "photo_credit": 18,
    "cover_label": 26,
    "fact_stat": 48,
    "analysis_note": 40,
}

LAYOUT = {
    "content_margin": 80,
    "cover_text_margin": 40,
    "content_width": W - 160,
    "logo_x": 40,
    "logo_y": 40,
    "logo_width": 86,
    "logo_height": 86,
    "max_title_lines": 2,
    "max_paragraph_lines": 2,
    "safe_text_bottom": 1110,
    "source_y": 1268,
    "photo_credit_y": 1310,
}

OVERLAYS = {
    "cover_gradient_start_y": round(H * 0.42),
    "cover_gradient_mid_y": round(H * 0.72),
    "cover_gradient_start_opacity": 0.0,
    "cover_gradient_mid_opacity": 0.45,
    "cover_gradient_end_opacity": 1.0,
    "body_template_alpha": {
        "FACT": (0.42, 0.68),
        "CONTEXT": (0.52, 0.74),
        "ANALYSIS": (0.48, 0.78),
    },
}

# Keep the renderer's historical settings map in the manifest for existing consumers.
TYPE = {
    "cover_label": TYPOGRAPHY["cover_label"],
    "cover_headline": TYPOGRAPHY["cover_title"],
    "cover_highlight": TYPOGRAPHY["emphasis"],
    "body_headline": TYPOGRAPHY["page_title"],
    "body_text": TYPOGRAPHY["body"],
    "body_highlight": TYPOGRAPHY["emphasis"],
    "fact_stat": TYPOGRAPHY["fact_stat"],
    "analysis_note": TYPOGRAPHY["analysis_note"],
    "source_label": TYPOGRAPHY["source"],
    "photo_credit": TYPOGRAPHY["photo_credit"],
    "body_line_advance": 60,
    "paragraph_spacing": 16,
    "highlight_line_advance": 64,
    "text_margin": LAYOUT["content_margin"],
    "content_width": LAYOUT["content_width"],
    "cover_text_margin": LAYOUT["cover_text_margin"],
    "logo_x": LAYOUT["logo_x"],
    "logo_y": LAYOUT["logo_y"],
    "logo_width": LAYOUT["logo_width"],
    "logo_height": LAYOUT["logo_height"],
    "max_title_lines": LAYOUT["max_title_lines"],
    "max_paragraph_lines": LAYOUT["max_paragraph_lines"],
    "safe_text_bottom": LAYOUT["safe_text_bottom"],
    "source_y": LAYOUT["source_y"],
    "photo_credit_y": LAYOUT["photo_credit_y"],
    "body_overlay_opacity": 179,
    "cover_gradient_start_y": OVERLAYS["cover_gradient_start_y"],
    "cover_gradient_mid_y": OVERLAYS["cover_gradient_mid_y"],
    "cover_gradient_start_opacity": OVERLAYS["cover_gradient_start_opacity"],
    "cover_gradient_mid_opacity": OVERLAYS["cover_gradient_mid_opacity"],
    "cover_gradient_end_opacity": OVERLAYS["cover_gradient_end_opacity"],
}

DESIGN_TOKENS = {
    "version": "m9-editorial-v1",
    "canvas": [W, H],
    "typography": {
        "cover_title_px": TYPOGRAPHY["cover_title"],
        "page_title_px": TYPOGRAPHY["page_title"],
        "body_px": TYPOGRAPHY["body"],
        "emphasis_px": TYPOGRAPHY["emphasis"],
        "source_px": TYPOGRAPHY["source"],
    },
    "font_roles": {
        "cover_title": "PRETENDARD_BOLD",
        "page_title": "PRETENDARD_BOLD",
        "emphasis": "PRETENDARD_BOLD",
        "body": "PRETENDARD_SEMIBOLD",
        "source": "PRETENDARD_SEMIBOLD",
    },
    "colors": {
        "text": COLORS["text"],
        "overlay": COLORS["overlay"],
        "accent": COLORS["accent"],
        "source": COLORS["muted"],
        "eyebrow": COLORS["eyebrow"],
    },
    "layout": {
        "content_margin_px": LAYOUT["content_margin"],
        "content_width_px": LAYOUT["content_width"],
        "logo": {
            "x": LAYOUT["logo_x"],
            "y": LAYOUT["logo_y"],
            "width": LAYOUT["logo_width"],
            "height": LAYOUT["logo_height"],
        },
        "max_title_lines": LAYOUT["max_title_lines"],
        "max_paragraph_lines": LAYOUT["max_paragraph_lines"],
    },
}
