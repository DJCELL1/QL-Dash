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
