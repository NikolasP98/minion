"""
FastAPI inference server for ViT defect detection.

Exposes POST /predict for image classification and GET /health for liveness.
Designed to run as a sidecar to the Minion Gateway on Netcup VPS.
"""

import base64
import io
import logging
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path

import numpy as np
import torch
from fastapi import FastAPI, HTTPException
from PIL import Image
from pydantic import BaseModel, Field

from config import DEFECT_LABELS, ServeConfig, TrainConfig
from dataset import get_eval_transforms
from model import load_model, resolve_device

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

# Global state
_model: torch.nn.Module | None = None
_onnx_session = None
_transform = None
_config: ServeConfig | None = None
_device: torch.device | None = None


def _load_onnx_session(onnx_path: Path):
    """Load ONNX Runtime inference session."""
    import onnxruntime as ort

    providers = ["CPUExecutionProvider"]
    if "CUDAExecutionProvider" in ort.get_available_providers():
        providers.insert(0, "CUDAExecutionProvider")

    session = ort.InferenceSession(str(onnx_path), providers=providers)
    logger.info("ONNX session loaded from %s (providers: %s)", onnx_path, providers)
    return session


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Load model on startup."""
    global _model, _onnx_session, _transform, _config, _device

    _config = ServeConfig(
        model_path=Path(os.getenv("MODEL_PATH", "checkpoints/best_model.pt")),
        onnx_path=Path(os.getenv("ONNX_PATH", "checkpoints/model_int8.onnx"))
        if os.getenv("ONNX_PATH", "checkpoints/model_int8.onnx")
        else None,
        use_onnx=os.getenv("USE_ONNX", "true").lower() == "true",
        port=int(os.getenv("PORT", "8100")),
        confidence_threshold=float(os.getenv("CONFIDENCE_THRESHOLD", "0.5")),
    )

    train_cfg = TrainConfig()
    _transform = get_eval_transforms(train_cfg)

    if _config.use_onnx and _config.onnx_path and _config.onnx_path.exists():
        _onnx_session = _load_onnx_session(_config.onnx_path)
    elif _config.model_path.exists():
        _device = resolve_device(train_cfg)
        _model = load_model(_config.model_path, train_cfg, _device)
    else:
        logger.error(
            "No model found at %s or %s",
            _config.model_path,
            _config.onnx_path,
        )
        raise RuntimeError("No model weights found")

    logger.info("Inference server ready")
    yield
    logger.info("Shutting down inference server")


app = FastAPI(
    title="ViT Defect Detection Service",
    version="1.0.0",
    lifespan=lifespan,
)


class InspectRequest(BaseModel):
    image: str = Field(..., description="Base64-encoded image (PNG/JPEG)")


class BoundingBox(BaseModel):
    x: float
    y: float
    w: float
    h: float


class InspectResponse(BaseModel):
    defectType: str
    confidence: float
    boundingBox: BoundingBox | None = None
    passed: bool = Field(..., alias="pass")

    model_config = {"populate_by_name": True}


class HealthResponse(BaseModel):
    status: str
    model_loaded: bool
    backend: str


@app.get("/health", response_model=HealthResponse)
async def health():
    backend = "onnx" if _onnx_session else "pytorch"
    model_loaded = _onnx_session is not None or _model is not None
    return HealthResponse(
        status="ok" if model_loaded else "no_model",
        model_loaded=model_loaded,
        backend=backend,
    )


@app.post("/predict", response_model=InspectResponse)
async def predict(req: InspectRequest):
    start_time = time.monotonic()

    # Decode base64 image
    try:
        image_bytes = base64.b64decode(req.image)
        if _config and len(image_bytes) > _config.max_image_bytes:
            raise HTTPException(413, "Image too large")
        image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    except Exception as e:
        if isinstance(e, HTTPException):
            raise
        raise HTTPException(400, f"Invalid image data: {e}")

    # Preprocess
    input_tensor = _transform(image).unsqueeze(0)  # type: ignore[union-attr]

    # Inference
    if _onnx_session:
        input_np = input_tensor.numpy()
        outputs = _onnx_session.run(None, {"image": input_np})
        logits = torch.from_numpy(outputs[0])
    elif _model and _device:
        input_tensor = input_tensor.to(_device)
        with torch.no_grad():
            logits = _model(input_tensor)
    else:
        raise HTTPException(503, "Model not loaded")

    # Post-process
    probs = torch.softmax(logits, dim=1)
    confidence, predicted_idx = probs.max(1)
    confidence_val = confidence.item()
    predicted_label = DEFECT_LABELS[predicted_idx.item()]

    is_pass = predicted_label == "good" or (
        _config is not None and confidence_val < _config.confidence_threshold
    )

    elapsed_ms = (time.monotonic() - start_time) * 1000
    logger.info(
        "Prediction: %s (%.2f%%) in %.0fms — %s",
        predicted_label,
        confidence_val * 100,
        elapsed_ms,
        "PASS" if is_pass else "FAIL",
    )

    return InspectResponse(
        defectType=predicted_label,
        confidence=round(confidence_val, 4),
        boundingBox=None,  # ViT classification doesn't produce bounding boxes
        **{"pass": is_pass},
    )


if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("PORT", "8100"))
    uvicorn.run(app, host="0.0.0.0", port=port)
