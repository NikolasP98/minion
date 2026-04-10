"""OmniParser-v2 microservice — parse UI screenshots into element manifests."""

from __future__ import annotations

import base64
import io
import os
from typing import Literal

import numpy as np
import torch
from fastapi import FastAPI, HTTPException
from PIL import Image
from pydantic import BaseModel

app = FastAPI(title="omniparser-v2", version="2.0.0")

# ---------------------------------------------------------------------------
# Model loading
# ---------------------------------------------------------------------------

_MODELS_DIR = os.environ.get("MODELS_DIR", "/models")
_DEVICE = "cuda" if torch.cuda.is_available() else "cpu"

_yolo_model = None
_dino_processor = None
_dino_model = None


def _load_models() -> None:
    """Lazy-load YOLOv8 + Florence-2 DINO on first request (warm start)."""
    global _yolo_model, _dino_processor, _dino_model  # noqa: PLW0603

    if _yolo_model is not None:
        return

    from transformers import AutoModelForCausalLM, AutoProcessor
    from ultralytics import YOLO

    yolo_path = os.path.join(_MODELS_DIR, "icon_detect", "model.pt")
    if not os.path.exists(yolo_path):
        raise RuntimeError(f"YOLOv8 weights not found at {yolo_path}. Check MODELS_DIR.")

    _yolo_model = YOLO(yolo_path)
    _yolo_model.to(_DEVICE)

    dino_path = os.path.join(_MODELS_DIR, "icon_caption_florence")
    if not os.path.exists(dino_path):
        raise RuntimeError(f"Florence-2 weights not found at {dino_path}. Check MODELS_DIR.")

    _dino_processor = AutoProcessor.from_pretrained(dino_path, local_files_only=True)
    _dino_model = AutoModelForCausalLM.from_pretrained(
        dino_path, local_files_only=True, trust_remote_code=True
    ).to(_DEVICE)


# ---------------------------------------------------------------------------
# Request / Response schemas
# ---------------------------------------------------------------------------


class ParseRequest(BaseModel):
    screenshot: str  # base64-encoded PNG or JPEG
    detail_level: Literal["low", "high"] = "high"


class Element(BaseModel):
    id: int
    label: str
    bbox: list[float]  # [x1, y1, x2, y2] normalised 0-1
    type: str
    clickable: bool


class ParseResponse(BaseModel):
    labeled_screenshot: str  # base64-encoded PNG with bbox overlay
    elements: list[Element]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _decode_image(b64: str) -> Image.Image:
    """Decode a base64 string (with optional data-URL prefix) to a PIL Image."""
    if "," in b64:
        b64 = b64.split(",", 1)[1]
    return Image.open(io.BytesIO(base64.b64decode(b64))).convert("RGB")


def _encode_image(img: Image.Image) -> str:
    """Encode a PIL Image as a base64 PNG string."""
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode()


def _caption_element(img: Image.Image, bbox_px: tuple[int, int, int, int]) -> str:
    """Use Florence-2 to generate a short caption for a detected element crop."""
    if _dino_processor is None or _dino_model is None:
        return "element"

    x1, y1, x2, y2 = bbox_px
    crop = img.crop((x1, y1, x2, y2))
    inputs = _dino_processor(
        text="<CAPTION>",
        images=crop,
        return_tensors="pt",
    ).to(_DEVICE)

    with torch.no_grad():
        generated_ids = _dino_model.generate(
            input_ids=inputs["input_ids"],
            pixel_values=inputs["pixel_values"],
            max_new_tokens=20,
            num_beams=1,
        )
    caption = _dino_processor.batch_decode(generated_ids, skip_special_tokens=True)[0].strip()
    return caption if caption else "element"


def _infer_type(label: str) -> str:
    label_l = label.lower()
    if any(k in label_l for k in ("button", "btn", "link", "submit")):
        return "button"
    if any(k in label_l for k in ("input", "text", "field", "search", "textbox")):
        return "input"
    if any(k in label_l for k in ("check", "checkbox", "radio")):
        return "checkbox"
    if "icon" in label_l:
        return "icon"
    return "element"


def _infer_clickable(element_type: str) -> bool:
    return element_type in {"button", "input", "checkbox"}


def _yolo_to_elements(
    results: list,
    img: Image.Image,
    img_w: int,
    img_h: int,
    use_captions: bool,
) -> list[dict]:
    elements: list[dict] = []
    for i, box in enumerate(results[0].boxes):
        x1, y1, x2, y2 = (int(v) for v in box.xyxy[0].tolist())
        cls_id = int(box.cls[0].item())
        raw_label: str = results[0].names.get(cls_id, "unknown")

        if use_captions:
            label = _caption_element(img, (x1, y1, x2, y2))
        else:
            label = raw_label

        el_type = _infer_type(label)
        elements.append(
            {
                "id": i,
                "label": label,
                "bbox": [x1 / img_w, y1 / img_h, x2 / img_w, y2 / img_h],
                "type": el_type,
                "clickable": _infer_clickable(el_type),
            }
        )
    return elements


def _overlay_bboxes(img: Image.Image, elements: list[dict]) -> Image.Image:
    """Draw numbered bounding boxes on a copy of the image."""
    from PIL import ImageDraw, ImageFont

    overlay = img.copy()
    draw = ImageDraw.Draw(overlay)
    w, h = img.size

    try:
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 14)
    except OSError:
        font = ImageFont.load_default()

    for el in elements:
        x1 = el["bbox"][0] * w
        y1 = el["bbox"][1] * h
        x2 = el["bbox"][2] * w
        y2 = el["bbox"][3] * h
        draw.rectangle([x1, y1, x2, y2], outline="red", width=2)
        draw.text((x1 + 2, y1 + 2), str(el["id"]), fill="red", font=font)
    return overlay


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@app.get("/healthz")
def health() -> dict:
    return {"status": "ok", "device": _DEVICE}


@app.post("/parse", response_model=ParseResponse)
async def parse(req: ParseRequest) -> ParseResponse:
    """Detect and label interactive UI elements in a screenshot.

    Args:
        req: ParseRequest with base64-encoded screenshot and detail_level.

    Returns:
        ParseResponse with labeled_screenshot and elements list.
    """
    try:
        _load_models()
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    try:
        img = _decode_image(req.screenshot)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid screenshot: {exc}") from exc

    img_w, img_h = img.size

    # Lower confidence threshold in high-detail mode to find more elements
    conf_threshold = 0.4 if req.detail_level == "high" else 0.6

    results = _yolo_model(img, conf=conf_threshold, verbose=False)

    # Only run expensive Florence-2 captioning in high-detail mode
    use_captions = req.detail_level == "high"
    elements = _yolo_to_elements(results, img, img_w, img_h, use_captions)

    labeled_img = _overlay_bboxes(img, elements)

    return ParseResponse(
        labeled_screenshot=_encode_image(labeled_img),
        elements=[Element(**el) for el in elements],
    )
