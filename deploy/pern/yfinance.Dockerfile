FROM python:3.12-slim-bookworm@sha256:e697c81897302a4c4333bade000d98038fbb21eb064f8ee1fd42d02ebcd9d337
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 HOST=0.0.0.0 PORT=8000 YFINANCE_CACHE_DIR=/tmp/yfinance-cache
WORKDIR /app
COPY services/yfinance/requirements.lock.txt ./requirements.lock.txt
RUN pip install --no-cache-dir --require-hashes --only-binary=:all: -r requirements.lock.txt && useradd --uid 10001 --create-home sidecar
COPY services/yfinance/app.py services/yfinance/streaming.py ./
USER 10001:10001
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=2)"
CMD ["python", "app.py"]
