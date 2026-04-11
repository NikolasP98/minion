"""ViT-B/16 model architecture for manufacturing defect classification."""

import logging
from pathlib import Path

import torch
import torch.nn as nn
from torchvision.models import ViT_B_16_Weights, vit_b_16

from config import TrainConfig

logger = logging.getLogger(__name__)


def create_model(cfg: TrainConfig) -> nn.Module:
    """
    Create ViT-B/16 model with modified classification head.

    Strategy:
    - Load ImageNet pre-trained weights
    - Freeze early transformer blocks (first `freeze_layers`)
    - Replace classification head for defect detection
    - Train last 4 blocks + head
    """
    weights = ViT_B_16_Weights.IMAGENET1K_V1 if cfg.pretrained else None
    model = vit_b_16(weights=weights)

    # Freeze early transformer encoder blocks
    for i, block in enumerate(model.encoder.layers):
        if i < cfg.freeze_layers:
            for param in block.parameters():
                param.requires_grad = False

    # Also freeze the conv_proj (patch embedding) and positional embedding
    for param in model.conv_proj.parameters():
        param.requires_grad = False

    # Replace classification head
    in_features = model.heads.head.in_features
    model.heads.head = nn.Sequential(
        nn.LayerNorm(in_features),
        nn.Dropout(p=0.1),
        nn.Linear(in_features, 512),
        nn.GELU(),
        nn.Dropout(p=0.1),
        nn.Linear(512, cfg.num_classes),
    )

    trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
    total = sum(p.numel() for p in model.parameters())
    logger.info(
        "Model created: %d/%d params trainable (%.1f%%)",
        trainable,
        total,
        100.0 * trainable / total,
    )

    return model


def load_model(model_path: Path, cfg: TrainConfig, device: torch.device) -> nn.Module:
    """Load a trained model from checkpoint."""
    model = create_model(cfg)
    checkpoint = torch.load(model_path, map_location=device, weights_only=True)

    if "model_state_dict" in checkpoint:
        model.load_state_dict(checkpoint["model_state_dict"])
    else:
        model.load_state_dict(checkpoint)

    model.to(device)
    model.eval()
    logger.info("Loaded model from %s", model_path)
    return model


def resolve_device(cfg: TrainConfig) -> torch.device:
    """Resolve the compute device based on config."""
    if cfg.device == "auto":
        if torch.cuda.is_available():
            return torch.device("cuda")
        if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            return torch.device("mps")
        return torch.device("cpu")
    return torch.device(cfg.device)
