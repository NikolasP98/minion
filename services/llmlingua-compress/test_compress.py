"""
Unit tests for the LLMLingua-2 compress service.

These tests mock the PromptCompressor so no GPU/model download is needed in CI.
Run with:
  pytest test_compress.py -v
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient


# ── Fixtures ───────────────────────────────────────────────────────────────────


@pytest.fixture
def mock_compressor():
    """Return a mock PromptCompressor that halves any input text."""

    def _compress(text: str, rate: float, **_kwargs):
        # Simulate compression: return first `rate` fraction of the text by words
        words = text.split()
        keep = max(1, int(len(words) * rate))
        return {"compressed_prompt": " ".join(words[:keep])}

    mock = MagicMock()
    mock.compress_prompt.side_effect = _compress
    return mock


@pytest.fixture
def client(mock_compressor):
    """FastAPI test client with the compressor pre-loaded."""
    with patch("main.PromptCompressor", return_value=mock_compressor):
        import main as app_module

        # Simulate model being loaded
        app_module._compressor = mock_compressor

        with TestClient(app_module.app, raise_server_exceptions=True) as c:
            yield c

        # Reset global state after test
        app_module._compressor = None


# ── /health ────────────────────────────────────────────────────────────────────


def test_health_returns_ok_when_model_loaded(client):
    resp = client.get("/health")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "ok"
    assert "model" in data


def test_health_returns_503_when_model_not_loaded():
    """Health returns 503 before the model is ready."""
    with patch("main.PromptCompressor"):
        import main as app_module

        app_module._compressor = None
        with TestClient(app_module.app) as c:
            resp = c.get("/health")
        assert resp.status_code == 503


# ── /compress ──────────────────────────────────────────────────────────────────


SHORT_TEXT = " ".join(f"word{i}" for i in range(50))
LONG_TEXT = " ".join(f"token{i}" for i in range(500))


def test_compress_returns_200_with_valid_body(client):
    resp = client.post("/compress", json={"text": SHORT_TEXT, "targetRatio": 0.5})
    assert resp.status_code == 200
    data = resp.json()
    assert "compressed" in data
    assert "originalTokens" in data
    assert "compressedTokens" in data
    assert "ratio" in data


def test_compress_ratio_field_is_float(client):
    resp = client.post("/compress", json={"text": SHORT_TEXT, "targetRatio": 0.5})
    assert isinstance(resp.json()["ratio"], float)


def test_compress_original_tokens_positive(client):
    resp = client.post("/compress", json={"text": SHORT_TEXT})
    assert resp.json()["originalTokens"] > 0


def test_compress_compressed_tokens_le_original(client):
    resp = client.post("/compress", json={"text": LONG_TEXT, "targetRatio": 0.4})
    data = resp.json()
    assert data["compressedTokens"] <= data["originalTokens"]


def test_compress_trivially_short_text_returns_as_is(client):
    """Text under 10 tokens is returned unchanged."""
    short = "hello world"
    resp = client.post("/compress", json={"text": short, "targetRatio": 0.5})
    assert resp.status_code == 200
    data = resp.json()
    assert data["compressed"] == short
    assert data["ratio"] == 1.0


def test_compress_default_ratio_is_half(client):
    """target_ratio defaults to 0.5 when omitted."""
    resp = client.post("/compress", json={"text": SHORT_TEXT})
    assert resp.status_code == 200


def test_compress_rejects_empty_text(client):
    resp = client.post("/compress", json={"text": "", "targetRatio": 0.5})
    assert resp.status_code == 422


def test_compress_rejects_ratio_below_minimum(client):
    resp = client.post("/compress", json={"text": SHORT_TEXT, "targetRatio": 0.05})
    assert resp.status_code == 422


def test_compress_rejects_ratio_above_maximum(client):
    resp = client.post("/compress", json={"text": SHORT_TEXT, "targetRatio": 1.0})
    assert resp.status_code == 422


def test_compress_returns_503_when_model_not_loaded():
    with patch("main.PromptCompressor"):
        import main as app_module

        app_module._compressor = None
        with TestClient(app_module.app) as c:
            resp = c.post("/compress", json={"text": SHORT_TEXT})
        assert resp.status_code == 503
