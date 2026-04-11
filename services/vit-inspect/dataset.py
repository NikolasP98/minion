"""MVTec AD dataset loader with synthetic augmentation for ViT training."""

import logging
from pathlib import Path

import torch
from PIL import Image
from torch.utils.data import Dataset
from torchvision import transforms

from config import MVTEC_CATEGORIES, TrainConfig

logger = logging.getLogger(__name__)


def get_train_transforms(cfg: TrainConfig) -> transforms.Compose:
    """Training augmentation pipeline for cold-start generalization."""
    return transforms.Compose([
        transforms.Resize((cfg.image_size, cfg.image_size)),
        transforms.RandomRotation(cfg.aug_rotation),
        transforms.RandomHorizontalFlip(p=cfg.aug_hflip_prob),
        transforms.RandomVerticalFlip(p=cfg.aug_vflip_prob),
        transforms.ColorJitter(
            brightness=cfg.aug_color_jitter,
            contrast=cfg.aug_color_jitter,
            saturation=cfg.aug_color_jitter,
            hue=cfg.aug_color_jitter * 0.5,
        ),
        transforms.RandomErasing(p=0.3, scale=(0.02, 0.1)),
        transforms.ToTensor(),
        transforms.Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225]),
        AddGaussianNoise(std=cfg.aug_gaussian_noise_std),
    ])


def get_eval_transforms(cfg: TrainConfig) -> transforms.Compose:
    """Evaluation/inference transforms (no augmentation)."""
    return transforms.Compose([
        transforms.Resize((cfg.image_size, cfg.image_size)),
        transforms.ToTensor(),
        transforms.Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225]),
    ])


class AddGaussianNoise:
    """Add Gaussian noise to tensor for robustness."""

    def __init__(self, std: float = 0.02):
        self.std = std

    def __call__(self, tensor: torch.Tensor) -> torch.Tensor:
        if self.std > 0:
            noise = torch.randn_like(tensor) * self.std
            return torch.clamp(tensor + noise, 0.0, 1.0)
        return tensor


class MVTecADDataset(Dataset):
    """
    MVTec AD dataset loader.

    Expected directory structure:
        data/mvtec_ad/
        ├── bottle/
        │   ├── train/good/
        │   └── test/
        │       ├── good/
        │       ├── broken_large/
        │       ├── broken_small/
        │       └── contamination/
        ├── cable/
        │   ├── train/good/
        │   └── test/...
        └── ...
    """

    def __init__(
        self,
        root: Path,
        split: str = "train",
        transform: transforms.Compose | None = None,
    ):
        self.root = root
        self.split = split
        self.transform = transform
        self.samples: list[tuple[Path, int]] = []
        self.class_to_idx: dict[str, int] = {"good": 0}

        self._build_dataset()

    def _build_dataset(self) -> None:
        """Scan the MVTec AD directory and build sample list."""
        label_idx = 1

        for category in MVTEC_CATEGORIES:
            cat_dir = self.root / category

            if self.split == "train":
                # Training only has "good" samples
                good_dir = cat_dir / "train" / "good"
                if good_dir.exists():
                    for img_path in sorted(good_dir.glob("*.png")):
                        self.samples.append((img_path, 0))  # "good" label
            else:
                # Test has both good and defective samples
                test_dir = cat_dir / "test"
                if not test_dir.exists():
                    continue

                for defect_dir in sorted(test_dir.iterdir()):
                    if not defect_dir.is_dir():
                        continue

                    if defect_dir.name == "good":
                        label = 0
                    else:
                        defect_key = f"{category}_defect"
                        if defect_key not in self.class_to_idx:
                            self.class_to_idx[defect_key] = label_idx
                            label_idx += 1
                        label = self.class_to_idx[defect_key]

                    for img_path in sorted(defect_dir.glob("*.png")):
                        self.samples.append((img_path, label))

        logger.info(
            "Loaded %d samples for split=%s (%d classes)",
            len(self.samples),
            self.split,
            len(self.class_to_idx),
        )

    def __len__(self) -> int:
        return len(self.samples)

    def __getitem__(self, idx: int) -> tuple[torch.Tensor, int]:
        img_path, label = self.samples[idx]
        image = Image.open(img_path).convert("RGB")

        if self.transform:
            image = self.transform(image)

        return image, label
