FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# Requirements first so a code change doesn't reinstall pandas every deploy.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/ ./backend/
COPY frontend/ ./frontend/
COPY run.py .

# No Downloads folder on a server — exports arrive through the Upload button.
ENV WATCH_FOLDER=off \
    DASHBOARD_DB=/data/dashboard.db \
    PORT=8811

# Railway mounts its volume here; without one this is just a container-local dir.
RUN mkdir -p /data

CMD ["python", "run.py"]
