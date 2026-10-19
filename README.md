# Queensland Production Dashboard

Local dashboard for the BC "Production Scheduler" exports. Watches your Downloads
folder, ingests new exports automatically, and keeps daily history in a local
SQLite database so trends build up over time.

## Day to day

1. Start it: double-click `start.bat` (or run `./.venv/Scripts/python.exe run.py`).
   Your browser opens automatically to the dashboard.
2. Export from Business Central as usual (`Production Scheduler ...xlsx` or `.csv`)
   and save it to your **Downloads** folder — nothing else to do. It's picked up
   within a couple of seconds and classified automatically:
   - `Work Centre Group Filter` starting with `JOINERY` → **Joinery** tab
   - `Work Centre Group Filter` starting with `SUB` → **Subcontractors** tab,
     grouped by work centre (Elaw, WA Anodisers, …)
3. Leave the window/terminal running in the background while you work. Close it
   (Ctrl+C, or close the terminal) when you're done.

If a file doesn't show up, hit **Rescan folder** in the top right.

## What it tracks

- Snapshots are keyed by the report's own date (from `Shortage Last Calculated`
  in the export), one snapshot per day per dataset. Dropping in a corrected
  export for the same day replaces that day's data rather than duplicating it.
- "Days there" / trend charts are built from full history, so they get more
  useful the longer you use it day to day.

## Project layout

- `backend/` — FastAPI app, folder watcher, SQLite storage, ingest/parsing
- `frontend/` — static HTML/CSS/JS dashboard (no build step, no Node needed)
- `data/dashboard.db` — local SQLite database (all history lives here)
- `run.py` / `start.bat` — launcher

## Notes

- Runs entirely on your machine — nothing is uploaded anywhere.
- Only files named `Production Scheduler*.xlsx/.xls/.csv` in Downloads are
  picked up; everything else is ignored.
