"""Export trained ViT model to ONNX format with optional INT8 quantization."""

import argparse
import logging
from pathlib import Path

import torch

from config import TrainConfig
from model import load_model, resolve_device

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)


def export_to_onnx(
    model_path: Path,
    output_path: Path,
    cfg: TrainConfig,
    quantize_int8: bool = True,
) -> None:
    """Export PyTorch model to ONNX, optionally quantized to INT8."""
    device = torch.device("cpu")  # ONNX export must be on CPU
    model = load_model(model_path, cfg, device)
    model.eval()

    # Dummy input matching ViT-B/16 expected shape
    dummy_input = torch.randn(1, 3, cfg.image_size, cfg.image_size)

    # Export to ONNX
    fp32_path = output_path.with_suffix(".fp32.onnx")
    torch.onnx.export(
        model,
        dummy_input,
        str(fp32_path),
        opset_version=17,
        input_names=["image"],
        output_names=["logits"],
        dynamic_axes={
            "image": {0: "batch_size"},
            "logits": {0: "batch_size"},
        },
    )
    logger.info("Exported FP32 ONNX model to %s", fp32_path)

    if quantize_int8:
        try:
            from onnxruntime.quantization import QuantType, quantize_dynamic

            quantize_dynamic(
                str(fp32_path),
                str(output_path),
                weight_type=QuantType.QInt8,
            )
            logger.info("Exported INT8 quantized ONNX model to %s", output_path)

            # Report size reduction
            fp32_size = fp32_path.stat().st_size / (1024 * 1024)
            int8_size = output_path.stat().st_size / (1024 * 1024)
            logger.info(
                "Size reduction: %.1fMB → %.1fMB (%.0f%% smaller)",
                fp32_size,
                int8_size,
                (1 - int8_size / fp32_size) * 100,
            )
        except ImportError:
            logger.warning(
                "onnxruntime-tools not installed; skipping INT8 quantization. "
                "Install with: pip install onnxruntime"
            )
            # Use FP32 model as fallback
            fp32_path.rename(output_path)
    else:
        fp32_path.rename(output_path)


def main() -> None:
    parser = argparse.ArgumentParser(description="Export ViT model to ONNX")
    parser.add_argument(
        "--model-path",
        type=Path,
        default=Path("checkpoints/best_model.pt"),
    )
    parser.add_argument(
        "--output-path",
        type=Path,
        default=Path("checkpoints/model_int8.onnx"),
    )
    parser.add_argument("--no-quantize", action="store_true")
    args = parser.parse_args()

    cfg = TrainConfig()
    export_to_onnx(
        model_path=args.model_path,
        output_path=args.output_path,
        cfg=cfg,
        quantize_int8=not args.no_quantize,
    )


if __name__ == "__main__":
    main()
