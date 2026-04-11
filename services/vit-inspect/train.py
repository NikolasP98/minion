"""
ViT-B/16 training script for MVTec AD defect detection.

Usage:
    python train.py
    python train.py --data-dir /path/to/mvtec_ad --epochs 100 --batch-size 16
"""

import argparse
import logging
import time
from pathlib import Path

import torch
import torch.nn as nn
from torch.optim import AdamW
from torch.optim.lr_scheduler import CosineAnnealingWarmRestarts
from torch.utils.data import DataLoader, random_split

from config import DEFECT_LABELS, TrainConfig
from dataset import MVTecADDataset, get_eval_transforms, get_train_transforms
from model import create_model, resolve_device

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)


def train_one_epoch(
    model: nn.Module,
    loader: DataLoader,
    criterion: nn.Module,
    optimizer: torch.optim.Optimizer,
    device: torch.device,
    epoch: int,
) -> tuple[float, float]:
    """Train for one epoch. Returns (avg_loss, accuracy)."""
    model.train()
    total_loss = 0.0
    correct = 0
    total = 0

    for batch_idx, (images, labels) in enumerate(loader):
        images, labels = images.to(device), labels.to(device)

        optimizer.zero_grad()
        outputs = model(images)
        loss = criterion(outputs, labels)
        loss.backward()
        optimizer.step()

        total_loss += loss.item() * images.size(0)
        _, predicted = outputs.max(1)
        correct += predicted.eq(labels).sum().item()
        total += labels.size(0)

        if (batch_idx + 1) % 10 == 0:
            logger.info(
                "Epoch %d [%d/%d] loss=%.4f acc=%.2f%%",
                epoch,
                batch_idx + 1,
                len(loader),
                loss.item(),
                100.0 * correct / total,
            )

    avg_loss = total_loss / total
    accuracy = 100.0 * correct / total
    return avg_loss, accuracy


@torch.no_grad()
def evaluate(
    model: nn.Module,
    loader: DataLoader,
    criterion: nn.Module,
    device: torch.device,
) -> tuple[float, float]:
    """Evaluate model. Returns (avg_loss, accuracy)."""
    model.eval()
    total_loss = 0.0
    correct = 0
    total = 0

    for images, labels in loader:
        images, labels = images.to(device), labels.to(device)
        outputs = model(images)
        loss = criterion(outputs, labels)

        total_loss += loss.item() * images.size(0)
        _, predicted = outputs.max(1)
        correct += predicted.eq(labels).sum().item()
        total += labels.size(0)

    avg_loss = total_loss / total
    accuracy = 100.0 * correct / total
    return avg_loss, accuracy


def main() -> None:
    parser = argparse.ArgumentParser(description="Train ViT-B/16 on MVTec AD")
    parser.add_argument("--data-dir", type=Path, default=Path("data/mvtec_ad"))
    parser.add_argument("--output-dir", type=Path, default=Path("checkpoints"))
    parser.add_argument("--epochs", type=int, default=50)
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument("--lr", type=float, default=1e-4)
    parser.add_argument("--device", type=str, default="auto")
    args = parser.parse_args()

    cfg = TrainConfig(
        data_dir=args.data_dir,
        output_dir=args.output_dir,
        num_epochs=args.epochs,
        batch_size=args.batch_size,
        learning_rate=args.lr,
        device=args.device,
    )

    device = resolve_device(cfg)
    logger.info("Using device: %s", device)

    # Load datasets
    train_dataset = MVTecADDataset(
        root=cfg.data_dir,
        split="train",
        transform=get_train_transforms(cfg),
    )
    test_dataset = MVTecADDataset(
        root=cfg.data_dir,
        split="test",
        transform=get_eval_transforms(cfg),
    )

    # Split test into val/test
    val_size = len(test_dataset) // 2
    test_size = len(test_dataset) - val_size
    val_dataset, test_dataset = random_split(test_dataset, [val_size, test_size])

    train_loader = DataLoader(
        train_dataset,
        batch_size=cfg.batch_size,
        shuffle=True,
        num_workers=4,
        pin_memory=True,
    )
    val_loader = DataLoader(
        val_dataset,
        batch_size=cfg.batch_size,
        shuffle=False,
        num_workers=4,
        pin_memory=True,
    )
    test_loader = DataLoader(
        test_dataset,
        batch_size=cfg.batch_size,
        shuffle=False,
        num_workers=4,
        pin_memory=True,
    )

    logger.info(
        "Dataset sizes — train: %d, val: %d, test: %d",
        len(train_dataset),
        len(val_dataset),
        len(test_dataset),
    )

    # Create model
    model = create_model(cfg)
    model = model.to(device)

    # Optimizer & scheduler
    criterion = nn.CrossEntropyLoss(label_smoothing=cfg.label_smoothing)
    optimizer = AdamW(
        filter(lambda p: p.requires_grad, model.parameters()),
        lr=cfg.learning_rate,
        weight_decay=cfg.weight_decay,
    )
    scheduler = CosineAnnealingWarmRestarts(
        optimizer,
        T_0=cfg.warmup_epochs,
        T_mult=2,
    )

    # Training loop
    cfg.output_dir.mkdir(parents=True, exist_ok=True)
    best_val_acc = 0.0

    for epoch in range(1, cfg.num_epochs + 1):
        start = time.time()
        train_loss, train_acc = train_one_epoch(
            model, train_loader, criterion, optimizer, device, epoch
        )
        val_loss, val_acc = evaluate(model, val_loader, criterion, device)
        scheduler.step()

        elapsed = time.time() - start
        logger.info(
            "Epoch %d/%d (%.1fs) — train_loss=%.4f train_acc=%.2f%% val_loss=%.4f val_acc=%.2f%%",
            epoch,
            cfg.num_epochs,
            elapsed,
            train_loss,
            train_acc,
            val_loss,
            val_acc,
        )

        # Save best model
        if val_acc > best_val_acc:
            best_val_acc = val_acc
            checkpoint = {
                "epoch": epoch,
                "model_state_dict": model.state_dict(),
                "optimizer_state_dict": optimizer.state_dict(),
                "val_acc": val_acc,
                "labels": DEFECT_LABELS,
            }
            torch.save(checkpoint, cfg.output_dir / "best_model.pt")
            logger.info("Saved best model (val_acc=%.2f%%)", val_acc)

    # Final test evaluation
    test_loss, test_acc = evaluate(model, test_loader, criterion, device)
    logger.info("Final test accuracy: %.2f%% (loss=%.4f)", test_acc, test_loss)

    if test_acc < 99.0:
        logger.warning(
            "Test accuracy %.2f%% is below 99%% target. "
            "Consider: more epochs, unfreezing more layers, or learning rate tuning.",
            test_acc,
        )


if __name__ == "__main__":
    main()
