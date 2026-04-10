#!/usr/bin/env bash
# SDFT Phase 1 - Environment setup
# Run once before using the SDFT scripts.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Installing Python dependencies..."
pip install -r "$SCRIPT_DIR/requirements.txt"

echo "Downloading spaCy NER model for PII scrubbing..."
python -m spacy download en_core_web_lg

echo "Creating data directories..."
mkdir -p data models/sdft-llama-70b-lora

echo "Setup complete. Run scripts in order:"
echo "  1. python scripts/sdft/collect-trajectories.py --help"
echo "  2. python scripts/sdft/generate-distillation-dataset.py --help"
echo "  3. python scripts/sdft/fine-tune.py --help"
echo "  4. python scripts/sdft/evaluate.py --help"
