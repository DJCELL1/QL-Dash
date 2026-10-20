# Queensland Production Dashboard

Dashboard over Business Central "Production Scheduler" exports for Criterion
Industries. FastAPI backend, SQLite storage, plain static frontend. It runs two
ways from the same code: locally on a Windows desktop watching the Downloads
folder, and hosted on Railway where exports arrive through an upload button.

## Layout

- `backend/` — `app.py` (FastAPI, ~37 routes), `db.py` (SQLite + schema),
  `ingest.py` (parses BC exports), `auth.py` (sessions), `watcher.py` (local
  folder watch)
- `frontend/` — `index.html` + `app.js` + `styles.css` (dashboard),
  `floor.html` + `floor.js` + `floor.css` (factory floor view), `assets/`
- `run.py` — launcher for both modes
- `Dockerfile`, `railway.json`, `DEPLOY.md` — hosting

## Running it

```bash
python run.py
```

With no environment variables set it binds loopback, watches `~/Downloads`,
uses `data/dashboard.db` and opens a browser. Setting `PORT` switches it to
host mode: binds `0.0.0.0`, no browser.

To exercise hosted behaviour locally:

```bash
PORT=8811 WATCH_FOLDER=off DASHBOARD_DB=/tmp/test.db \
  ADMIN_USER=you ADMIN_PASSWORD=whatever python run.py
```

`/api/status` is the healthcheck. With an empty database most `/api/*` routes
return 404 — that is the empty state, not a fault.

## Deployment — constraints that matter

Railway builds from the `Dockerfile` and reads `railway.json`. Pushing to
`main` redeploys automatically.

- **The `/data` volume is load-bearing.** `DASHBOARD_DB=/data/dashboard.db`,
  and a Railway volume must be mounted at exactly `/data`. Without it, every
  redeploy wipes the database — all history, all accounts, and the session
  secret. A trailing space in the mount path mounts it elsewhere silently.
- **Keep `numReplicas: 1`.** SQLite on a volume takes one writer. A second
  container corrupts it.
- Environment variables: `WATCH_FOLDER=off`, `DASHBOARD_DB`, `PORT` (baked into
  the Dockerfile); `ADMIN_USER` / `ADMIN_PASSWORD` seed the first account and
  must be set or the site is read-only for everyone; `SESSION_SECRET` is
  optional (otherwise generated once and stored in `app_settings`);
  `ADMIN_TOKEN` guards `/api/admin/restore`.

## Database

`init_db()` runs on every startup and must stay safe to re-run. The production
database lives on the volume and is never recreated, so **schema changes go in
`_add_missing_columns()` in `db.py`** — a `PRAGMA table_info` check plus
`ALTER TABLE ... ADD COLUMN` with a default. Adding a column to the `SCHEMA`
string alone does nothing to an existing database, because every table is
`CREATE TABLE IF NOT EXISTS`.

## Datasets and routing

`classify_dataset()` in `backend/ingest.py` maps an export's work centre group
onto one of three dataset keys. Those keys are **historical names and do not
match what they hold**:

| Group code | Dataset key | Shown as |
|---|---|---|
| `ALU-DOOR-Q`, `JOINERY…` | `joinery` | Aluminium doors (also Factory floor, Door schedule) |
| `PC-Q`, `SUB…` | `subcontractors` | Powdercoating |
| `CAVITIES-Q`, `CAVITIES-W` | `cavities` | Cavities schedule |

Queensland codes end `-Q`, WA's are the older prefixes; both are kept so one
deploy serves either site. Don't rename the keys to match the labels without
migrating stored snapshots, sub statuses and day plans along with them.

An unrecognised group falls through to a dataset named after itself, which no
tab reads. Nothing errors — the data simply never appears. A new work centre
group has to be added to `classify_dataset()`.

`_pro_totals()` defaults to the `joinery` dataset, so Factory floor and Door
schedule read the doors. Powdercoating is in house at Queensland: the board
shows no purchase-order tracking, and `PC-10-Q` is mapped to a display name in
`SUB_CONTRACTOR_NAMES` even though it isn't a contractor.

## Door stages

The aluminium door line runs five stages, in this order, and every door runs
all of them:

`cut_to_size` -> `machining` -> `components` -> `build` -> `wrap`

They are declared once in `STAGES` / `STAGE_LABELS` (`backend/app.py`) and
mirrored in `FACTORY_STAGES` / `STAGE_LABELS` (`frontend/app.js`) and
`floor.js`. Progress is one column per stage in `stage_progress`
(`<stage>_done`), registered in `STAGE_COLUMNS` in `db.py`. The first stage
anchors scheduling and the "remaining to start" figure; the last decides
whether a job counts as completed - both are read as `STAGES[0]` / `STAGES[-1]`
rather than by name, so reordering the tuple is enough.

The WA line's stages (`make`, `press`, `cnc`, `glazing`, `edge_strip`,
`finish`) are out of the flow, but their columns stay in the table and in
`STAGE_COLUMNS` so a database carrying that history still reads back. WA also
picked two optional stages per job from markers in the item description; that
branch is gone, and `_stages_for()` now returns the same five every time.

## The three floor lines

The Factory floor tab toggles between three lines, each with its own stages,
its own endpoint pair and its own columns in `stage_progress`:

| Line | Stages | Reads | Progress endpoint |
|---|---|---|---|
| Doors | the five above | `joinery` | `/api/factory/progress` |
| Cavities | `cav_prep`, `cav_make` | `cavities` | `/api/cavities/progress` |
| Powdercoating | `pc_prep`, `pc_coat`, `pc_pack` | `subcontractors` | `/api/powdercoat/progress` |

`floorLineConfig()` in `frontend/app.js` is where a line is described, and
`lineForStage()` maps a tick back to its line. All three enforce the same
ordering rule: a step can't run ahead of the one before it or drop below the
one after it.

Only doors have a scheduling board, so the floor's "By day" view is empty for
powdercoating - picking that line switches to "All jobs" for that reason.

Note that powdercoat jobs are measured in both EA and LTHS. Per-row totals are
right, but the floor's aggregate "items" tile sums the two together, which the
subcontractor board deliberately avoids (see `fmtQtyTotals`).

## Settings

`/api/settings` serves everything the planner can change, and four POST routes
write it back. All of them are admin-only.

- `work_hours` - hours per step per weekday, seeded 8h Mon-Fri once.
- `day_overrides` - overtime, shutdowns and public holidays; beats the weekly
  pattern. Queensland holidays are seeded once at 0h and are editable. A blank
  stage means every step.
- `product_minutes` - minutes per unit per product group per step. Lookup order
  is product row -> the `__default__` row -> BC's own estimate. Rows survive a
  product leaving the exports and are shown marked `retired`.
- `planning` - a JSON blob in `app_settings`: shift start, lead time, days
  shown, capacity measure, daily rates, step offsets.

A product group is `product_family(item_no)|strip_size(description)`. The
family drops the trailing per-order serial; `strip_size` removes a stock length
like `(2.8)` and a made-to-order size like `2700 x 920`, but deliberately keeps
section sizes (`100 x 3.0mm`) and stud widths (`92mm`), which identify the
product rather than size one order of it. Changing those regexes re-keys every
stored row, so don't, without a migration.

Seeding only runs while a table is empty, so an edit is never overwritten.

## Hours on the boards

Each lane shows estimated hours against hours available when
`planning.capacity_measure` is `hours` (the default); set it to `count` for the
old doors-per-day check.

Estimated hours come from `minutes` on each job row, which the API resolves
with `minutes_lookup()`: product row -> `__default__` row -> BC's estimate. A
job with no figure anywhere isn't counted and the lane shows `+N?` instead of
quietly under-reading.

Hours available come from Settings, resolved in `stageHoursOn()`: an override
for that date and step beats one for the whole day, which beats the weekly
pattern. A day with no hours at any step draws as closed, with the override's
note as its tooltip. Weekends never appear - the board is built on business
days.

Cards colour by state, in this order: step complete, then material shortage,
then past due. Shortage rides on the PRO, since one short item holds the whole
job up.

BC sends dates as `2026-10-16 00:00:00`. `parseDateKey()` cannot read that and
returns an Invalid Date, so compare ISO prefixes with `.slice(0, 10)` instead.

## Efficiency

`/api/efficiency?date_from&date_to` returns one row per step per day:

- **planned** - work sitting on that day in `schedule_entries`, priced with the
  same minutes lookup the boards use.
- **earned** - positive deltas from `progress_events` that day, priced the same
  way. This is the whole reason the tick log exists.
- **actual** - typed in and stored in `actual_hours`; absent, it falls back to
  the hours the day was given, and the row says `actual_is_default` so the UI
  can show it as a stand-in. Clearing the box restores the fallback.

Efficiency is earned / actual, plan attainment earned / planned. Bands are 95+
green, 80-95 amber, below red.

Attainment above 100% is normal - it means work was ticked off that nobody had
scheduled. Attainment is null when nothing was planned, rather than infinite.

A PRO that has left the exports has no product group, so it falls back to the
`__default__` minutes row; without one it earns nothing and the day under-reads.

## Gantt and the unit tracker

The Gantt is a full-screen overlay opened by the small table button on each day
of a schedule board. It draws entirely from data already loaded - schedule
entries, job rows (which carry `minutes`) and Settings - so it has no endpoint
of its own.

One row per step. Sales-order blocks lie end to end from the shift start in
board order (`sequence`); block length is qty x minutes per unit. The red line
is the end of shift, from the hours that day was given, and anything past it is
hatched as overtime.

Only doors and cavities appear: powdercoating isn't in `SCHEDULABLE_STAGES`, so
it has no scheduled day to lay out.

`predecessorFlag()` compares a job's previous step: warning when it isn't
scheduled at all or sits after this one, hourglass when it ran earlier and
isn't finished.

Clicking a PRO bar opens the unit tracker, which reads `/api/job/{pro}` - the
grid of units against steps with a time on each unit. Clicking unit N sets the
running total to N, and clicking a unit already done takes it back to N-1.
Every tick re-reads the job rather than patching the grid, because the server
decides what a tick is allowed to be and a refusal must not leave the grid
showing something it isn't. Jobs measured in lengths have no whole units, so
they get a quantity box instead.

A rule worth remembering: a CSS class that sets `display` beats the `hidden`
attribute. Both overlays carry an explicit `[hidden] { display: none; }`.

## Auto-scheduling

Two endpoints, both placing only the **first** step of a line. The board
derives every step after it from that anchor and the day offsets, so placing
them here would fight it.

`POST /api/schedule/auto` takes a line, a date range and `replan`. Candidates
are whatever still has quantity left to schedule, soonest due date first, each
landing on the first day in the range with enough minutes left at that step.
Capacity per day is hours available x 60, less what is already booked there.
Anything that doesn't fit is returned in `skipped` with a reason and stays in
Holding - it is never forced onto a day it can't be done on.

`replan` clears bookings in the range **only where nothing has been ticked**.
Work the floor has started keeps its day, and its load still counts against
that day's capacity.

`POST /api/schedule/bc-dates` puts everything in Holding on its own BC date,
taken literally rather than backed off by the lead time. A date already past
lands on today, and hours are not checked - the lane totals show where that
overloads a day.

Both refuse a line with no schedulable first step, which is how powdercoating
is turned away.

## Auth

Signed cookie `prodash_session`, 30 days. Reading is open to anyone with the
link; everything that changes state needs an account. `current_user()` and
`require_admin()` in `app.py` are the guards. Note the separate `_require_admin()`
further down is a different thing: the `ADMIN_TOKEN` check for restore, not an
account check. There is no sign-up route — the
first account comes from the environment, the rest from `POST /api/users` while
signed in.

## Frontend conventions

- **No build step.** Plain HTML, CSS and JavaScript, no Node, no bundler. Don't
  introduce one.
- **Files are CRLF.** `backend/*.py` and `frontend/*` use Windows line endings.
  Any tool that rewrites a whole file must preserve them, or the diff becomes
  every line in the file and the real change is impossible to review.
- Colours come from CSS custom properties defined in three places per
  stylesheet: `:root`, a `prefers-color-scheme: dark` block, and a
  `:root[data-theme="dark"]` block. Change all three or dark mode drifts.

## Branding

Criterion Industries, per the 2024 brand guidelines.

- Palette: Charcoal `#2F2F2F`, Dark Grey `#3D3D3D`, Slate Grey `#424F59`,
  French Grey `#637A90` (the accent), Platinum `#B7C2CB`, Light Grey `#E5E5E5`,
  Pure White `#F7F7FB`.
- Type is Roboto — the guidelines' sanctioned alternative where the brand face
  (Swis721 BT Black) can't be embedded. Headings are Roboto Black, all caps.
- `assets/criterion-logo.png` is the black linear logo. Never recolour, rotate,
  distort, outline or shadow it. White is permitted, which is why dark themes
  flip it with a filter rather than tinting it.
- **Status colours are deliberately not brand colours.** Good/warning/critical
  stay green/amber/red. The palette is greys and one blue-grey, and a shortage
  has to read as red from across the factory floor. Don't "fix" this.
