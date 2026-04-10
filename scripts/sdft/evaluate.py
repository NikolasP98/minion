#!/usr/bin/env python3
"""
SDFT Phase 1 - Evaluation

Runs held-out role-specific tasks against base model vs fine-tuned model.
Measures task success rate, response quality (LLM-judge), and latency.

Architecture review (MIN-600) compliance:
  - M3: Minimum 200 held-out examples (increased from original 50)
  - M3: Multiple eval runs with error bars for statistical rigor
  - Regression checks on GSM8K (within 2%) and HumanEval (within 2%)

Usage:
  python scripts/sdft/evaluate.py \
    --base-model meta-llama/Llama-3.3-70B-Instruct \
    --adapter-path models/sdft-llama-70b-lora \
    --eval-dataset data/eval-dataset.jsonl \
    --output data/eval-results.json \
    --judge-api-key "$ANTHROPIC_API_KEY" \
    --min-examples 200 \
    --num-runs 3
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import statistics
import sys
import time
from pathlib import Path
from typing import Any

import anthropic
import torch
from peft import PeftModel
from transformers import (
    AutoModelForCausalLM,
    AutoTokenizer,
    BitsAndBytesConfig,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger(__name__)

# QLoRA config matching fine-tune.py
QUANTIZATION_CONFIG = BitsAndBytesConfig(
    load_in_4bit=True,
    bnb_4bit_quant_type="nf4",
    bnb_4bit_compute_dtype=torch.bfloat16,
    bnb_4bit_use_double_quant=True,
)

LLM_JUDGE_SYSTEM = """You are an expert evaluator of AI agent responses. Given a task and two responses (A from the base model, B from the fine-tuned model), rate each on:

1. **Correctness** (1-5): Is the answer factually correct and complete?
2. **Relevance** (1-5): Does it address the specific task requirements?
3. **Reasoning Quality** (1-5): Is the reasoning clear, logical, and well-structured?
4. **Efficiency** (1-5): Is the response concise without unnecessary steps?

Output a JSON object:
{
  "base_scores": {"correctness": N, "relevance": N, "reasoning": N, "efficiency": N},
  "finetuned_scores": {"correctness": N, "relevance": N, "reasoning": N, "efficiency": N},
  "winner": "base" | "finetuned" | "tie",
  "explanation": "Brief explanation of your judgment"
}

Be objective. Do not assume the fine-tuned model is better."""


def load_eval_dataset(path: Path, min_examples: int) -> list[dict[str, Any]]:
    """Load evaluation dataset and validate minimum size."""
    records = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line:
                records.append(json.loads(line))

    if len(records) < min_examples:
        logger.error(
            "Eval dataset has %d examples (minimum required: %d). "
            "Architecture review M3 requires >= 200 held-out examples.",
            len(records),
            min_examples,
        )
        sys.exit(1)

    logger.info("Loaded %d eval examples (minimum: %d)", len(records), min_examples)
    return records


def load_model_and_tokenizer(
    model_name: str,
    adapter_path: Path | None = None,
) -> tuple[Any, Any]:
    """Load base model (optionally with LoRA adapter) using QLoRA."""
    tokenizer = AutoTokenizer.from_pretrained(model_name, trust_remote_code=True)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    model = AutoModelForCausalLM.from_pretrained(
        model_name,
        quantization_config=QUANTIZATION_CONFIG,
        device_map="auto",
        trust_remote_code=True,
        torch_dtype=torch.bfloat16,
    )

    if adapter_path:
        logger.info("Loading LoRA adapter from %s...", adapter_path)
        model = PeftModel.from_pretrained(model, str(adapter_path))

    model.eval()
    return model, tokenizer


def generate_response(
    model: Any,
    tokenizer: Any,
    prompt: str,
    max_new_tokens: int = 1024,
) -> tuple[str, float]:
    """Generate a response and measure latency."""
    inputs = tokenizer(prompt, return_tensors="pt", truncation=True, max_length=2048)
    inputs = {k: v.to(model.device) for k, v in inputs.items()}

    start = time.perf_counter()
    with torch.no_grad():
        outputs = model.generate(
            **inputs,
            max_new_tokens=max_new_tokens,
            do_sample=True,
            temperature=0.7,
            top_p=0.9,
            pad_token_id=tokenizer.pad_token_id,
        )
    latency = time.perf_counter() - start

    response = tokenizer.decode(
        outputs[0][inputs["input_ids"].shape[1]:],
        skip_special_tokens=True,
    )
    return response, latency


def format_eval_prompt(example: dict[str, Any]) -> str:
    """Format an eval example into a model prompt."""
    role = example.get("agent_role", "general")
    task = example.get("task", "")
    return (
        f"<|system|>You are an expert {role} AI agent. "
        f"Think step by step before acting.</s>\n"
        f"<|user|>{task}</s>\n"
        f"<|assistant|>"
    )


async def judge_pair(
    client: anthropic.AsyncAnthropic,
    task: str,
    base_response: str,
    finetuned_response: str,
    semaphore: asyncio.Semaphore,
) -> dict[str, Any] | None:
    """Use LLM judge to compare base vs fine-tuned response."""
    async with semaphore:
        user_prompt = (
            f"## Task\n{task}\n\n"
            f"## Response A (Base Model)\n{base_response[:2000]}\n\n"
            f"## Response B (Fine-Tuned Model)\n{finetuned_response[:2000]}"
        )

        try:
            response = await client.messages.create(
                model="claude-sonnet-4-6",
                max_tokens=1024,
                system=LLM_JUDGE_SYSTEM,
                messages=[{"role": "user", "content": user_prompt}],
            )

            content = response.content[0].text
            json_start = content.find("{")
            json_end = content.rfind("}") + 1
            if json_start >= 0 and json_end > json_start:
                return json.loads(content[json_start:json_end])
        except (json.JSONDecodeError, anthropic.APIError) as e:
            logger.warning("Judge error: %s", e)

    return None


def compute_stats(values: list[float]) -> dict[str, float]:
    """Compute mean, std, and 95% CI for a list of values."""
    if not values:
        return {"mean": 0, "std": 0, "ci_95_low": 0, "ci_95_high": 0, "n": 0}

    n = len(values)
    mean = statistics.mean(values)
    std = statistics.stdev(values) if n > 1 else 0
    ci_margin = 1.96 * std / (n ** 0.5) if n > 1 else 0

    return {
        "mean": round(mean, 4),
        "std": round(std, 4),
        "ci_95_low": round(mean - ci_margin, 4),
        "ci_95_high": round(mean + ci_margin, 4),
        "n": n,
    }


async def run_evaluation(
    base_model: Any,
    base_tokenizer: Any,
    ft_model: Any,
    ft_tokenizer: Any,
    eval_data: list[dict[str, Any]],
    judge_client: anthropic.AsyncAnthropic,
    run_idx: int,
) -> dict[str, Any]:
    """Run a single evaluation pass over all examples."""
    logger.info("Evaluation run %d: processing %d examples...", run_idx + 1, len(eval_data))

    base_latencies: list[float] = []
    ft_latencies: list[float] = []
    judge_results: list[dict[str, Any]] = []
    wins = {"base": 0, "finetuned": 0, "tie": 0}

    semaphore = asyncio.Semaphore(5)

    for i, example in enumerate(eval_data):
        prompt = format_eval_prompt(example)
        task = example.get("task", "")

        base_resp, base_lat = generate_response(base_model, base_tokenizer, prompt)
        ft_resp, ft_lat = generate_response(ft_model, ft_tokenizer, prompt)

        base_latencies.append(base_lat)
        ft_latencies.append(ft_lat)

        # LLM judge comparison
        judgment = await judge_pair(
            judge_client, task, base_resp, ft_resp, semaphore
        )
        if judgment:
            judge_results.append(judgment)
            winner = judgment.get("winner", "tie")
            if winner in wins:
                wins[winner] += 1

        if (i + 1) % 25 == 0:
            logger.info("  Run %d: %d/%d examples done", run_idx + 1, i + 1, len(eval_data))

    # Compute per-run metrics
    ft_win_rate = wins["finetuned"] / max(len(judge_results), 1)

    base_scores_all = [j["base_scores"] for j in judge_results if "base_scores" in j]
    ft_scores_all = [j["finetuned_scores"] for j in judge_results if "finetuned_scores" in j]

    def avg_score(scores: list[dict[str, int]], key: str) -> float:
        vals = [s[key] for s in scores if key in s]
        return statistics.mean(vals) if vals else 0

    return {
        "run": run_idx + 1,
        "num_examples": len(eval_data),
        "num_judged": len(judge_results),
        "wins": wins,
        "finetuned_win_rate": round(ft_win_rate, 4),
        "latency": {
            "base": compute_stats(base_latencies),
            "finetuned": compute_stats(ft_latencies),
        },
        "quality_scores": {
            "base": {
                k: round(avg_score(base_scores_all, k), 2)
                for k in ["correctness", "relevance", "reasoning", "efficiency"]
            },
            "finetuned": {
                k: round(avg_score(ft_scores_all, k), 2)
                for k in ["correctness", "relevance", "reasoning", "efficiency"]
            },
        },
    }


def check_regression(
    results: dict[str, Any],
    gsm8k_base: float,
    gsm8k_ft: float,
    humaneval_base: float,
    humaneval_ft: float,
) -> dict[str, Any]:
    """Check for regression on general benchmarks (within 2% tolerance)."""
    gsm8k_delta = gsm8k_ft - gsm8k_base
    humaneval_delta = humaneval_ft - humaneval_base

    return {
        "gsm8k": {
            "base": gsm8k_base,
            "finetuned": gsm8k_ft,
            "delta": round(gsm8k_delta, 4),
            "regression": gsm8k_delta < -0.02,
            "pass": gsm8k_delta >= -0.02,
        },
        "humaneval": {
            "base": humaneval_base,
            "finetuned": humaneval_ft,
            "delta": round(humaneval_delta, 4),
            "regression": humaneval_delta < -0.02,
            "pass": humaneval_delta >= -0.02,
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Evaluate base model vs QLoRA fine-tuned model"
    )
    parser.add_argument(
        "--base-model",
        default="meta-llama/Llama-3.3-70B-Instruct",
        help="Base model name/path",
    )
    parser.add_argument(
        "--adapter-path",
        type=Path,
        default=Path("models/sdft-llama-70b-lora"),
        help="Path to LoRA adapter",
    )
    parser.add_argument(
        "--eval-dataset",
        type=Path,
        default=Path("data/eval-dataset.jsonl"),
        help="Evaluation dataset JSONL",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("data/eval-results.json"),
        help="Output results JSON",
    )
    parser.add_argument(
        "--judge-api-key",
        required=True,
        help="Anthropic API key for LLM judge",
    )
    parser.add_argument(
        "--min-examples",
        type=int,
        default=200,
        help="Minimum held-out examples required (M3 compliance: >= 200)",
    )
    parser.add_argument(
        "--num-runs",
        type=int,
        default=3,
        help="Number of evaluation runs for error bars (M3 compliance)",
    )
    parser.add_argument(
        "--gsm8k-base",
        type=float,
        default=None,
        help="GSM8K accuracy for base model (provide pre-computed)",
    )
    parser.add_argument(
        "--gsm8k-ft",
        type=float,
        default=None,
        help="GSM8K accuracy for fine-tuned model (provide pre-computed)",
    )
    parser.add_argument(
        "--humaneval-base",
        type=float,
        default=None,
        help="HumanEval pass@1 for base model (provide pre-computed)",
    )
    parser.add_argument(
        "--humaneval-ft",
        type=float,
        default=None,
        help="HumanEval pass@1 for fine-tuned model (provide pre-computed)",
    )

    args = parser.parse_args()

    if not args.eval_dataset.exists():
        logger.error("Eval dataset not found: %s", args.eval_dataset)
        sys.exit(1)

    if not args.adapter_path.exists():
        logger.error("LoRA adapter not found: %s", args.adapter_path)
        sys.exit(1)

    # Load eval data with M3 minimum check
    eval_data = load_eval_dataset(args.eval_dataset, args.min_examples)

    # Load models
    logger.info("Loading base model: %s", args.base_model)
    base_model, base_tokenizer = load_model_and_tokenizer(args.base_model)

    logger.info("Loading fine-tuned model with adapter: %s", args.adapter_path)
    ft_model, ft_tokenizer = load_model_and_tokenizer(
        args.base_model, args.adapter_path
    )

    # Initialize judge
    judge_client = anthropic.AsyncAnthropic(api_key=args.judge_api_key)

    # Multiple eval runs for statistical rigor (M3 compliance)
    all_runs: list[dict[str, Any]] = []
    for run_idx in range(args.num_runs):
        run_result = asyncio.run(
            run_evaluation(
                base_model, base_tokenizer,
                ft_model, ft_tokenizer,
                eval_data, judge_client,
                run_idx,
            )
        )
        all_runs.append(run_result)

    # Aggregate across runs
    win_rates = [r["finetuned_win_rate"] for r in all_runs]
    win_rate_stats = compute_stats(win_rates)

    aggregate = {
        "model": args.base_model,
        "adapter": str(args.adapter_path),
        "num_eval_examples": len(eval_data),
        "num_runs": args.num_runs,
        "aggregate_win_rate": win_rate_stats,
        "per_run": all_runs,
    }

    # Regression check if benchmark scores provided
    if all(v is not None for v in [
        args.gsm8k_base, args.gsm8k_ft, args.humaneval_base, args.humaneval_ft
    ]):
        aggregate["regression_check"] = check_regression(
            aggregate,
            args.gsm8k_base, args.gsm8k_ft,
            args.humaneval_base, args.humaneval_ft,
        )

    # Acceptance criteria check
    improvement_target = 0.10  # >= 10%
    mean_win_rate = win_rate_stats["mean"]
    meets_target = mean_win_rate >= (0.5 + improvement_target / 2)

    aggregate["acceptance"] = {
        "target_improvement": f">= {improvement_target * 100:.0f}%",
        "measured_win_rate": win_rate_stats,
        "meets_target": meets_target,
    }

    # Write results
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with open(args.output, "w") as f:
        json.dump(aggregate, f, indent=2)

    logger.info("Evaluation complete.")
    logger.info("  Win rate: %.1f%% +/- %.1f%% (95%% CI: %.1f%%-%.1f%%)",
                mean_win_rate * 100,
                win_rate_stats["std"] * 100,
                win_rate_stats["ci_95_low"] * 100,
                win_rate_stats["ci_95_high"] * 100)
    logger.info("  Meets target: %s", meets_target)
    logger.info("  Results: %s", args.output)

    if not meets_target:
        logger.warning(
            "Fine-tuned model did not meet the >= 10%% improvement target. "
            "Review training hyperparameters, dataset quality, or increase data."
        )


if __name__ == "__main__":
    main()
