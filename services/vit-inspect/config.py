"""Training and inference configuration for ViT-B/16 defect detection."""

from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class TrainConfig:
    """Hyperparameters for ViT-B/16 fine-tuning on MVTec AD."""

    # Model
    model_name: str = "vit_b_16"
    pretrained: bool = True
    num_classes: int = 16  # 15 defect categories + 1 "good" class
    freeze_layers: int = 8  # Freeze first N transformer blocks (out of 12)

    # Dataset
    data_dir: Path = Path("data/mvtec_ad")
    image_size: int = 224
    train_split: float = 0.8
    val_split: float = 0.1
    test_split: float = 0.1

    # Training
    batch_size: int = 32
    num_epochs: int = 50
    learning_rate: float = 1e-4
    weight_decay: float = 0.01
    warmup_epochs: int = 5
    label_smoothing: float = 0.1

    # Augmentation
    aug_rotation: float = 15.0
    aug_hflip_prob: float = 0.5
    aug_vflip_prob: float = 0.3
    aug_color_jitter: float = 0.2
    aug_gaussian_noise_std: float = 0.02

    # Output
    output_dir: Path = Path("checkpoints")
    export_onnx: bool = True

    # Device
    device: str = "auto"  # "auto", "cuda", "cpu"


@dataclass
class ServeConfig:
    """Configuration for the inference FastAPI server."""

    model_path: Path = Path("checkpoints/best_model.pt")
    onnx_path: Path | None = Path("checkpoints/model_int8.onnx")
    use_onnx: bool = True
    host: str = "0.0.0.0"
    port: int = 8100
    confidence_threshold: float = 0.5
    max_image_bytes: int = 10 * 1024 * 1024  # 10MB


# MVTec AD categories
MVTEC_CATEGORIES: list[str] = [
    "bottle",
    "cable",
    "capsule",
    "carpet",
    "grid",
    "hazelnut",
    "leather",
    "metal_nut",
    "pill",
    "screw",
    "tile",
    "toothbrush",
    "transistor",
    "wood",
    "zipper",
]

# Classification labels: "good" + each category's defect types
DEFECT_LABELS: list[str] = ["good"] + [f"{cat}_defect" for cat in MVTEC_CATEGORIES]
