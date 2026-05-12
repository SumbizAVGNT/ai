FROM python:3.11-slim
WORKDIR /app
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    curl ca-certificates procps btop git \
    && (DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends docker-cli || DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends docker.io) \
    && (DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends docker-compose-plugin || DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends docker-compose) \
    && command -v docker \
    && (docker compose version >/dev/null 2>&1 || command -v docker-compose) \
    && rm -rf /var/lib/apt/lists/*
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py .
COPY templates ./templates
COPY static ./static
EXPOSE 8080
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8080", "--proxy-headers"]
