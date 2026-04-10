#!/usr/bin/env python3
"""
SDFT Phase 1 - QLoRA Fine-Tuning

LoRA fine-tuning via Hugging Face PEFT on Llama 3.3 70B using QLoRA
(4-bit quantization via bitsandbytes) to fit within single-GPU VRAM.

Architecture review (MIN-600) compliance:
  - C2: Uses QLoRA with 4-bit NF4 quantization (bitsandbytes)
  - C2: GPU requirement: single A100 80GB or equivalent
  - LoRA only (no full fine-tuning) per project constraints

Config: rank=16, alpha=32, target_modules=["q_proj", "v_proj"]
Training: 80/20 train/eval split, checkpoint every 100 steps

Usage:
  python scripts/sdft/fine-tune.py \
    --dataset data/distillation-dataset.jsonl \
    --output-dir models/sdft-llama-70b-lora \
    --model-name meta-llama/Llama-3.3-70B-Instruct \
    --epochs 3 \
    --batch-size 1 \
    --gradient-accumulation 16 \
    --learning-rate 2e-4
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path
from typing import Any

import torch
from datasets import Dataset
from peft import (
    LoraConfig,
    TaskType,
    get_peft_model,
    prepare_model_for_kbit_training,
)
from transformers import (
    AutoModelForCausalLM,
    AutoTokenizer,
    BitsAndBytesConfig,
    DataCollatorForLanguageModeling,
    Trainer,
    TrainingArguments,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger(__name__)

# LoRA configuration (per plan + architecture review m3)
LORA_CONFIG = {
    "r": 16,               # LoRA rank
    "lora_alpha": 32,       # LoRA alpha scaling
    "lora_dropout": 0.05,
    "target_modules": ["q_proj", "v_proj"],
    "bias": "none",
    "task_type": TaskType.CAUSAL_LM,
}

# QLoRA quantization config (addresses C2 - fits 70B on single A100 80GB)
QUANTIZATION_CONFIG = BitsAndBytesConfig(
    load_in_4bit=True,
    bnb_4bit_quant_type="nf4",           # NormalFloat4 - best for LLM weights
    bnb_4bit_compute_dtype=torch.bfloat16,
    bnb_4bit_use_double_quant=True,      # nested quantization for extra savings
)

MAX_SEQ_LENGTH = 2048


def format_training_example(record: dict[str, Any]) -> str:
    """
    Convert a distillation dataset record into a training prompt.
    Combines the task, trajectory, and teacher reasoning annotation.
    """
    parts = []

    # System context
    role = record.get("agent_role", "general")
    parts.append(f"<|system|>You are an expert {role} AI agent. "
                 f"Think step by step before acting.</s>")

    # Task
    task = record.get("task", "")
    parts.append(f"<|user|>{task}</s>")

    # Teacher annotation as the target reasoning
    annotation = record.get("teacher_annotation", {})
    strategy = annotation.get("overall_strategy", "")
    reasoning_trace = annotation.get("reasoning_trace", [])

    response_parts = []
    if strategy:
        response_parts.append(f"Strategy: {strategy}")

    for step in reasoning_trace:
        step_num = step.get("step", "?")
        action = step.get("action_summary", "")
        reasoning = step.get("reasoning", "")
        response_parts.append(
            f"Step {step_num}: {action}\nReasoning: {reasoning}"
        )

    outcome = record.get("outcome", "")
    if outcome:
        response_parts.append(f"Outcome: {outcome}")

    parts.append(f"<|assistant|>{chr(10).join(response_parts)}</s>")

    return "\n".join(parts)


def load_dataset(path: Path) -> list[dict[str, Any]]:
    """Load distillation dataset from JSONL."""
    records = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line:
                records.append(json.loads(line))
    return records


def tokenize_dataset(
    records: list[dict[str, Any]],
    tokenizer: AutoTokenizer,
) -> Dataset:
    """Tokenize training examples into HF Dataset."""
    texts = [format_training_example(r) for r in records]

    def tokenize_fn(examples: dict[str, list[str]]) -> dict[str, list[Any]]:
        return tokenizer(
            examples["text"],
            truncation=True,
            max_length=MAX_SEQ_LENGTH,
            padding="max_length",
        )

    dataset = Dataset.from_dict({"text": texts})
    tokenized = dataset.map(
        tokenize_fn,
        batched=True,
        remove_columns=["text"],
    )
    return tokenized


def main() -> None:
    parser = argparse.ArgumentParser(
        description="QLoRA fine-tuning on distillation dataset"
    )
    parser.add_argument(
        "--dataset",
        type=Path,
        default=Path("data/distillation-dataset.jsonl"),
        help="Distillation dataset JSONL",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("models/sdft-llama-70b-lora"),
        help="Output directory for LoRA adapter",
    )
    parser.add_argument(
        "--model-name",
        default="meta-llama/Llama-3.3-70B-Instruct",
        help="Base model name/path",
    )
    parser.add_argument(
        "--epochs",
        type=int,
        default=3,
        help="Number of training epochs",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=1,
        help="Per-device training batch size",
    )
    parser.add_argument(
        "--gradient-accumulation",
        type=int,
        default=16,
        help="Gradient accumulation steps (effective batch = batch_size * this)",
    )
    parser.add_argument(
        "--learning-rate",
        type=float,
        default=2e-4,
        help="Learning rate",
    )
    parser.add_argument(
        "--checkpoint-steps",
        type=int,
        default=100,
        help="Save checkpoint every N steps",
    )
    parser.add_argument(
        "--eval-split",
        type=float,
        default=0.2,
        help="Fraction of data for evaluation (default: 20%%)",
    )
    parser.add_argument(
        "--resume-from",
        type=Path,
        default=None,
        help="Resume training from a checkpoint directory",
    )

    args = parser.parse_args()

    if not args.dataset.exists():
        logger.error("Dataset not found: %s", args.dataset)
        sys.exit(1)

    # Check GPU availability
    if not torch.cuda.is_available():
        logger.error("CUDA not available. QLoRA requires a GPU.")
        sys.exit(1)

    gpu_name = torch.cuda.get_device_name(0)
    gpu_mem_gb = torch.cuda.get_device_properties(0).total_mem / (1024**3)
    logger.info("GPU: %s (%.1f GB VRAM)", gpu_name, gpu_mem_gb)

    if gpu_mem_gb < 40:
        logger.warning(
            "GPU has %.1f GB VRAM. QLoRA on 70B requires ~40GB minimum "
            "(recommended: 80GB A100). OOM errors likely.",
            gpu_mem_gb,
        )

    # Load dataset
    logger.info("Loading dataset from %s...", args.dataset)
    records = load_dataset(args.dataset)
    logger.info("Loaded %d records", len(records))

    # Load tokenizer
    logger.info("Loading tokenizer for %s...", args.model_name)
    tokenizer = AutoTokenizer.from_pretrained(
        args.model_name,
        trust_remote_code=True,
    )
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    # Tokenize and split
    logger.info("Tokenizing dataset...")
    full_dataset = tokenize_dataset(records, tokenizer)

    split = full_dataset.train_test_split(test_size=args.eval_split, seed=42)
    train_dataset = split["train"]
    eval_dataset = split["test"]
    logger.info(
        "Split: %d train, %d eval (%.0f%%/%.0f%%)",
        len(train_dataset),
        len(eval_dataset),
        (1 - args.eval_split) * 100,
        args.eval_split * 100,
    )

    # Load model with QLoRA 4-bit quantization (C2 compliance)
    logger.info(
        "Loading %s with QLoRA 4-bit quantization (NF4)...", args.model_name
    )
    model = AutoModelForCausalLM.from_pretrained(
        args.model_name,
        quantization_config=QUANTIZATION_CONFIG,
        device_map="auto",
        trust_remote_code=True,
        torch_dtype=torch.bfloat16,
    )

    # Prepare model for k-bit training
    model = prepare_model_for_kbit_training(model)

    # Apply LoRA
    lora_config = LoraConfig(**LORA_CONFIG)
    model = get_peft_model(model, lora_config)

    trainable, total = model.get_nb_trainable_parameters()
    logger.info(
        "Trainable parameters: %s / %s (%.2f%%)",
        f"{trainable:,}",
        f"{total:,}",
        100 * trainable / total,
    )

    # Training arguments
    args.output_dir.mkdir(parents=True, exist_ok=True)

    training_args = TrainingArguments(
        output_dir=str(args.output_dir),
        num_train_epochs=args.epochs,
        per_device_train_batch_size=args.batch_size,
        per_device_eval_batch_size=args.batch_size,
        gradient_accumulation_steps=args.gradient_accumulation,
        learning_rate=args.learning_rate,
        weight_decay=0.01,
        warmup_ratio=0.03,
        lr_scheduler_type="cosine",
        logging_steps=10,
        save_steps=args.checkpoint_steps,
        eval_strategy="steps",
        eval_steps=args.checkpoint_steps,
        save_total_limit=3,
        load_best_model_at_end=True,
        metric_for_best_model="eval_loss",
        greater_is_better=False,
        fp16=False,
        bf16=True,
        gradient_checkpointing=True,
        optim="paged_adamw_8bit",
        report_to="none",
        dataloader_num_workers=4,
        group_by_length=True,
    )

    # Data collator
    data_collator = DataCollatorForLanguageModeling(
        tokenizer=tokenizer,
        mlm=False,
    )

    # Trainer
    trainer = Trainer(
        model=model,
        args=training_args,
        train_dataset=train_dataset,
        eval_dataset=eval_dataset,
        data_collator=data_collator,
    )

    # Train
    logger.info("Starting QLoRA fine-tuning...")
    resume_checkpoint = str(args.resume_from) if args.resume_from else None
    train_result = trainer.train(resume_from_checkpoint=resume_checkpoint)

    # Save final adapter
    logger.info("Saving LoRA adapter to %s...", args.output_dir)
    model.save_pretrained(str(args.output_dir))
    tokenizer.save_pretrained(str(args.output_dir))

    # Log training metrics
    metrics = train_result.metrics
    trainer.log_metrics("train", metrics)
    trainer.save_metrics("train", metrics)

    # Run final eval
    eval_metrics = trainer.evaluate()
    trainer.log_metrics("eval", eval_metrics)
    trainer.save_metrics("eval", eval_metrics)

    logger.info("Training complete.")
    logger.info("  Train loss: %.4f", metrics.get("train_loss", -1))
    logger.info("  Eval loss:  %.4f", eval_metrics.get("eval_loss", -1))
    logger.info("  Adapter:    %s", args.output_dir)


if __name__ == "__main__":
    main()
