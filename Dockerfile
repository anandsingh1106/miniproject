# syntax=docker/dockerfile:1

# ---- build stage: vendor the frontend assets -------------------------------
# Kept separate so node never ends up in the runtime image.
FROM node:22-alpine AS assets
WORKDIR /build
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund --ignore-scripts
COPY scripts/vendor.js ./scripts/
RUN node scripts/vendor.js

# ---- runtime ---------------------------------------------------------------
FROM python:3.12-slim

# opencv-python-headless still needs libgl/libglib at import time.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first, so a code change does not invalidate the layer.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/  ./backend/
COPY frontend/ ./frontend/
COPY scripts/  ./scripts/
COPY run.py ./
COPY --from=assets /build/frontend/vendor ./frontend/vendor

# Generate the bundled sample imagery at build time rather than committing
# ~600 KB of JPEG to the repository.
RUN python scripts/make_samples.py

# Run unprivileged. The data directory is the only writable path needed.
RUN useradd --create-home --uid 10001 roadlens \
    && mkdir -p /app/data/uploads /app/data/models \
    && chown -R roadlens:roadlens /app/data
USER roadlens

VOLUME ["/app/data"]
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import urllib.request,sys; \
    sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/health',timeout=4).status==200 else 1)"

CMD ["python", "-m", "uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8000"]
