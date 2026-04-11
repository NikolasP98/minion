FROM python:3.12-slim

WORKDIR /app

# Install build deps for any native extensions, then clean up.
RUN apt-get update && apt-get install -y --no-install-recommends \
      gcc \
      git \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py .

# The model is downloaded from Hugging Face on first run.
# To pre-bake it into the image, uncomment and set HF_HOME:
# ENV HF_HOME=/app/.cache/huggingface
# RUN python -c "from llmlingua import PromptCompressor; PromptCompressor('microsoft/llmlingua-2-xlm-roberta-large-meetingbank', use_llmlingua2=True, device_map='cpu')"

ENV LLMLINGUA_DEVICE=cpu
ENV PYTHONUNBUFFERED=1

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8080/health')" || exit 1

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "1"]
