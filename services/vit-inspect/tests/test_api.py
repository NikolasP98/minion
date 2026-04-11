"""Tests for the ViT inference API server."""

import base64
import io
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient
from PIL import Image


def _create_test_image_b64() -> str:
    """Create a minimal test image as base64."""
    img = Image.new("RGB", (224, 224), color=(255, 0, 0))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode()


@pytest.fixture
def mock_model():
    """Mock the model loading for tests."""
    import torch

    model = MagicMock()
    # Return logits where class 1 (bottle_defect) has highest score
    logits = torch.zeros(1, 16)
    logits[0, 1] = 5.0  # High confidence for bottle_defect
    model.return_value = logits
    model.eval = MagicMock()
    return model


@pytest.fixture
def client(mock_model):
    """Create test client with mocked model."""
    import serve

    serve._model = mock_model
    serve._onnx_session = None
    serve._device = MagicMock()
    serve._config = MagicMock()
    serve._config.max_image_bytes = 10 * 1024 * 1024
    serve._config.confidence_threshold = 0.5

    # Mock transform
    import torch

    def fake_transform(img):
        return torch.randn(3, 224, 224)

    serve._transform = fake_transform

    return TestClient(serve.app, raise_server_exceptions=False)


class TestPredictEndpoint:
    def test_valid_image_returns_prediction(self, client):
        image_b64 = _create_test_image_b64()
        response = client.post("/predict", json={"image": image_b64})

        assert response.status_code == 200
        body = response.json()
        assert "defectType" in body
        assert "confidence" in body
        assert "pass" in body
        assert isinstance(body["confidence"], float)
        assert 0 <= body["confidence"] <= 1

    def test_missing_image_returns_422(self, client):
        response = client.post("/predict", json={})
        assert response.status_code == 422

    def test_invalid_base64_returns_400(self, client):
        response = client.post("/predict", json={"image": "not-valid-base64!!!"})
        assert response.status_code == 400


class TestHealthEndpoint:
    def test_health_returns_ok(self, client):
        response = client.get("/health")
        assert response.status_code == 200
        body = response.json()
        assert body["status"] == "ok"
        assert body["model_loaded"] is True
