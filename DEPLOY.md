# Deploying to Railway + Cloudflare

The app is now host-ready. Nothing about how it works changes — same tabs, same
database schema, same BC exports. The only difference is that exports arrive
through an **Upload export** button instead of a watched Downloads folder.

---

## What changed to make this hostable

| | Local (now) | Hosted |
|---|---|---|
| Getting exports in | Drops into `~/Downloads`, watcher picks them up | **Upload export** button, or drag a file onto the page |
| Database | `data/dashboard.db` | `/data/dashboard.db` on a Railway volume |
| Who can see it | Only you | Your team, behind Cloudflare Access |
| Backups | — | **Backup** button downloads the whole database |

Three environment variables drive it:

- `WATCH_FOLDER=off` — no Downloads folder on a server
- `DASHBOARD_DB=/data/dashboard.db` — the persistent volume
- `PORT` — Railway injects this; the app binds `0.0.0.0` when it's set

All three are already baked into the `Dockerfile`, so a plain Railway deploy
works with no configuration.

---

## Step 1 — Put the code in GitHub

Railway deploys from a repo, and a repo is also what lets you keep developing:
push a change here, Railway rebuilds automatically.

```bash
cd "C:/Users/selwy/OneDrive/Desktop/Sel Projects/Pro Dash"
```

```bash
git init && git add -A && git commit -m "Production dashboard"
```

Then create an **empty private** repo on github.com and push:

```bash
git remote add origin https://github.com/<you>/pro-dash.git && git branch -M main && git push -u origin main
```

`.dockerignore` already keeps `.venv/`, `data/`, `backups/`, and any stray
`.xlsx`/`.csv` out of the image. Add a matching `.gitignore` if you'd rather they
stayed out of the repo too — the 17.9 MB database in `backups/` especially.

## Step 2 — Create the Railway service

1. Railway → **New Project** → **Deploy from GitHub repo** → pick the repo.
2. Railway reads `railway.json` and `Dockerfile`; no build config needed.
3. First build takes ~3–5 minutes (pandas is the slow part).

## Step 3 — Add the volume (do this before you rely on it)

Without a volume the database is wiped on every deploy.

1. Service → **Variables/Settings** → **+ Volume**
2. Mount path: **`/data`** — this must match `DASHBOARD_DB` exactly.
3. Redeploy.

`railway.json` pins `numReplicas: 1`. Leave it there: SQLite on a volume takes
one writer, and a second container would corrupt it.

## Step 4 — Move your existing data across

Your current database has 269 schedule entries, 124 progress rows, and 32
subcontractor board states. Don't retype them.

1. On the **local** app, click **Backup** — you get `dashboard-<date>.db`.
2. In Railway, set a service variable `ADMIN_TOKEN` to any long random string.
3. Upload the backup to the live site (replace both placeholders):

```bash
curl -X POST -H "X-Admin-Token: YOUR_TOKEN" -F "file=@dashboard-20260818.db" https://your-app.up.railway.app/api/admin/restore
```

Restore refuses anything that isn't a valid dashboard database, and keeps the
old one alongside as `dashboard.db.pre-restore`. Do this **before** you hand the
URL out, because it overwrites everything.

If you'd rather start clean, skip this and just upload today's BC exports.

## Step 4b — Create the first account (required)

Reading the dashboard is open to anyone with the link. Changing anything —
scheduling, recording progress, uploading exports, downloading a backup —
needs an account.

There are no accounts on a new deploy, and every route that could create one
requires you to be signed in already, so the first is seeded from the
environment. In Railway → **Variables**, add:

| Name | Value |
|---|---|
| `ADMIN_USER` | your name, e.g. `selwyn` |
| `ADMIN_PASSWORD` | a password you'll remember |

Railway redeploys, and on start the app creates that account. It only runs
while there are no accounts, so changing the password later in the app won't
be undone by the variable still being set.

**Until you set these, the live site is read-only for everyone including you.**
The startup log says so if it happens.

Once you're in, add accounts for the team from the browser console on the
dashboard — or ask me and I'll add a small screen for it:

```bash
curl.exe -X POST -H "Content-Type: application/json" -d "{\"username\":\"dave\",\"password\":\"something-long\"}" --cookie "prodash_session=..." https://your-app.up.railway.app/api/users
```

Sessions last 30 days per device, so the floor only signs in once per phone.

## Step 5 — Put Cloudflare Access in front

Railway gives you `*.up.railway.app`, which is public. The sign-in above stops
anyone changing things, but the *contents* — customers, orders, due dates — are
still readable by anyone with the link. Cloudflare Access is what closes that.
Skip this step if you're happy for the board to be readable by anyone who has
the URL.

1. Cloudflare dashboard → your domain → **DNS** → add a `CNAME`, e.g.
   `dash` → `your-app.up.railway.app`, proxied (orange cloud).
2. Railway → service → **Settings → Networking → Custom Domain** → `dash.yourdomain.com`.
3. Cloudflare **Zero Trust → Access → Applications → Add an application**
   → Self-hosted → `dash.yourdomain.com`.
4. Policy: **Allow**, rule **Emails ending in** `@yourcompany.com` (or list the
   specific people). One-time PIN by email is the simplest login method — no
   accounts to create.

Everyone then goes to `dash.yourdomain.com`, gets an email code the first time,
and is signed in for as long as your session duration says.

The audit log already reads Cloudflare's `Cf-Access-Authenticated-User-Email`
header, so once Access is on, every upload, restore, and change is attributed to
a real person instead of `local`.

**Lock the back door:** also add an Access application for the bare
`your-app.up.railway.app` hostname, or anyone with that URL bypasses Access
entirely.

---

## Running it day to day

1. Export from BC as usual.
2. Open the dashboard, click **Upload export** (or drag the file onto the page).
   Production Scheduler and Purchase Orders files are both recognised by content,
   so the filename doesn't matter.
3. Everyone else just refreshes.

## Backups

Click **Backup** weekly and keep the file. It's a real SQLite copy taken through
SQLite's backup API, so it's safe to take while people are using the app. A
Railway volume is not a backup — if you delete the service, it goes with it.

## Keeping local development

Nothing here stops the local setup. Running `python run.py` with no environment
variables still watches Downloads, still uses `data/dashboard.db`, still opens
your browser. Develop locally, `git push`, Railway redeploys.

## Costs

Railway's usage-based plan runs about **$5/month** for a service this size.
Cloudflare Access is free up to 50 users.
