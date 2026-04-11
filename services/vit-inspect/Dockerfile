FROM python:3.12-slim AS base

WORKDIR /app

# Install system dependencies for image processing
RUN apt-get update && \
    apt-get install -y --no-install-recommends libgl1-mesa-glx libglib2.0-0 && \
    rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Create checkpoints directory for model weights volume mount
RUN mkdir -p /app/checkpoints

EXPOSE 8100

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8100/health')"

CMD ["uvicorn", "serve:app", "--host", "0.0.0.0", "--port", "8100"]
