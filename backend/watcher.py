"""Watches the Downloads folder for new Production Scheduler exports and ingests them."""
import logging
import threading
import time
from pathlib import Path

from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer

from db import get_processed_file, init_db, mark_file_processed
from ingest import SUPPORTED_EXTENSIONS, ingest_file

logger = logging.getLogger("watcher")

FILENAME_PREFIXES = ("production scheduler", "purchase orders", "sales orders")
DEBOUNCE_SECONDS = 2.0


def _matches(path: Path) -> bool:
    if path.name.startswith("~$") or path.name.startswith("."):
        return False
    if path.suffix.lower() not in SUPPORTED_EXTENSIONS:
        return False
    return path.stem.lower().startswith(FILENAME_PREFIXES)


def _already_processed(path: Path) -> bool:
    try:
        stat = path.stat()
    except FileNotFoundError:
        return True
    row = get_processed_file(str(path))
    if row is None:
        return False
    return row["mtime"] == stat.st_mtime and row["size"] == stat.st_size and row["status"] == "ok"


def process_file(path: Path) -> dict | None:
    if not _matches(path) or not path.exists():
        return None
    try:
        stat = path.stat()
    except FileNotFoundError:
        return None

    if _already_processed(path):
        return None

    try:
        result = ingest_file(path)
        mark_file_processed(str(path), stat.st_mtime, stat.st_size, result["dataset"],
                             result["snapshot_date"], "ok")
        logger.info("Ingested %s -> %s (%s rows, snapshot %s)",
                    path.name, result["dataset"], result["row_count"], result["snapshot_date"])
        return result
    except Exception as exc:  # noqa: BLE001
        logger.exception("Failed to ingest %s", path)
        mark_file_processed(str(path), stat.st_mtime, stat.st_size, None, None, "error", str(exc))
        return None


def scan_folder(folder: Path) -> list[dict]:
    results = []
    if not folder.exists():
        return results
    for path in sorted(folder.iterdir()):
        if path.is_file() and _matches(path):
            result = process_file(path)
            if result:
                results.append(result)
    return results


class _DebouncedHandler(FileSystemEventHandler):
    def __init__(self, folder: Path):
        self.folder = folder
        self._timers: dict[str, threading.Timer] = {}
        self._lock = threading.Lock()

    def _schedule(self, path_str: str):
        path = Path(path_str)
        if not _matches(path):
            return
        with self._lock:
            existing = self._timers.get(path_str)
            if existing:
                existing.cancel()
            timer = threading.Timer(DEBOUNCE_SECONDS, self._run, args=(path,))
            timer.daemon = True
            self._timers[path_str] = timer
            timer.start()

    def _run(self, path: Path):
        with self._lock:
            self._timers.pop(str(path), None)
        process_file(path)

    def on_created(self, event):
        if not event.is_directory:
            self._schedule(event.src_path)

    def on_modified(self, event):
        if not event.is_directory:
            self._schedule(event.src_path)

    def on_moved(self, event):
        if not event.is_directory:
            self._schedule(event.dest_path)


def start_watcher(folder: Path) -> Observer:
    init_db()
    folder.mkdir(parents=True, exist_ok=True)

    logger.info("Scanning %s for existing exports...", folder)
    scan_folder(folder)

    handler = _DebouncedHandler(folder)
    observer = Observer()
    observer.schedule(handler, str(folder), recursive=False)
    observer.start()
    logger.info("Watching %s for new Production Scheduler exports", folder)
    return observer


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    watch_folder = Path.home() / "Downloads"
    obs = start_watcher(watch_folder)
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        obs.stop()
        obs.join()
