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

Each export is routed by its work centre group column. BC writes the header as
`Work Center Group Code Filter`; older exports say `Work Centre Group Filter`,
and both are accepted.

| Group code | Lands in |
|---|---|
| `ALU-DOOR-Q` | **Aluminium doors**, and feeds Factory floor and Door schedule |
| `PC-Q` | **Powdercoating** |
| `CAVITIES-Q` | **Cavities schedule** |

The WA codes (`JOINERY…`, `SUB…`, `CAVITIES-W`) still route to the same three
places, so one deploy can serve both sites. Anything unrecognised becomes a
dataset named after the group, which no tab reads — so a new group code has to
be added to `classify_dataset()` in `backend/ingest.py` or its data goes
nowhere, silently.

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

## A naming wrinkle

The three datasets are stored under the names the original WA site gave them:
`joinery` holds the **aluminium doors**, and `subcontractors` holds the
**powdercoating**. Only the labels were changed, so any history already
recorded still lines up. Worth knowing before you go looking for a `doors`
table that doesn't exist.
