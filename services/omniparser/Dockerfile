# OmniParser-v2 microservice
# Build: docker build --build-arg B2_BUCKET_URL=<url> -t minion-omniparser .
FROM python:3.11-slim

# Install system deps for Pillow, GL (torch), and font rendering
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1-mesa-glx \
    libglib2.0-0 \
    fonts-dejavu-core \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python deps first for layer caching
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Download model weights from Backblaze B2 at build time.
# Override B2_BUCKET_URL when your weights live in a different bucket.
ARG B2_BUCKET_URL=https://f005.backblazeb2.com/file/minion-models
ENV MODELS_DIR=/models

RUN mkdir -p /models/icon_detect /models/icon_caption_florence \
    && curl -fsSL "${B2_BUCKET_URL}/icon_detect/model.pt" \
         -o /models/icon_detect/model.pt \
    && curl -fsSL "${B2_BUCKET_URL}/icon_caption_florence.tar.gz" \
         | tar -xz -C /models/icon_caption_florence --strip-components=1

COPY app.py .

EXPOSE 8080

# Run as non-root
RUN adduser --disabled-password --gecos "" appuser \
    && chown -R appuser /app /models
USER appuser

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8080"]
