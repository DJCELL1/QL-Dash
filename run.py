"""Starts the Production Scheduler dashboard: API + folder watcher + browser launch."""
import logging
import os
import sys
import threading
import time
import webbrowser
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "backend"))

import uvicorn
from app import app

# Hosts (Railway included) inject PORT and expect the app on 0.0.0.0.
# Locally this stays on loopback so nothing is exposed to the network.
PORT = int(os.environ.get("PORT", "8811"))
HOST = os.environ.get("HOST", "0.0.0.0" if os.environ.get("PORT") else "127.0.0.1")
OPEN_BROWSER = not os.environ.get("PORT")


def _open_browser_when_ready():
    import urllib.request

    url = f"http://{HOST}:{PORT}/"
    for _ in range(60):
        try:
            urllib.request.urlopen(url, timeout=1)
            webbrowser.open(url)
            return
        except Exception:
            time.sleep(0.5)


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    if OPEN_BROWSER:
        threading.Thread(target=_open_browser_when_ready, daemon=True).start()
    uvicorn.run(app, host=HOST, port=PORT)


if __name__ == "__main__":
    main()
