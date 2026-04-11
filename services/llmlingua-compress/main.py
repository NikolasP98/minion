"""
LLMLingua-2 prompt compression microservice.

Exposes a FastAPI HTTP interface around the llmlingua PyPI package so that
any service can request token-level prompt compression without bundling the
large XLM-RoBERTa model into the main Node.js process.

Endpoints:
  POST /compress   — compress a text string to a target token ratio
  GET  /health     — liveness/readiness probe (returns 200 once model is loaded)

Usage:
  uvicorn main:app --host 0.0.0.0 --port 8080 --workers 1

Environment variables:
  LLMLINGUA_MODEL   Model id (default: microsoft/llmlingua-2-xlm-roberta-large-meetingbank)
  LLMLINGUA_DEVICE  Torch device: "cpu" or "cuda" (default: "cpu")
"""

from __future__ import annotations

import logging
import os
import time
from contextlib import asynccontextmanager
from typing import Optional

import tiktoken
from fastapi import FastAPI, HTTPException
from llmlingua import PromptCompressor
from pydantic import BaseModel, Field

# ── Logging ────────────────────────────────────────────────────────────────────

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger(__name__)

# ── Config ─────────────────────────────────────────────────────────────────────

MODEL_ID = os.environ.get(
    "LLMLINGUA_MODEL",
    "microsoft/llmlingua-2-xlm-roberta-large-meetingbank",
)
DEVICE = os.environ.get("LLMLINGUA_DEVICE", "cpu")

# ── Globals ────────────────────────────────────────────────────────────────────

_compressor: Optional[PromptCompressor] = None
_tokenizer = tiktoken.get_encoding("cl100k_base")


def _count_tokens(text: str) -> int:
    return len(_tokenizer.encode(text))


# ── Lifespan ───────────────────────────────────────────────────────────────────


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Load the model once on startup; release on shutdown."""
    global _compressor
    log.info("Loading LLMLingua-2 model: %s (device=%s)", MODEL_ID, DEVICE)
    t0 = time.monotonic()
    _compressor = PromptCompressor(
        model_name=MODEL_ID,
        use_llmlingua2=True,
        device_map=DEVICE,
    )
    elapsed = time.monotonic() - t0
    log.info("Model loaded in %.1fs", elapsed)
    yield
    log.info("Shutting down")


# ── App ────────────────────────────────────────────────────────────────────────

app = FastAPI(
    title="LLMLingua-2 Compress Service",
    version="1.0.0",
    lifespan=lifespan,
)

# ── Schemas ────────────────────────────────────────────────────────────────────


class CompressRequest(BaseModel):
    text: str = Field(..., description="Text to compress", min_length=1)
    target_ratio: float = Field(
        0.5,
        alias="targetRatio",
        ge=0.1,
        le=0.99,
        description="Target compression ratio (0.1 = 10% of tokens kept, 0.99 = almost no compression)",
    )

    model_config = {"populate_by_name": True}


class CompressResponse(BaseModel):
    compressed: str
    original_tokens: int = Field(..., alias="originalTokens")
    compressed_tokens: int = Field(..., alias="compressedTokens")
    ratio: float

    model_config = {"populate_by_name": True}


class HealthResponse(BaseModel):
    status: str
    model: str


# ── Routes ─────────────────────────────────────────────────────────────────────


@app.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    """Liveness/readiness probe. Returns 503 until the model is loaded."""
    if _compressor is None:
        raise HTTPException(status_code=503, detail="Model not loaded yet")
    return HealthResponse(status="ok", model=MODEL_ID)


@app.post("/compress", response_model=CompressResponse)
async def compress(req: CompressRequest) -> CompressResponse:
    """
    Compress *req.text* to approximately *req.target_ratio* of its original
    token count using LLMLingua-2.

    The actual ratio may differ slightly from the target; the response always
    contains the exact original and compressed token counts.
    """
    if _compressor is None:
        raise HTTPException(status_code=503, detail="Model not loaded yet")

    original_tokens = _count_tokens(req.text)
    if original_tokens < 10:
        # Text is trivially short — return as-is.
        return CompressResponse(
            compressed=req.text,
            original_tokens=original_tokens,
            compressed_tokens=original_tokens,
            ratio=1.0,
        )

    try:
        result = _compressor.compress_prompt(
            req.text,
            rate=req.target_ratio,
            force_tokens=["\n", "?"],
        )
    except Exception as exc:
        log.exception("Compression failed")
        raise HTTPException(status_code=500, detail=f"Compression error: {exc}") from exc

    compressed_text: str = result.get("compressed_prompt", req.text)
    compressed_tokens = _count_tokens(compressed_text)
    actual_ratio = compressed_tokens / original_tokens if original_tokens > 0 else 1.0

    return CompressResponse(
        compressed=compressed_text,
        original_tokens=original_tokens,
        compressed_tokens=compressed_tokens,
        ratio=round(actual_ratio, 4),
    )
