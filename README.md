# Production Scheduler for Queensland

Dashboard over the Business Central "Production Scheduler" exports for the
Queensland site. It keeps daily history in a SQLite database so trends build up
over time.

Queensland runs three lines:

- **Powdercoating**
- **Cavities**
- **Aluminium doors**

## Day to day

Hosted (the normal way):

1. Export from Business Central as usual.
2. Open the dashboard and click **Upload export**, or drag the file onto the
   page. Production Scheduler and Purchase Orders files are both recognised by
   content, so the filename doesn't matter.
3. Everyone else just refreshes.

Reading the dashboard is open to anyone with the link. Scheduling, recording
progress, uploading and taking a backup all need an account.

Running locally instead:

1. Start it — `start.bat`, or `python run.py`. Your browser opens by itself.
2. Save the export to your **Downloads** folder; it's picked up within a couple
   of seconds.
3. If a file doesn't show up, hit **Rescan folder** in the top right.

## How exports are sorted

Each export is routed by its `Work Centre Group Filter` column:

- `CAVITIES…` → **Cavities schedule**
- `SUB…` → the **Subcontractors** board
- `JOINERY…` → the **Joinery** tab
- anything else → a dataset named after the group itself, which is how
  `POWDERLINE` arrives and gets merged onto the subcontractor board

Those rules came from the original WA site. They still need aligning to
Queensland's work centre groups — see the note at the bottom.

## What it tracks

- Snapshots are keyed by the report's own date (from `Shortage Last Calculated`
  in the export), one snapshot per day per dataset. Dropping in a corrected
  export for the same day replaces that day's data rather than duplicating it.
- "Days there" and the trend charts are built from full history, so they get
  more useful the longer it runs.

## Project layout

- `backend/` — FastAPI app, folder watcher, SQLite storage, ingest/parsing
- `frontend/` — static HTML/CSS/JS dashboard (no build step, no Node needed)
- `run.py` / `start.bat` — launcher
- `DEPLOY.md` — Railway and Cloudflare setup
- `CLAUDE.md` — notes for anyone working on the code

## Known gap

The tabs and the sorting rules above still carry the original site's shape:
there's a **Joinery** tab and a **Subcontractors** board built around WA
contractors (Elaw, WA Anodisers, Wenco), neither of which matches what
Queensland actually runs. Aligning them needs a sample Queensland export so the
`Work Centre Group Filter` values can be mapped correctly — guessing would route
data to a dataset no tab reads.
