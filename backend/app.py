"""FastAPI app serving the Production Scheduler dashboard."""
import hashlib
import json
import logging
import os
import re
import tempfile
from datetime import date, datetime
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, Request, Response, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.background import BackgroundTask

from db import (
    OverBooked,
    all_snapshots,
    backup_to,
    restore_from,
    create_schedule_entry,
    create_schedule_entry_checked,
    delete_schedule_entry,
    first_seen_dates,
    get_all_schedule_entries,
    get_all_stage_progress,
    get_day_plans,
    get_day_priorities,
    set_day_priorities,
    join_schedule_entries,
    lock_day,
    unlock_day,
    get_records_for_snapshot,
    get_all_purchase_orders,
    get_all_sub_status,
    get_schedule_entry,
    get_stage_progress,
    set_sub_status,
    history_counts,
    init_db,
    delete_day_override,
    get_day_overrides,
    get_product_minutes,
    get_actual_hours,
    get_all_schedule_entries,
    get_progress_events,
    set_actual_hours,
    get_work_hours,
    latest_snapshot,
    set_day_override,
    set_product_minutes,
    set_work_hours,
    pros_with_dated_schedule,
    records_last_seen,
    recent_audit,
    reset_stage_progress,
    set_stage_progress,
    write_audit,
    sum_scheduled_qty,
    unallocate_dates,
    unallocate_pros,
    update_schedule_entry,
)
from db import (
    count_admins,
    count_users,
    delete_user,
    first_account,
    forget_door_numbers,
    get_all_door_numbers,
    get_all_sales_orders,
    set_sales_orders,
    get_setting,
    get_user,
    list_accounts,
    list_users,
    set_door_numbers,
    set_setting,
    set_user_admin,
    upsert_user,
)
import auth
from ingest import SUPPORTED_EXTENSIONS, file_kind, ingest_file
from watcher import scan_folder, start_watcher

logger = logging.getLogger("app")

BASE_DIR = Path(__file__).resolve().parent.parent
FRONTEND_DIR = BASE_DIR / "frontend"


def _watch_folder() -> Path | None:
    """Folder to watch for BC exports.

    Set WATCH_FOLDER=off when hosted — there's no Downloads folder on a server,
    exports arrive through /api/upload instead.
    """
    configured = os.environ.get("WATCH_FOLDER")
    if configured:
        return None if configured.lower() in {"off", "none", "disabled"} else Path(configured)
    default = Path.home() / "Downloads"
    return default if default.exists() else None


WATCH_FOLDER = _watch_folder()

app = FastAPI(title="Queensland Production Dashboard")


@app.middleware("http")
async def revalidate_static(request, call_next):
    """The frontend has no build step or cache-busted filenames, so browsers
    must check with us before reusing index.html/app.js/styles.css — otherwise
    a shipped change wouldn't reach anyone.

    no-cache is that check. It used to say no-store, which is a stronger and
    different thing: don't keep a copy at all. That re-sent app.js and
    styles.css in full on every page load, a fifth of a megabyte each time,
    when the files already carry an ETag that answers the question for free.
    """
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-cache"
    return response

_observer = None


SESSION_SECRET = None


def _session_secret() -> str:
    """Kept in the database unless the environment sets one.

    A secret that changed on every restart would sign everyone out on each
    deploy, which with a deploy every few minutes is unusable.
    """
    global SESSION_SECRET
    if SESSION_SECRET:
        return SESSION_SECRET
    SESSION_SECRET = os.environ.get("SESSION_SECRET") or get_setting("session_secret")
    if not SESSION_SECRET:
        SESSION_SECRET = auth.new_secret()
        set_setting("session_secret", SESSION_SECRET)
    return SESSION_SECRET


def _seed_first_user():
    """Create the first account from the environment.

    Without this there'd be no way in: everything that could create a user needs
    a signed-in user. Only runs while there are none, so it can't overwrite a
    password someone has since changed.
    """
    if count_users():
        return
    name = os.environ.get("ADMIN_USER")
    password = os.environ.get("ADMIN_PASSWORD")
    if not name or not password:
        logger.warning(
            "No accounts yet and ADMIN_USER/ADMIN_PASSWORD are unset — "
            "the dashboard is readable but nothing can be changed until one exists"
        )
        return
    salt, digest = auth.hash_password(password)
    upsert_user(name, salt, digest)
    logger.info("Created the first account: %s", name)


def _seed_first_admin():
    """Make one account an admin the first time the flag exists.

    The account the host seeded is the owner's, on every deploy this has had,
    so that's the one picked — falling back to the oldest account. Only runs
    while there are no admins at all, so it can't undo a later change. If it
    picks wrong, nothing is stuck: with no admins every signed-in user counts
    as one, and any of them can set the right person.
    """
    if count_admins() or not count_users():
        return
    name = os.environ.get("ADMIN_USER")
    if not name or not get_user(name):
        name = first_account()
    if name and set_user_admin(name, True):
        logger.info("Made %s the first admin", name)


@app.on_event("startup")
def _startup():
    global _observer
    init_db()
    _session_secret()
    _seed_settings()
    _seed_first_user()
    _seed_first_admin()
    if WATCH_FOLDER:
        _observer = start_watcher(WATCH_FOLDER)
    else:
        logger.info("No watch folder — exports arrive via upload")


@app.on_event("shutdown")
def _shutdown():
    if _observer:
        _observer.stop()
        _observer.join()


def _decorate_records(dataset: str, records: list[dict]) -> list[dict]:
    first_seen = first_seen_dates(dataset)
    today = date.today()
    out = []
    for r in records:
        r = dict(r)
        fs = first_seen.get(r["line_key"])
        r["first_seen_date"] = fs
        if fs:
            try:
                r["days_in_stage"] = (today - date.fromisoformat(fs)).days
            except ValueError:
                r["days_in_stage"] = None
        else:
            r["days_in_stage"] = None

        is_open = (r.get("operation_remaining_qty") or 0) > 0
        r["is_open"] = is_open

        due_raw = r.get("operation_due_date")
        overdue = False
        due_in_days = None
        if due_raw:
            try:
                due_date = datetime.fromisoformat(due_raw).date()
                due_in_days = (due_date - today).days
                overdue = is_open and due_in_days < 0
            except ValueError:
                pass
        r["due_in_days"] = due_in_days
        r["overdue"] = overdue

        out.append(r)
    return out


def current_user(request: Request) -> str | None:
    """The signed-in username, or None for a reader."""
    token = request.cookies.get(auth.COOKIE_NAME)
    name = auth.read_session(_session_secret(), token)
    # A session outlives the account it names, so check the user still exists.
    return name if name and get_user(name) else None


def actor(request: Request) -> str:
    """Who is making this change, for the audit log."""
    return current_user(request) or "unknown"


def is_admin(request: Request) -> bool:
    """Whether this user may do the admin-only jobs.

    With no admin set at all, every signed-in user counts as one. Otherwise a
    database that arrived from an older version — or one where the last admin
    was deleted — would have nobody able to appoint the first, and no way back.
    """
    name = current_user(request)
    if not name:
        return False
    if count_admins() == 0:
        return True
    user = get_user(name)
    return bool(user and user.get("is_admin"))


def require_admin(request: Request, what: str) -> None:
    if not is_admin(request):
        raise HTTPException(status_code=403, detail=f"{what} is for admin accounts only.")


# Reading is open; changing anything needs an account. Enforced here rather than
# on each endpoint so a new one can't ship unprotected by being forgotten.
OPEN_POSTS = {"/api/login", "/api/logout"}


@app.middleware("http")
async def json_etag(request: Request, call_next):
    """Answer an unchanged GET with 304 instead of the body again.

    Every open tab re-reads the whole dashboard once a minute — 709 KB of it,
    or 40 MB an hour, and the wall display sits there all day. Almost none of
    it has changed between polls: an export lands once a morning.

    The tag is a hash of the bytes about to be sent, so it cannot say
    "unchanged" about something that changed. Browsers revalidate on their own
    and hand the cached body back to fetch() as a normal 200, so the frontend
    needs to know nothing about any of this.
    """
    response = await call_next(request)

    if (
        request.method != "GET"
        or response.status_code != 200
        or not response.headers.get("content-type", "").startswith("application/json")
    ):
        return response

    body = b"".join([chunk async for chunk in response.body_iterator])
    etag = f'"{hashlib.sha256(body).hexdigest()[:32]}"'

    # Rebuilt from raw_headers, not a dict: Set-Cookie can legitimately appear
    # more than once and collapsing it would drop someone's session.
    headers = [
        (k, v)
        for k, v in response.raw_headers
        if k.lower() not in (b"etag", b"cache-control", b"content-length")
    ]
    # private: /api/me says who is signed in, and a shared cache between here
    # and the browser must never hand one person's answer to the next.
    headers += [(b"etag", etag.encode()), (b"cache-control", b"private, no-cache")]

    if request.headers.get("if-none-match") == etag:
        not_modified = Response(status_code=304)
        not_modified.raw_headers = headers
        return not_modified

    headers.append((b"content-length", str(len(body)).encode()))
    out = Response(content=body, status_code=200)
    out.raw_headers = headers
    return out


@app.middleware("http")
async def require_signin_to_change(request: Request, call_next):
    path = request.url.path
    needs_account = (
        request.method not in ("GET", "HEAD", "OPTIONS") and path not in OPEN_POSTS
    ) or path == "/api/admin/backup"  # the backup is the whole database

    if needs_account and not current_user(request):
        return JSONResponse(
            {"detail": "Sign in to make changes."},
            status_code=401,
        )
    return await call_next(request)


class Credentials(BaseModel):
    username: str
    password: str


@app.post("/api/login")
def api_login(request: Request, body: Credentials, response: Response):
    user = get_user(body.username)
    if not user or not auth.verify_password(body.password, user["salt"], user["password_hash"]):
        # Same message either way — saying which was wrong tells an attacker
        # which usernames exist.
        raise HTTPException(status_code=401, detail="Wrong username or password.")
    token = auth.issue_session(_session_secret(), user["username"])
    response.set_cookie(auth.COOKIE_NAME, token, **auth.cookie_kwargs(request))
    write_audit(user["username"], "login", "signed in")
    return {"username": user["username"]}


@app.post("/api/logout")
def api_logout(request: Request, response: Response):
    name = current_user(request)
    response.delete_cookie(auth.COOKIE_NAME, path="/")
    if name:
        write_audit(name, "logout", "signed out")
    return {"ok": True}


@app.get("/api/me")
def api_me(request: Request):
    """Who the browser is, and whether anyone can sign in at all."""
    return {
        "username": current_user(request),
        "any_accounts": count_users() > 0,
        "is_admin": is_admin(request),
        # False means nobody has been made an admin yet, so everyone signed in
        # is treated as one. The Accounts dialog says so rather than leaving it
        # looking like the tick does nothing.
        "admins_set": count_admins() > 0,
    }


class NewUser(BaseModel):
    username: str = Field(min_length=2, max_length=64)
    password: str = Field(min_length=8)


@app.post("/api/users")
def api_create_user(request: Request, body: NewUser):
    """Add an account, or change one's password. Signed-in users only."""
    salt, digest = auth.hash_password(body.password)
    existed = get_user(body.username) is not None
    upsert_user(body.username.strip(), salt, digest)
    write_audit(actor(request), "user.save", f"{'updated' if existed else 'created'} {body.username}")
    return {"username": body.username.strip(), "created": not existed}


@app.get("/api/users")
def api_list_users(request: Request):
    if not current_user(request):
        raise HTTPException(status_code=401, detail="Sign in to see accounts.")
    return {"users": list_users(), "accounts": list_accounts(), "admins_set": count_admins() > 0}


class AdminFlag(BaseModel):
    is_admin: bool


@app.post("/api/users/{username}/admin")
def api_set_admin(request: Request, username: str, body: AdminFlag):
    require_admin(request, "Changing who is an admin")
    if not get_user(username):
        raise HTTPException(status_code=404, detail=f"No account called '{username}'.")
    # Taking the last admin away would leave the tick with nobody to set it.
    if not body.is_admin and count_admins() == 1:
        raise HTTPException(
            status_code=400,
            detail="That's the only admin — make someone else an admin first.",
        )
    set_user_admin(username, body.is_admin)
    write_audit(actor(request), "user.admin", f"{username} -> {'admin' if body.is_admin else 'not admin'}")
    return {"username": username, "is_admin": body.is_admin}


@app.delete("/api/users/{username}")
def api_delete_user(request: Request, username: str):
    me = current_user(request)
    if username.lower() == (me or "").lower():
        raise HTTPException(status_code=400, detail="You can't delete the account you're signed in as.")
    if count_users() <= 1:
        raise HTTPException(status_code=400, detail="That's the only account — deleting it would lock everyone out.")
    removed = delete_user(username)
    if not removed:
        raise HTTPException(status_code=404, detail=f"No account called '{username}'.")
    write_audit(actor(request), "user.delete", username)
    return {"deleted": username}


@app.get("/api/activity")
def api_activity(limit: int = 200):
    """Recent changes, newest first — who did what, and when."""
    return {"entries": recent_audit(min(max(limit, 1), 1000))}


@app.get("/api/status")
def api_status():
    snaps = all_snapshots()
    by_dataset = {}
    for s in snaps:
        d = s["dataset"]
        if d not in by_dataset or s["snapshot_date"] > by_dataset[d]["snapshot_date"]:
            by_dataset[d] = s
    return {
        "watch_folder": str(WATCH_FOLDER) if WATCH_FOLDER else None,
        "datasets": by_dataset,
    }


@app.post("/api/rescan")
def api_rescan():
    if not WATCH_FOLDER:
        raise HTTPException(status_code=400, detail="No watch folder configured — upload the export instead")
    results = scan_folder(WATCH_FOLDER)
    return {"ingested": results}


@app.post("/api/upload")
async def api_upload(request: Request, files: list[UploadFile] = File(...)):
    """Ingest BC exports sent from the browser.

    Same parser and classification as the folder watcher — this is just a
    different way in, so the app works when hosted where there's no Downloads
    folder to watch.
    """
    results, errors = [], []
    upload_dir = Path(tempfile.gettempdir()) / "prodash_uploads"
    upload_dir.mkdir(parents=True, exist_ok=True)

    for f in files:
        name = Path(f.filename or "upload").name
        if Path(name).suffix.lower() not in SUPPORTED_EXTENSIONS:
            errors.append(f"{name}: not an .xlsx/.xls/.csv file")
            continue

        tmp = upload_dir / name
        try:
            tmp.write_bytes(await f.read())
            # A Sales Orders export only sets job names, which is an admin job
            # however the file arrives. Reported rather than raised: it's an
            # answer, not a failure, and it shouldn't log a stack trace or throw
            # away the other files in the same upload.
            if file_kind(tmp) == "sales_orders" and not is_admin(request):
                errors.append(f"{name}: job names are for admin accounts only")
                continue
            result = ingest_file(tmp, actor(request))
            results.append({**result, "source_file": name})
            write_audit(actor(request), "upload",
                        f"{name} -> {result['dataset']} ({result['row_count']} rows, {result['snapshot_date']})")
        except Exception as exc:  # noqa: BLE001
            logger.exception("Upload failed for %s", name)
            errors.append(f"{name}: {exc}")
        finally:
            tmp.unlink(missing_ok=True)

    if not results and errors:
        raise HTTPException(status_code=400, detail="; ".join(errors))
    return {"ingested": results, "errors": errors}


ADMIN_TOKEN = os.environ.get("ADMIN_TOKEN")


def _require_admin(request: Request) -> None:
    """Gate the destructive restore behind a token set only in the host's env.

    Access sits in front of everything, so this isn't the authentication layer —
    it's so a signed-in team member can't overwrite the whole database by accident.
    """
    if not ADMIN_TOKEN:
        raise HTTPException(status_code=403, detail="Restore is disabled — set ADMIN_TOKEN to enable it")
    supplied = request.headers.get("X-Admin-Token") or request.query_params.get("token")
    if supplied != ADMIN_TOKEN:
        raise HTTPException(status_code=403, detail="Bad admin token")


@app.get("/api/admin/backup")
def api_backup(request: Request):
    """Download a point-in-time copy of the database."""
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    dest = Path(tempfile.gettempdir()) / f"dashboard-backup-{stamp}.db"
    backup_to(dest)
    write_audit(actor(request), "backup", dest.name)
    return FileResponse(
        dest,
        media_type="application/octet-stream",
        filename=f"dashboard-{stamp}.db",
        background=BackgroundTask(dest.unlink, missing_ok=True),
    )


@app.post("/api/admin/restore")
async def api_restore(request: Request, file: UploadFile = File(...)):
    """Replace the database with an uploaded backup — used to seed a new host."""
    _require_admin(request)
    tmp = Path(tempfile.gettempdir()) / f"restore-{datetime.now().timestamp()}.db"
    try:
        tmp.write_bytes(await file.read())
        try:
            restore_from(tmp)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        init_db()  # bring an older backup up to the current schema
        write_audit(actor(request), "restore", Path(file.filename or "backup").name)
        return {"restored": True, "source_file": Path(file.filename or "backup").name}
    finally:
        tmp.unlink(missing_ok=True)


# BC exports each subcontract work-centre group as its own file, so they land as
# separate datasets. The Subcontractors tab treats them as one pool.
# Work that happens away from our own floor. BC exports each work-centre
# group as its own file, so they arrive as separate datasets and are merged
# into one board here.
SUB_DATASETS = ("subcontractors", "powderline")


def _merged_sub_snapshot() -> dict | None:
    """Latest snapshot of every subcontract dataset, merged into one record set."""
    records: list[dict] = []
    snaps = []
    for ds in SUB_DATASETS:
        snap = latest_snapshot(ds)
        if snap is None:
            continue
        snaps.append(snap)
        records.extend(_decorate_records(ds, get_records_for_snapshot(snap["id"])))

    if not snaps:
        return None

    newest = max(snaps, key=lambda s: s["snapshot_date"])
    return {
        "snapshot_date": newest["snapshot_date"],
        "ingested_at": newest["ingested_at"],
        "source_file": ", ".join(s["source_file"] for s in snaps),
        "row_count": sum(s["row_count"] for s in snaps),
        "records": records,
    }


# BC lists a PRO once per routing operation — Prep, Press, CNC, Wrap and any
# machining steps all repeat the same order and quantity. Prep is the first
# operation and every PRO has one, so it stands in for the whole job.
PREP_WORK_CENTRE = "JOINERY-10-PREP"


def _one_row_per_pro(records: list[dict]) -> list[dict]:
    """Collapse a PRO's routing operations to a single row.

    Without this a one-door job with five operations reads as five doors. Prefers
    the Prep row; if a PRO somehow has none, its first row is kept rather than
    dropping the job off the dashboard entirely.
    """
    chosen: dict[str, dict] = {}
    for r in records:
        pro = r.get("prod_order_no") or r.get("line_key")
        current = chosen.get(pro)
        if current is None or (
            current.get("work_centre_no") != PREP_WORK_CENTRE
            and r.get("work_centre_no") == PREP_WORK_CENTRE
        ):
            chosen[pro] = r
    return list(chosen.values())


@app.get("/api/snapshot/{dataset}")
def api_snapshot(dataset: str):
    if dataset == "subcontractors":
        merged = _merged_sub_snapshot()
        if merged is None:
            raise HTTPException(status_code=404, detail="No subcontractor data ingested yet")
        return {"dataset": dataset, **merged}

    snap = latest_snapshot(dataset)
    if snap is None:
        raise HTTPException(status_code=404, detail=f"No data ingested yet for dataset '{dataset}'")
    records = get_records_for_snapshot(snap["id"])
    if dataset == "joinery":
        records = _one_row_per_pro(records)
    records = _decorate_records(dataset, records)
    return {
        "dataset": dataset,
        "snapshot_date": snap["snapshot_date"],
        "ingested_at": snap["ingested_at"],
        "source_file": snap["source_file"],
        "row_count": snap["row_count"],
        "records": records,
    }


@app.get("/api/history/{dataset}")
def api_history(dataset: str):
    if dataset == "subcontractors":
        # combine the per-date counts across every subcontract dataset
        combined: dict[str, dict] = {}
        for ds in SUB_DATASETS:
            for row in history_counts(ds):
                acc = combined.setdefault(row["snapshot_date"], {"snapshot_date": row["snapshot_date"]})
                for key, value in row.items():
                    if key == "snapshot_date":
                        continue
                    acc[key] = (acc.get(key) or 0) + (value or 0)
        return {"dataset": dataset, "history": [combined[k] for k in sorted(combined)]}

    return {"dataset": dataset, "history": history_counts(dataset)}


# The aluminium door line at Queensland, in the order work moves through it.
# Every door runs all five — there are no optional stages on this line.
STAGES = ("cut_to_size", "machining", "components", "build", "wrap")
STAGE_LABELS = {
    "cut_to_size": "Cut to size",
    "machining": "Machining",
    "components": "Components",
    "build": "Build",
    "wrap": "Wrap",
}

BASE_STAGES = STAGES

def _stages_for(g: dict) -> tuple[str, ...]:
    """The stages this job goes through, in shop order.

    Every aluminium door runs the same five. The WA line had optional glazing
    and edge-stripping stages keyed off markers in the item description; this
    line has no such branch, so each job gets the full list.
    """
    return BASE_STAGES

# entries parked here aren't committed to a date — matches HOLDING_DATE in app.js
HOLDING_DATE = "holding"


def _group_records(records: list[dict]) -> dict[str, dict]:
    """Groups export lines by Prod. Order No.

    BC's Production Scheduler export has one row per (PRO, item, routing
    operation) — every operation of the same item repeats that item's full
    order quantity (e.g. a 24-door item with a 5-step routing shows up as
    5 rows, each with Quantity=24). Collapse to a single row per (PRO, item)
    first so totals aren't multiplied by the operation count.
    """
    # Routing operations have to be gathered before the collapse below, not
    # after. "View Panel Cut Out" is an extra CNC operation on an item that
    # already has a plain CNC row, so keeping one row per item throws away the
    # very row that says the door needs glazing.
    operations: dict[str, set[str]] = {}

    item_rows: dict[tuple[str, str], dict] = {}
    for r in records:
        pro = r.get("prod_order_no")
        if not pro:
            continue
        if r.get("work_centre_description"):
            operations.setdefault(pro, set()).add(r["work_centre_description"])
        item_key = r.get("item_no") or r.get("item_description") or ""

        # Count off the Prep row. Every operation row of an item repeats that
        # item's whole quantity, so the total is the same whichever row is kept
        # — but the due date isn't always. Where they differ, Prep is the date
        # the shop works to, and taking it by name beats taking it by luck of
        # the export's row order.
        key = (pro, item_key)
        held = item_rows.get(key)
        if held is None or (
            r.get("work_centre_no") == PREP_WORK_CENTRE
            and held.get("work_centre_no") != PREP_WORK_CENTRE
        ):
            item_rows[key] = r

    grouped: dict[str, dict] = {}
    for (pro, _item_key), r in item_rows.items():
        g = grouped.setdefault(pro, {
            "prod_order_no": pro,
            "sales_order_no": r.get("sales_order_no"),
            "source_name": r.get("source_name"),
            "items": [],
            "item_nos": [],
            "due_dates": [],
            "comments": [],
            "operations": operations.get(pro, set()),
            "total_qty": 0.0,
            "shortage": False,
        })
        g["total_qty"] += r.get("quantity") or 0
        # One short item is enough to hold the whole job up, so the flag is
        # carried on the PRO rather than left on the line it came from.
        if r.get("shortage"):
            g["shortage"] = True
        if r.get("item_description"):
            g["items"].append(r["item_description"])
        if r.get("item_no"):
            g["item_nos"].append(r["item_no"])
        # BC's Comments column is where a warehouse movement number is written.
        # The back-order comment is checked too, in case it's typed there.
        for field in ("comments", "potential_back_order_comment"):
            if r.get(field):
                g["comments"].append(r[field])
        # A job is due when it ships, not when the shop hoped to finish it, so
        # Shipment Date is what the board counts down to.
        #
        # The operation due date is kept as a fallback rather than dropped:
        # 11 of today's 124 jobs have no shipment date, and a job with no date
        # at all sorts to the bottom of Holding and loses its overdue colouring
        # entirely — worse than showing the date BC does have. Where both exist
        # shipment is always the later of the two, by a median of three days.
        due = r.get("shipment_date") or r.get("operation_due_date")
        if due:
            g["due_dates"].append(due)

    return grouped


def _pro_totals(dataset: str = "joinery") -> tuple[str | None, dict[str, dict]]:
    """Every job the boards should show: what's in the latest export, plus what
    has been posted out of it.

    Posting a job in BC drops it from the next export, and it was disappearing
    off the schedule with it — a day someone had planned and worked would empty
    out overnight. The work still happened, so the job stays where it was
    planned, carrying the details from the last export that still had it.

    Only jobs planned onto a real day come back. A job that never left Holding
    has nothing to show for itself on any day, and keeping those would build a
    queue of finished work that can never be cleared.
    """
    snap = latest_snapshot(dataset)
    if snap is None:
        return None, {}

    grouped = _group_records(get_records_for_snapshot(snap["id"]))

    missing = pros_with_dated_schedule() - set(grouped)
    if missing:
        for pro, g in _group_records(records_last_seen(dataset, missing)).items():
            g["posted"] = True
            grouped[pro] = g

    return snap["snapshot_date"], grouped


# A warehouse movement number is written into BC's comment field, in whatever
# shape the person typing it favours — WM1234, WM-1234, "wm 1234". The prefix is
# required: a comment like "12/08 SM - pushed out" is full of bare numbers that
# are nothing to do with a movement.
WM_RE = re.compile(r"WM[\s\-:#]*(\d+)", re.IGNORECASE)


def _warehouse_movement(g: dict) -> str | None:
    """The movement number, always written back as WM-1234.

    However it was typed, it leaves here in one shape — the number gets copied
    and pasted into other systems, and it should look the same every time
    rather than carrying whoever typed it into BC that day.
    """
    for text in g.get("comments", []):
        m = WM_RE.search(text or "")
        if m:
            return f"WM-{m.group(1)}"
    return None


def _single_item_no(g: dict) -> str | None:
    """The job's item number, when it has exactly one.

    A stock door carries no customer, so the item number is what identifies it —
    TDOOR249235SCP is a 2400 x 920 x 35mm. Jobs spanning several items have no
    single number to show.
    """
    distinct = {n for n in g.get("item_nos", []) if n}
    return next(iter(distinct)) if len(distinct) == 1 else None


def _factory_row(pro: str, g: dict, progress: dict, door_numbers: dict | None = None,
                 job_names: dict | None = None) -> dict | None:
    total = g["total_qty"]
    if total <= 0:
        return None
    marks = (door_numbers or {}).get(pro)
    p = progress.get(pro, {})
    done = {stage: min(p.get(f"{stage}_done", 0) or 0, total) for stage in STAGES}

    stages = _stages_for(g)
    # Percent and completion count only the stages this job actually has, so a
    # plain door isn't held at 67% forever by glazing it never needed.
    pct = sum(done[stage] / total for stage in stages) / len(stages) * 100
    # Posted means BC has closed the job out, whatever the shop got round to
    # ticking here — so it stops counting as work in production. The percentage
    # is left alone rather than rounded up to 100: it says what was recorded,
    # and POSTED already says the job is done.
    posted = bool(g.get("posted"))
    status = "completed" if posted or done[STAGES[-1]] >= total else "in_production"

    row = {
        "prod_order_no": pro,
        "sales_order_no": g["sales_order_no"],
        "source_name": g["source_name"],
        "item_summary": g["items"][0] if len(g["items"]) == 1 else f"{len(g['items'])} items",
        "item_no": _single_item_no(g),
        "posted": posted,
        "wm_number": _warehouse_movement(g),
        # The marks for this job's doors, in door order, for the label. Empty
        # when the job has none or hasn't been asked about yet; door_numbers_set
        # is what tells those two apart, and so what drives the asking.
        "door_numbers": marks["marks"] if marks else [],
        "door_numbers_set": marks is not None,
        # What the customer calls the job, from the sales order.
        "job_name": (job_names or {}).get(g["sales_order_no"] or "") or None,
        "due_date": min(g["due_dates"]) if g["due_dates"] else None,
        "shortage": bool(g.get("shortage")),
        "total_qty": total,
        "stages": list(stages),
        "pct_complete": round(pct, 1),
        "status": status,
        "completed_at": p.get("updated_at") if status == "completed" else None,
    }
    # Send every stage's tally, not just this job's — the dashboard's All-jobs
    # table has one column per stage and would otherwise read undefined.
    for stage in STAGES:
        row[f"{stage}_done"] = done[stage]
    return row


@app.get("/api/factory")
def api_factory():
    as_of, grouped = _pro_totals()
    if as_of is None:
        raise HTTPException(status_code=404, detail="No joinery data ingested yet")

    progress = get_all_stage_progress()
    door_numbers = get_all_door_numbers()
    job_names = get_all_sales_orders()
    lookup = minutes_lookup()
    rows = []
    for pro, g in grouped.items():
        row = _factory_row(pro, g, progress, door_numbers, job_names)
        if row is not None:
            row["minutes"] = _minutes_for(g, STAGES, lookup)
            rows.append(row)
    rows.sort(key=lambda r: r["due_date"] or "9999-99-99")

    return {"as_of": as_of, "rows": rows}


class DoorNumbers(BaseModel):
    prod_order_no: str
    has_numbers: bool
    marks: list[str] = Field(default_factory=list)


@app.post("/api/door-numbers")
def api_set_door_numbers(request: Request, body: DoorNumbers):
    """Record a job's door marks, or that it has none.

    Either way the job stops being asked about — "no marks" is an answer, and
    the queue is everything that hasn't had one.
    """
    require_admin(request, "Door numbers")

    _, grouped = _pro_totals()
    g = grouped.get(body.prod_order_no)
    if g is None:
        raise HTTPException(status_code=404, detail=f"{body.prod_order_no} isn't in the joinery export.")

    marks = [m.strip() for m in body.marks]
    if body.has_numbers:
        # A mark per door, in door order. Trailing blanks are fine — someone
        # filling in the ones they know shouldn't be made to do all of them.
        while marks and not marks[-1]:
            marks.pop()
        if not marks:
            raise HTTPException(
                status_code=400,
                detail="No door numbers were entered — say the job has none instead.",
            )
        total = int(g["total_qty"])
        if len(marks) > total:
            raise HTTPException(
                status_code=400,
                detail=f"{body.prod_order_no} is {_fmt_qty(g['total_qty'])} doors, so it can't have {len(marks)} numbers.",
            )

    saved = set_door_numbers(body.prod_order_no, body.has_numbers, marks, actor(request))
    write_audit(
        actor(request), "door_numbers",
        f"{body.prod_order_no} -> {', '.join(marks) if body.has_numbers else 'none'}",
    )
    return saved


class SalesOrderNames(BaseModel):
    rows: list[dict]


@app.post("/api/sales-orders")
def api_set_sales_orders(request: Request, body: SalesOrderNames):
    """Store what the customer calls each job, pasted from the Sales Orders list.

    Sent in one go rather than a request per order: a paste is the whole list,
    and a hundred round trips to save a hundred short strings is a slow way to
    do nothing.
    """
    require_admin(request, "Job names")

    pairs, skipped = [], 0
    seen = set()
    for row in body.rows:
        so = str(row.get("sales_order_no") or "").strip().upper()
        name = " ".join(str(row.get("job_name") or "").split())
        if not so or not name or so in seen:
            skipped += 1
            continue
        seen.add(so)
        pairs.append((so, name))
    if not pairs:
        raise HTTPException(status_code=400, detail="No sales orders with a job name in that paste.")

    saved = set_sales_orders(pairs, actor(request))
    write_audit(actor(request), "sales_orders", f"{saved} job names")
    return {"saved": saved, "skipped": skipped}


@app.delete("/api/door-numbers/{prod_order_no}")
def api_forget_door_numbers(request: Request, prod_order_no: str):
    """Put a job back in the queue to be asked about again."""
    require_admin(request, "Door numbers")
    if not forget_door_numbers(prod_order_no):
        raise HTTPException(status_code=404, detail=f"{prod_order_no} has no door numbers recorded.")
    write_audit(actor(request), "door_numbers", f"{prod_order_no} -> cleared")
    return {"prod_order_no": prod_order_no, "cleared": True}


# Cavities are made in-house at a separate site on their own line, with their
# own two steps. Their own product and their own orders, so they get their own
# board rather than being folded into the door schedule, where their units would
# distort the doors-per-day capacity everything else is planned against.
CAVITY_STAGES = ("cav_prep", "cav_make")
CAVITY_STAGE_LABELS = {"cav_prep": "Prep", "cav_make": "Make"}


def _cavity_row(pro: str, g: dict, progress: dict) -> dict | None:
    total = g["total_qty"]
    if total <= 0:
        return None
    p = progress.get(pro, {})
    done = {st: min(p.get(f"{st}_done", 0) or 0, total) for st in CAVITY_STAGES}
    pct = sum(done[st] / total for st in CAVITY_STAGES) / len(CAVITY_STAGES) * 100
    posted = bool(g.get("posted"))
    finished = posted or done["cav_make"] >= total

    row = {
        "prod_order_no": pro,
        "sales_order_no": g["sales_order_no"],
        "source_name": g["source_name"],
        "item_summary": g["items"][0] if len(g["items"]) == 1 else f"{len(g['items'])} items",
        "posted": posted,
        "wm_number": _warehouse_movement(g),
        "due_date": min(g["due_dates"]) if g["due_dates"] else None,
        "total_qty": total,
        "shortage": bool(g.get("shortage")),
        "stages": list(CAVITY_STAGES),
        "pct_complete": round(pct, 1),
        "status": "completed" if finished else "in_production",
        "completed_at": p.get("updated_at") if finished else None,
    }
    for st in CAVITY_STAGES:
        row[f"{st}_done"] = done[st]
    return row


@app.get("/api/cavities")
def api_cavities():
    as_of, grouped = _pro_totals("cavities")
    if as_of is None:
        raise HTTPException(status_code=404, detail="No cavities data ingested yet")

    progress = get_all_stage_progress()
    lookup = minutes_lookup()
    rows = []
    for pro, g in grouped.items():
        row = _cavity_row(pro, g, progress)
        if row is not None:
            row["minutes"] = _minutes_for(g, CAVITY_STAGES, lookup)
            rows.append(row)
    rows.sort(key=lambda r: r["due_date"] or "9999-99-99")
    return {"as_of": as_of, "rows": rows}


class CavityUpdate(BaseModel):
    prod_order_no: str
    stage: str
    done: float = Field(ge=0)


@app.post("/api/cavities/progress")
def api_cavities_progress(request: Request, update: CavityUpdate):
    if update.stage not in CAVITY_STAGES:
        raise HTTPException(status_code=400, detail=f"stage must be one of {', '.join(CAVITY_STAGES)}")

    _, grouped = _pro_totals("cavities")
    g = grouped.get(update.prod_order_no)
    if g is None:
        raise HTTPException(status_code=404, detail=f"{update.prod_order_no} isn't in the cavities export.")
    total = g["total_qty"]
    done = min(update.done, total) if total else update.done

    # Same ordering rule as the doors: Make can't run ahead of Prep, and Prep
    # can't drop below what's already been made.
    existing = dict(get_stage_progress(update.prod_order_no) or {})
    idx = CAVITY_STAGES.index(update.stage)
    if idx > 0:
        prev = CAVITY_STAGES[idx - 1]
        prev_done = existing.get(f"{prev}_done", 0) or 0
        if done > prev_done:
            raise HTTPException(
                status_code=400,
                detail=f"{CAVITY_STAGE_LABELS[update.stage]} can't be ahead of {CAVITY_STAGE_LABELS[prev]} — only {_fmt_qty(prev_done)} done there so far.",
            )
    if idx < len(CAVITY_STAGES) - 1:
        nxt = CAVITY_STAGES[idx + 1]
        next_done = existing.get(f"{nxt}_done", 0) or 0
        if done < next_done:
            raise HTTPException(
                status_code=400,
                detail=f"{CAVITY_STAGE_LABELS[update.stage]} can't drop below {CAVITY_STAGE_LABELS[nxt]} — {_fmt_qty(next_done)} already done there.",
            )

    row = set_stage_progress(update.prod_order_no, update.stage, done, actor(request))
    write_audit(actor(request), "cavities.progress",
                f"{update.prod_order_no} {update.stage} -> {_fmt_qty(done)} of {_fmt_qty(total)}")
    row["total_qty"] = total
    return row


# Powdercoating is coated here rather than sent out, so the floor ticks it off
# the same way as the doors and the cavities. It reads the subcontractors
# dataset, which is where the PC-Q export lands.
PC_STAGES = ("pc_prep", "pc_coat", "pc_pack")
PC_STAGE_LABELS = {"pc_prep": "Prep", "pc_coat": "Coat", "pc_pack": "Pack"}
PC_DATASET = "subcontractors"


def _pc_row(pro: str, g: dict, progress: dict) -> dict | None:
    total = g["total_qty"]
    if total <= 0:
        return None
    p = progress.get(pro, {})
    done = {st: min(p.get(f"{st}_done", 0) or 0, total) for st in PC_STAGES}
    pct = sum(done[st] / total for st in PC_STAGES) / len(PC_STAGES) * 100
    posted = bool(g.get("posted"))
    finished = posted or done[PC_STAGES[-1]] >= total

    row = {
        "prod_order_no": pro,
        "sales_order_no": g["sales_order_no"],
        "source_name": g["source_name"],
        "item_summary": g["items"][0] if len(g["items"]) == 1 else f"{len(g['items'])} items",
        "posted": posted,
        "wm_number": _warehouse_movement(g),
        "due_date": min(g["due_dates"]) if g["due_dates"] else None,
        "total_qty": total,
        "shortage": bool(g.get("shortage")),
        "stages": list(PC_STAGES),
        "pct_complete": round(pct, 1),
        "status": "completed" if finished else "in_production",
        "completed_at": p.get("updated_at") if finished else None,
    }
    for st in PC_STAGES:
        row[f"{st}_done"] = done[st]
    return row


@app.get("/api/powdercoat")
def api_powdercoat():
    as_of, grouped = _pro_totals(PC_DATASET)
    if as_of is None:
        raise HTTPException(status_code=404, detail="No powdercoating data ingested yet")

    progress = get_all_stage_progress()
    lookup = minutes_lookup()
    rows = []
    for pro, g in grouped.items():
        row = _pc_row(pro, g, progress)
        if row is not None:
            row["minutes"] = _minutes_for(g, PC_STAGES, lookup)
            rows.append(row)
    rows.sort(key=lambda r: r["due_date"] or "9999-99-99")
    return {"as_of": as_of, "rows": rows}


class PowdercoatUpdate(BaseModel):
    prod_order_no: str
    stage: str
    done: float = Field(ge=0)


@app.post("/api/powdercoat/progress")
def api_powdercoat_progress(request: Request, update: PowdercoatUpdate):
    if update.stage not in PC_STAGES:
        raise HTTPException(status_code=400, detail=f"stage must be one of {', '.join(PC_STAGES)}")

    _, grouped = _pro_totals(PC_DATASET)
    g = grouped.get(update.prod_order_no)
    if g is None:
        raise HTTPException(status_code=404, detail=f"{update.prod_order_no} isn't in the powdercoating export.")
    total = g["total_qty"]
    done = min(update.done, total) if total else update.done

    # Same ordering rule as the other two lines: a step can't run ahead of the
    # one before it, or drop below the one after it.
    existing = dict(get_stage_progress(update.prod_order_no) or {})
    idx = PC_STAGES.index(update.stage)
    if idx > 0:
        prev = PC_STAGES[idx - 1]
        prev_done = existing.get(f"{prev}_done", 0) or 0
        if done > prev_done:
            raise HTTPException(
                status_code=400,
                detail=f"{PC_STAGE_LABELS[update.stage]} can't be ahead of {PC_STAGE_LABELS[prev]} — only {_fmt_qty(prev_done)} done there so far.",
            )
    if idx < len(PC_STAGES) - 1:
        nxt = PC_STAGES[idx + 1]
        next_done = existing.get(f"{nxt}_done", 0) or 0
        if done < next_done:
            raise HTTPException(
                status_code=400,
                detail=f"{PC_STAGE_LABELS[update.stage]} can't drop below {PC_STAGE_LABELS[nxt]} — {_fmt_qty(next_done)} already done there.",
            )

    row = set_stage_progress(update.prod_order_no, update.stage, done, actor(request))
    write_audit(actor(request), "powdercoat.progress",
                f"{update.prod_order_no} {update.stage} -> {_fmt_qty(done)} of {_fmt_qty(total)}")
    row["total_qty"] = total
    return row


class ProgressUpdate(BaseModel):
    prod_order_no: str
    stage: str
    done: float = Field(ge=0)


def _fmt_qty(v: float) -> str:
    return str(int(v)) if float(v).is_integer() else str(v)


@app.post("/api/factory/progress")
def api_factory_progress(request: Request, update: ProgressUpdate):
    if update.stage not in STAGES:
        raise HTTPException(status_code=400, detail=f"stage must be one of {', '.join(STAGES)}")

    _, grouped = _pro_totals()
    g = grouped.get(update.prod_order_no)
    total = g["total_qty"] if g else None
    done = min(update.done, total) if total else update.done

    existing = get_stage_progress(update.prod_order_no)
    existing = dict(existing) if existing else {}

    # Order against the stages this job actually has. On a door with no glazing,
    # Finish follows CNC directly, and checking against the global list would
    # compare it to a stage that will never be worked.
    stages = _stages_for(g) if g else BASE_STAGES
    if update.stage not in stages:
        raise HTTPException(
            status_code=400,
            detail=f"{STAGE_LABELS[update.stage]} isn't a stage on {update.prod_order_no}.",
        )
    idx = stages.index(update.stage)

    if idx > 0:
        prev_stage = stages[idx - 1]
        prev_done = existing.get(f"{prev_stage}_done", 0) or 0
        if done > prev_done:
            raise HTTPException(
                status_code=400,
                detail=f"{STAGE_LABELS[update.stage]} can't be ahead of {STAGE_LABELS[prev_stage]} — only {_fmt_qty(prev_done)} done there so far.",
            )

    if idx < len(stages) - 1:
        next_stage = stages[idx + 1]
        next_done = existing.get(f"{next_stage}_done", 0) or 0
        if done < next_done:
            raise HTTPException(
                status_code=400,
                detail=f"{STAGE_LABELS[update.stage]} can't drop below {STAGE_LABELS[next_stage]} — {_fmt_qty(next_done)} already done there.",
            )

    row = set_stage_progress(update.prod_order_no, update.stage, done, actor(request))
    write_audit(actor(request), "factory.progress",
                f"{update.prod_order_no} {update.stage} -> {_fmt_qty(done)}")
    row["total_qty"] = total
    return row


class FactoryReset(BaseModel):
    prod_order_nos: list[str]


@app.post("/api/factory/reset")
def api_factory_reset(request: Request, body: FactoryReset):
    """Put these jobs back to a clean, unstarted state.

    Clears recorded stage progress and returns any dated schedule entries to
    Holding, so the job can be re-planned from scratch rather than being left
    half-scheduled against progress that no longer exists.
    """
    pros = [p for p in body.prod_order_nos if p]
    if not pros:
        raise HTTPException(status_code=400, detail="No production orders given to reset")
    cleared = reset_stage_progress(pros)
    unallocated = unallocate_pros(pros)
    write_audit(actor(request), "factory.reset",
                f"{len(pros)} jobs: {', '.join(pros[:20])}{' …' if len(pros) > 20 else ''}")
    return {"cleared": cleared, "unallocated": unallocated, "requested": len(pros)}


# The board schedules doors and cavities alike. They're different datasets with
# different PRO numbers, so a stage decides which one to look the order up in.
SCHEDULABLE_STAGES = tuple(STAGES) + CAVITY_STAGES


def _grouped_for_stage(stage: str) -> dict:
    return _pro_totals("cavities")[1] if stage in CAVITY_STAGES else _pro_totals()[1]


def _stage_label(stage: str) -> str:
    return CAVITY_STAGE_LABELS.get(stage) or PC_STAGE_LABELS.get(stage) or STAGE_LABELS.get(stage, stage)


def _available_to_schedule(pro: str, stage: str, grouped: dict, progress: dict, exclude_entry_id: int | None = None) -> float:
    g = grouped.get(pro)
    if not g:
        return 0.0
    total = g["total_qty"]
    done = (progress.get(pro, {}) or {}).get(f"{stage}_done", 0) or 0
    scheduled = sum_scheduled_qty(pro, stage, exclude_entry_id)
    return max(0.0, total - done - scheduled)


def _decorate_schedule_entry(entry: dict, grouped: dict) -> dict:
    g = grouped.get(entry["prod_order_no"], {})
    items = g.get("items") or []
    return {
        **entry,
        "sales_order_no": g.get("sales_order_no"),
        "source_name": g.get("source_name"),
        "item_summary": items[0] if len(items) == 1 else (f"{len(items)} items" if items else None),
        "due_date": min(g["due_dates"]) if g.get("due_dates") else None,
        "total_qty": g.get("total_qty"),
    }


@app.get("/api/schedule")
def api_schedule_list():
    doors = _pro_totals()[1]
    cavities = _pro_totals("cavities")[1]
    entries = [
        _decorate_schedule_entry(e, cavities if e["stage"] in CAVITY_STAGES else doors)
        for e in get_all_schedule_entries()
    ]
    return {
        "entries": entries,
        "day_plans": get_day_plans(),
        "day_priorities": get_day_priorities(),
    }


class DayPriorityIn(BaseModel):
    date: str
    section: str
    order: list[str] = Field(default_factory=list)


@app.post("/api/schedule/priorities")
def api_set_day_priorities(request: Request, body: DayPriorityIn):
    """Set one department's running order for one day."""
    if body.date == HOLDING_DATE:
        raise HTTPException(
            status_code=400,
            detail="Holding is a backlog, not a running order — it stays sorted by due date.",
        )
    n = set_day_priorities(body.date, body.section, body.order)
    write_audit(actor(request), "set_priorities", f"{body.date} {body.section} — {n} orders")
    return {"date": body.date, "section": body.section, "ranked": n}


class DayPlanLine(BaseModel):
    stage: str
    prod_order_no: str
    qty: float


class DayLockIn(BaseModel):
    date: str
    lines: list[DayPlanLine] = Field(default_factory=list)


@app.post("/api/schedule/lock")
def api_lock_day(request: Request, body: DayLockIn):
    """Freeze what the morning meeting committed to for a day.

    The lines come from the board rather than being recomputed here, because
    what was agreed is precisely what everyone was looking at on screen. Press
    and CNC mostly aren't bookings of their own — they hang off a dated Make —
    so the server has no independent view of what "on Wednesday" meant.
    """
    if body.date == HOLDING_DATE:
        raise HTTPException(status_code=400, detail="Holding isn't a day, so there's nothing to lock.")
    for line in body.lines:
        if line.stage not in SCHEDULABLE_STAGES:
            raise HTTPException(status_code=400, detail=f"Unknown stage '{line.stage}'.")

    plan = lock_day(body.date, [ln.model_dump() for ln in body.lines], current_user(request))
    write_audit(actor(request), "lock_day", f"{body.date} — {len(body.lines)} lines")
    return plan


@app.delete("/api/schedule/lock/{scheduled_date}")
def api_unlock_day(request: Request, scheduled_date: str):
    if not unlock_day(scheduled_date):
        raise HTTPException(status_code=404, detail="That day isn't locked.")
    write_audit(actor(request), "unlock_day", scheduled_date)
    return {"date": scheduled_date, "locked": False}


class ScheduleEntryIn(BaseModel):
    prod_order_no: str
    stage: str
    date: str
    qty: float = Field(gt=0)


@app.post("/api/schedule")
def api_schedule_create(request: Request, body: ScheduleEntryIn):
    if body.stage not in SCHEDULABLE_STAGES:
        raise HTTPException(status_code=400, detail=f"stage must be one of {', '.join(SCHEDULABLE_STAGES)}")

    grouped = _grouped_for_stage(body.stage)
    if body.prod_order_no not in grouped:
        raise HTTPException(status_code=404, detail=f"Unknown production order '{body.prod_order_no}'")

    progress = get_all_stage_progress()
    total = grouped[body.prod_order_no]["total_qty"]
    done = (progress.get(body.prod_order_no, {}) or {}).get(f"{body.stage}_done", 0) or 0
    capacity = max(0.0, total - done)

    # capacity check and insert happen in one transaction so two drags landing
    # together can't both pass the check and double-book the job
    try:
        entry = create_schedule_entry_checked(body.prod_order_no, body.stage, body.date, body.qty, capacity)
    except OverBooked as e:
        raise HTTPException(
            status_code=400,
            detail=f"Only {_fmt_qty(e.available)} left to schedule for {_stage_label(body.stage)} on {body.prod_order_no}.",
        )
    write_audit(actor(request), "schedule.create",
                f"{body.prod_order_no} {body.stage} {_fmt_qty(body.qty)} -> {body.date}")
    return _decorate_schedule_entry(entry, grouped)


class ScheduleMove(BaseModel):
    date: str | None = None
    qty: float | None = Field(default=None, gt=0)


@app.post("/api/schedule/{entry_id}/move")
def api_schedule_move(request: Request, entry_id: int, body: ScheduleMove):
    existing = get_schedule_entry(entry_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Schedule entry not found")

    grouped = _grouped_for_stage(existing["stage"])
    if body.qty is not None:
        progress = get_all_stage_progress()
        available = _available_to_schedule(existing["prod_order_no"], existing["stage"], grouped, progress, exclude_entry_id=entry_id)
        if body.qty > available + 1e-9:
            raise HTTPException(
                status_code=400,
                detail=f"Only {_fmt_qty(available)} left to schedule for {_stage_label(existing['stage'])} on {existing['prod_order_no']}.",
            )

    entry = update_schedule_entry(entry_id, date=body.date, qty=body.qty)
    return _decorate_schedule_entry(entry, grouped)


class ScheduleSplit(BaseModel):
    qty: float = Field(gt=0)
    date: str | None = None


@app.post("/api/schedule/{entry_id}/split")
def api_schedule_split(request: Request, entry_id: int, body: ScheduleSplit):
    existing = get_schedule_entry(entry_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Schedule entry not found")
    if body.qty >= existing["qty"]:
        raise HTTPException(status_code=400, detail="Split amount must be less than the chunk being split.")

    grouped = _grouped_for_stage(existing["stage"])
    remaining = existing["qty"] - body.qty
    update_schedule_entry(entry_id, qty=remaining)
    new_entry = create_schedule_entry(
        existing["prod_order_no"], existing["stage"], body.date or existing["scheduled_date"], body.qty
    )
    return {
        "original": _decorate_schedule_entry(get_schedule_entry(entry_id), grouped),
        "new": _decorate_schedule_entry(new_entry, grouped),
    }


@app.post("/api/schedule/{entry_id}/join")
def api_schedule_join(request: Request, entry_id: int):
    """Undo the splitting of a PRO's stage — every chunk lands on this one's day."""
    existing = get_schedule_entry(entry_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Schedule entry not found")

    merged = join_schedule_entries(entry_id)
    grouped = _grouped_for_stage(merged["stage"])
    write_audit(
        actor(request),
        "join_schedule",
        f"{merged['prod_order_no']} {merged['stage']} — {merged['chunks_joined']} chunks -> {merged['scheduled_date']}",
    )
    return {
        "entry": _decorate_schedule_entry(merged, grouped),
        "chunks_joined": merged["chunks_joined"],
    }


class ScheduleUnallocate(BaseModel):
    dates: list[str]


@app.post("/api/schedule/unallocate")
def api_schedule_unallocate(request: Request, body: ScheduleUnallocate):
    """Clear whole days back to Holding so they can be re-planned."""
    dates = [d for d in body.dates if d and d != HOLDING_DATE]
    if not dates:
        raise HTTPException(status_code=400, detail="No days given to reset")
    moved = unallocate_dates(dates)
    write_audit(actor(request), "schedule.reset_days", f"{moved} entries from {', '.join(dates)}")
    return {"moved": moved, "dates": dates}


@app.delete("/api/schedule/{entry_id}")
def api_schedule_delete(request: Request, entry_id: int):
    ok = delete_schedule_entry(entry_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Schedule entry not found")
    return {"deleted": entry_id}


# ---------- subcontractor scheduling ----------

SUB_STATUSES = ("waiting_material", "ready_despatch", "at_sub", "ready")

# BC lists several operation names per subcontractor (e.g. SUB-ELAW covers both
# "Aluminium Door Fabrication" and "Picking & Cutting") — the board groups by the
# contractor, keeping the operation name as detail on each card.
SUB_CONTRACTOR_NAMES = {
    "SUB-ELAW": "Elaw",
    "SUB-ANODISERS": "WA Anodisers",
    "POWDERLINE": "Powderline",
    "SUB-WENCO": "Wenco",
    # Queensland coats in house, so this one is a work centre of ours rather
    # than a contractor. It still groups the board the same way.
    "PC-10-Q": "Powdercoating",
}


def _contractor_name(work_centre_no: str) -> str:
    return SUB_CONTRACTOR_NAMES.get(work_centre_no, work_centre_no)


PO_REF_RE = re.compile(r"PO-\d+")


def _po_refs(comments: str | None) -> list[str]:
    """The scheduler keeps sub PO numbers in a free-text Comments field, so they
    can arrive annotated ('PO-045764, ETA Wed 05/08') or doubled up
    ('PO-035279, PO-035300'). Pull out every PO-##### we can find."""
    if not comments:
        return []
    return PO_REF_RE.findall(str(comments))


def _default_sub_status(rec: dict) -> str:
    """Best guess at where a job sits, used until someone sets it explicitly."""
    if (rec.get("operation_remaining_qty") or 0) <= 0:
        return "ready"
    if rec.get("shortage"):
        return "waiting_material"
    if rec.get("comments"):
        return "at_sub"  # a sub PO has been raised, so it's gone out
    return "ready_despatch"


@app.get("/api/subcontractors")
def api_subcontractors():
    snap = _merged_sub_snapshot()
    if snap is None:
        raise HTTPException(status_code=404, detail="No subcontractor data ingested yet")

    records = snap["records"]
    stored = get_all_sub_status()
    purchase_orders = get_all_purchase_orders()

    # one card per (PRO, work centre) — BC repeats a row per routing operation
    jobs: dict[tuple[str, str], dict] = {}
    for r in records:
        pro = r.get("prod_order_no")
        wc = r.get("work_centre_no")
        if not pro or not wc:
            continue
        key = (pro, wc)
        job = jobs.get(key)
        if job is None:
            saved = stored.get(key, {})
            jobs[key] = {
                "prod_order_no": pro,
                "work_centre_no": wc,
                "contractor": _contractor_name(wc),
                "operation_name": r.get("work_centre_description") or wc,
                "sales_order_no": r.get("sales_order_no"),
                "source_name": r.get("source_name"),
                "item_no": r.get("item_no"),
                "item_description": r.get("item_description"),
                "colour_description": r.get("colour_description"),
                "sub_po": r.get("comments"),
                "eta_note": r.get("potential_back_order_comment"),
                "due_date": r.get("operation_due_date"),
                "shipment_date": r.get("shipment_date"),
                "due_in_days": r.get("due_in_days"),
                "overdue": r.get("overdue"),
                "shortage": bool(r.get("shortage")),
                "qty": r.get("quantity") or 0,
                "remaining_qty": r.get("operation_remaining_qty") or 0,
                "uom": r.get("uom") or "EA",
                "status": saved.get("status") or _default_sub_status(r),
                "status_is_default": not saved.get("status"),
                "eta_date": saved.get("eta_date"),
                "priority": saved.get("priority", 2),
                "note": saved.get("note"),
            }
        else:
            # keep the earliest due date and worst-case flags across the PRO's lines
            if r.get("operation_due_date") and (not job["due_date"] or r["operation_due_date"] < job["due_date"]):
                job["due_date"] = r["operation_due_date"]
                job["due_in_days"] = r.get("due_in_days")
            job["overdue"] = job["overdue"] or r.get("overdue")
            job["shortage"] = job["shortage"] or bool(r.get("shortage"))
            if not job["eta_note"] and r.get("potential_back_order_comment"):
                job["eta_note"] = r["potential_back_order_comment"]

    today = date.today()
    for job in jobs.values():
        refs = _po_refs(job.get("sub_po"))
        matched = [purchase_orders[ref] for ref in refs if ref in purchase_orders]

        job["po_refs"] = refs
        job["po_unmatched"] = [ref for ref in refs if ref not in purchase_orders]

        if not matched:
            job["po"] = None
            job["po_received"] = None
            job["days_out"] = None
            continue

        # a job can span more than one PO — take the latest promise and the
        # earliest raise date, and only call it received when all of them are
        po_expected = [p["expected_receipt_date"] for p in matched if p.get("expected_receipt_date")]
        po_ordered = [p["order_date"] for p in matched if p.get("order_date")]

        job["po"] = {
            "numbers": [p["po_no"] for p in matched],
            "vendor_name": matched[0].get("vendor_name"),
            "expected_receipt_date": max(po_expected) if po_expected else None,
            "order_date": min(po_ordered) if po_ordered else None,
            "value_incl_gst": sum(p.get("total_incl_gst") or 0 for p in matched),
            "status": matched[0].get("status"),
        }
        job["po_received"] = all(p.get("completely_received") for p in matched)

        # true days-out, measured from when the PO was actually raised
        days_out = None
        if job["po"]["order_date"]:
            try:
                days_out = (today - datetime.fromisoformat(job["po"]["order_date"]).date()).days
            except ValueError:
                days_out = None
        job["days_out"] = days_out

        # BC's expected receipt date seeds the ETA until someone overrides it
        if not job.get("eta_date") and job["po"]["expected_receipt_date"]:
            job["eta_date"] = job["po"]["expected_receipt_date"][:10]
            job["eta_from_po"] = True

    return {
        "as_of": snap["snapshot_date"],
        "po_count": len(purchase_orders),
        "jobs": list(jobs.values()),
    }


class SubStatusUpdate(BaseModel):
    prod_order_no: str
    work_centre_no: str
    status: str | None = None
    eta_date: str | None = None
    # priority doubles as the manual running order within a lane: 1 = do first
    priority: int | None = Field(default=None, ge=1)
    note: str | None = None


@app.post("/api/subcontractors/status")
def api_sub_status(request: Request, update: SubStatusUpdate):
    if update.status is not None and update.status not in SUB_STATUSES:
        raise HTTPException(status_code=400, detail=f"status must be one of {', '.join(SUB_STATUSES)}")

    fields = {k: v for k, v in update.model_dump().items() if k not in ("prod_order_no", "work_centre_no") and v is not None}
    if not fields:
        raise HTTPException(status_code=400, detail="Nothing to update")

    result = set_sub_status(update.prod_order_no, update.work_centre_no, **fields)
    write_audit(actor(request), "sub.status",
                f"{update.prod_order_no} @{update.work_centre_no}: {fields}")
    return result


class SubReorderItem(BaseModel):
    prod_order_no: str
    work_centre_no: str
    priority: int = Field(ge=1)
    status: str | None = None


class SubReorder(BaseModel):
    items: list[SubReorderItem]


@app.post("/api/subcontractors/reorder")
def api_sub_reorder(request: Request, body: SubReorder):
    """Renumber a whole lane in one call — dragging a card to a new position
    rewrites the running order for everything in that lane."""
    for item in body.items:
        if item.status is not None and item.status not in SUB_STATUSES:
            raise HTTPException(status_code=400, detail=f"status must be one of {', '.join(SUB_STATUSES)}")

    updated = 0
    for item in body.items:
        fields = {"priority": item.priority}
        if item.status is not None:
            fields["status"] = item.status
        set_sub_status(item.prod_order_no, item.work_centre_no, **fields)
        updated += 1
    write_audit(actor(request), "sub.reorder", f"{updated} jobs renumbered")
    return {"updated": updated}


@app.get("/floor")
def floor_tool():
    """The phone tool the factory floor uses.

    A separate page from the dashboard on purpose: same database, same API, but
    stripped to scanning a job card and saying how many are done. Defined before
    the static mount so /floor resolves without the .html.
    """
    return FileResponse(FRONTEND_DIR / "floor.html", media_type="text/html")


# ---------- progress history ----------


def _line_for_pro(pro: str) -> tuple[str, dict, dict] | None:
    """Which line a job is on, with its grouped row and the line's config."""
    for line_id, line in LINES.items():
        _, grouped = _pro_totals(line["dataset"])
        if pro in grouped:
            return line_id, line, grouped[pro]
    return None


def _unit_times(events: list[dict], stage: str) -> dict[int, str]:
    """When each unit was ticked off at a step.

    stage_progress only keeps a running total, so a unit's time is the moment
    the total first reached it. Going backwards (a correction) releases the
    units above the new total, and they take a new time if they are ticked
    again.
    """
    times: dict[int, str] = {}
    for e in events:
        if e["stage"] != stage:
            continue
        to_qty = e["to_qty"]
        if e["delta"] > 0:
            for unit in range(int(e["from_qty"]) + 1, int(to_qty) + 1):
                times[unit] = e["at"]
        else:
            for unit in list(times):
                if unit > to_qty:
                    del times[unit]
    return times


@app.get("/api/progress/events")
def api_progress_events(date_from: str = "", date_to: str = "", prod_order_no: str = ""):
    return {"events": get_progress_events(date_from or None, date_to or None, prod_order_no or None)}


@app.get("/api/job/{prod_order_no}")
def api_job(prod_order_no: str):
    """One job as a grid of units against steps, for the unit tracker."""
    found = _line_for_pro(prod_order_no)
    if found is None:
        raise HTTPException(status_code=404, detail=f"{prod_order_no} isn't in any current export.")
    line_id, line, g = found

    total = g["total_qty"]
    progress = dict(get_stage_progress(prod_order_no) or {})
    events = get_progress_events(prod_order_no=prod_order_no)

    # Fractional quantities (powdercoat is cut in lengths) can't be a grid of
    # whole units, so the tracker falls back to the quantity on those jobs.
    whole_units = float(total).is_integer() and total > 0

    stages = []
    for st in line["stages"]:
        done = min(progress.get(f"{st}_done", 0) or 0, total)
        times = _unit_times(events, st) if whole_units else {}
        stages.append({
            "stage": st,
            "label": line["labels"].get(st, st),
            "done": done,
            "units": [
                {"unit": u, "done": u <= done, "at": times.get(u)}
                for u in range(1, int(total) + 1)
            ] if whole_units else [],
        })

    return {
        "prod_order_no": prod_order_no,
        "line": line_id,
        "line_label": line["label"],
        "sales_order_no": g.get("sales_order_no"),
        "source_name": g.get("source_name"),
        "due_date": min(g["due_dates"]) if g.get("due_dates") else None,
        "total_qty": total,
        "whole_units": whole_units,
        "wm_number": _warehouse_movement(g),
        "stages": stages,
    }


# ---------- estimated time ----------


def minutes_lookup():
    """Minutes per unit for a product group at a step, fallbacks resolved.

    Product row first, then the default row, then BC's own estimate. Built
    once per request — the catalogue is a read of the current snapshots.
    """
    stored = get_product_minutes()
    defaults = stored.get(DEFAULT_GROUP, {})
    bc = {e["group"]: e["bc_estimate"] for e in _product_catalogue()}

    def lookup(group: str, stage: str):
        value = (stored.get(group) or {}).get(stage)
        if value is None:
            value = defaults.get(stage)
        if value is None:
            value = bc.get(group)
        return value

    return lookup


def _minutes_for(g: dict, stages, lookup) -> dict:
    """A job's minutes per unit at each step.

    A PRO is usually one item. Where it carries several, the mean across them
    is used rather than picking one — the export doesn't keep each item's own
    quantity once the rows are collapsed, so a weighted figure isn't available.
    """
    groups = [
        product_group_key(item_no, desc)
        for item_no, desc in zip(g.get("item_nos", []), g.get("items", []))
    ] or [product_group_key(None, None)]

    out = {}
    for stage in stages:
        values = [v for v in (lookup(grp, stage) for grp in groups) if v is not None]
        out[stage] = round(sum(values) / len(values), 2) if values else None
    return out


# ---------- settings ----------

# The three lines the floor runs, each with its own steps and its own export.
LINES = {
    "doors": {"label": "Aluminium doors", "stages": STAGES, "labels": STAGE_LABELS, "dataset": "joinery"},
    "cavities": {"label": "Cavities", "stages": CAVITY_STAGES, "labels": CAVITY_STAGE_LABELS, "dataset": "cavities"},
    "powdercoat": {"label": "Powdercoating", "stages": PC_STAGES, "labels": PC_STAGE_LABELS, "dataset": PC_DATASET},
}
ALL_STAGES = tuple(st for ln in LINES.values() for st in ln["stages"])

DEFAULT_GROUP = "__default__"

# A stock length in metres, e.g. "(2.8)". One decimal place on purpose, so it
# can't swallow "(For 92mm Studs)" — the stud width is part of the product.
_LENGTH_IN_PARENS = re.compile(r"\s*\(\s*\d+\.\d\s*\)")
# A made-to-order size, e.g. "2700 x 920" or "2,040 x 1,200". The lookahead
# keeps section sizes like "100 x 3.0mm", which name the profile instead.
_MADE_TO_SIZE = re.compile(r"\s*\b\d[\d,]*(?:\.\d+)?\s*[xX]\s*\d[\d,]*(?:\.\d+)?\b(?!\s*mm)")


def product_family(item_no: str | None) -> str:
    """The item number with its per-order serial dropped."""
    parts = str(item_no or "").split("-")
    return "-".join(parts[:-1]) if len(parts) > 1 and parts[-1].isdigit() else str(item_no or "")


def strip_size(description: str | None) -> str:
    text = _LENGTH_IN_PARENS.sub("", str(description or ""))
    text = _MADE_TO_SIZE.sub("", text)
    return re.sub(r"\s{2,}", " ", text).strip(" ,-")


def product_group_key(item_no: str | None, description: str | None) -> str:
    return f"{product_family(item_no)}|{strip_size(description)}"


PLANNING_DEFAULTS = {
    "shift_start": "07:00",
    "lead_time_days": 3,
    "days_shown": 10,
    "capacity_measure": "hours",      # count | sqm | linear | hours
    "capacity_stage": "",             # blank = the first step on the line
    "daily_rates": {"doors": 20, "cavities": 8, "powdercoat": 40},
    "stage_offsets": {"machining": 0, "components": 1, "build": 1, "wrap": 1},
}


def get_planning() -> dict:
    stored = get_setting("planning")
    out = dict(PLANNING_DEFAULTS)
    if stored:
        try:
            out.update(json.loads(stored))
        except ValueError:
            pass
    return out


# Queensland public holidays. Seeded once at zero hours and editable after
# that, because the dates move and the shop knows its own shutdown better than
# a hard-coded list does.
QLD_HOLIDAYS_2026 = [
    ("2026-01-01", "New Year's Day"),
    ("2026-01-26", "Australia Day"),
    ("2026-04-03", "Good Friday"),
    ("2026-04-04", "Easter Saturday"),
    ("2026-04-06", "Easter Monday"),
    ("2026-04-25", "Anzac Day"),
    ("2026-05-04", "Labour Day"),
    ("2026-08-12", "Royal Queensland Show (Brisbane)"),
    ("2026-10-05", "King's Birthday"),
    ("2026-12-25", "Christmas Day"),
    ("2026-12-26", "Boxing Day"),
]


def _seed_settings():
    """Give every step a working week and load the holidays, once.

    Only runs while the tables are empty, so an edit is never overwritten.
    """
    if not get_work_hours():
        planning = get_planning()
        rows = [
            {"stage": st, "weekday": wd, "hours": 8.0 if wd < 5 else 0.0}
            for st in ALL_STAGES
            for wd in range(7)
        ]
        set_work_hours(rows)
        logger.info("Seeded an 8h Mon-Fri week for %d steps (shift start %s)",
                    len(ALL_STAGES), planning["shift_start"])
    if not get_day_overrides():
        for the_date, note in QLD_HOLIDAYS_2026:
            set_day_override(the_date, "", 0.0, note)
        logger.info("Seeded %d Queensland public holidays", len(QLD_HOLIDAYS_2026))


def _product_catalogue() -> list[dict]:
    """Every product group in the current exports, with BC's own estimate.

    BC gives minutes for the whole operation line, so it is divided by the
    quantity to get minutes per unit, then averaged across the rows in the
    group — they agree with each other in practice.
    """
    seen: dict[str, dict] = {}
    for line_id, line in LINES.items():
        snap = latest_snapshot(line["dataset"])
        if not snap:
            continue
        for r in get_records_for_snapshot(snap["id"]):
            key = product_group_key(r.get("item_no"), r.get("item_description"))
            if key == "|":
                continue
            entry = seen.setdefault(key, {
                "group": key,
                "line": line_id,
                "family": product_family(r.get("item_no")),
                "description": strip_size(r.get("item_description")),
                "rows": 0,
                "_mins": [],
            })
            entry["rows"] += 1
            try:
                mins = float(r.get("expected_capacity_need_minutes") or 0)
                qty = float(r.get("quantity") or 0)
                if mins > 0 and qty > 0:
                    entry["_mins"].append(mins / qty)
            except (TypeError, ValueError):
                pass
    out = []
    for entry in seen.values():
        mins = entry.pop("_mins")
        entry["bc_estimate"] = round(sum(mins) / len(mins), 2) if mins else None
        out.append(entry)
    out.sort(key=lambda e: (e["line"], e["family"], e["description"]))
    return out


@app.get("/api/settings")
def api_settings():
    stored_minutes = get_product_minutes()
    catalogue = _product_catalogue()
    live = {e["group"] for e in catalogue}
    # Products that have dropped out of the exports keep their settings, and
    # are listed so they can still be seen and cleared.
    for group in stored_minutes:
        if group not in live and group != DEFAULT_GROUP:
            family, _, description = group.partition("|")
            catalogue.append({"group": group, "line": "", "family": family,
                              "description": description, "rows": 0,
                              "bc_estimate": None, "retired": True})
    return {
        "lines": {k: {"label": v["label"], "stages": list(v["stages"]),
                      "labels": dict(v["labels"])} for k, v in LINES.items()},
        "work_hours": {st: get_work_hours().get(st, {}) for st in ALL_STAGES},
        "day_overrides": get_day_overrides(),
        "product_minutes": stored_minutes,
        "products": catalogue,
        "planning": get_planning(),
    }


class WorkHoursIn(BaseModel):
    rows: list[dict]


@app.post("/api/settings/hours")
def api_set_hours(request: Request, body: WorkHoursIn):
    require_admin(request, "change working hours")
    for r in body.rows:
        if r.get("stage") not in ALL_STAGES:
            raise HTTPException(status_code=400, detail=f"Unknown step '{r.get('stage')}'.")
        if not 0 <= int(r.get("weekday", -1)) <= 6:
            raise HTTPException(status_code=400, detail="weekday must be 0-6.")
        if float(r.get("hours", 0)) < 0:
            raise HTTPException(status_code=400, detail="Hours can't be negative.")
    set_work_hours(body.rows)
    write_audit(actor(request), "settings.hours", f"{len(body.rows)} rows")
    return {"saved": len(body.rows)}


class DayOverrideIn(BaseModel):
    the_date: str
    stage: str = ""
    hours: float = Field(ge=0)
    note: str = ""


@app.post("/api/settings/day")
def api_set_day(request: Request, body: DayOverrideIn):
    require_admin(request, "change a day's hours")
    if body.stage and body.stage not in ALL_STAGES:
        raise HTTPException(status_code=400, detail=f"Unknown step '{body.stage}'.")
    set_day_override(body.the_date, body.stage, body.hours, body.note)
    write_audit(actor(request), "settings.day", f"{body.the_date} {body.stage or 'all'} -> {body.hours}h")
    return {"saved": True}


@app.delete("/api/settings/day/{the_date}")
def api_delete_day(request: Request, the_date: str, stage: str = ""):
    require_admin(request, "clear a day's hours")
    delete_day_override(the_date, stage)
    write_audit(actor(request), "settings.day.delete", f"{the_date} {stage or 'all'}")
    return {"deleted": True}


class MinutesIn(BaseModel):
    rows: list[dict]


@app.post("/api/settings/minutes")
def api_set_minutes(request: Request, body: MinutesIn):
    require_admin(request, "change minutes per unit")
    for r in body.rows:
        if r.get("stage") not in ALL_STAGES:
            raise HTTPException(status_code=400, detail=f"Unknown step '{r.get('stage')}'.")
        if r.get("minutes") not in (None, "") and float(r["minutes"]) < 0:
            raise HTTPException(status_code=400, detail="Minutes can't be negative.")
    set_product_minutes(body.rows)
    write_audit(actor(request), "settings.minutes", f"{len(body.rows)} rows")
    return {"saved": len(body.rows)}


class PlanningIn(BaseModel):
    values: dict


@app.post("/api/settings/planning")
def api_set_planning(request: Request, body: PlanningIn):
    require_admin(request, "change planning settings")
    allowed = set(PLANNING_DEFAULTS)
    unknown = set(body.values) - allowed
    if unknown:
        raise HTTPException(status_code=400, detail=f"Unknown setting(s): {', '.join(sorted(unknown))}")
    merged = get_planning()
    merged.update(body.values)
    if merged["capacity_measure"] not in ("count", "sqm", "linear", "hours"):
        raise HTTPException(status_code=400, detail="capacity_measure must be count, sqm, linear or hours.")
    set_setting("planning", json.dumps(merged))
    write_audit(actor(request), "settings.planning", ", ".join(sorted(body.values)))
    return merged


# ---------- efficiency ----------


def hours_available_on(the_date: str, stage: str, hours: dict, overrides: dict) -> float:
    """What a step was given on a date. Same precedence as the board."""
    if (the_date, stage) in overrides:
        return overrides[(the_date, stage)]
    if (the_date, "") in overrides:
        return overrides[(the_date, "")]
    weekday = date.fromisoformat(the_date).weekday()
    return (hours.get(stage) or {}).get(weekday, 0.0)


def pro_minutes_map() -> dict[str, dict[str, float]]:
    """Minutes per unit for every job in the current exports, by PRO."""
    lookup = minutes_lookup()
    out: dict[str, dict[str, float]] = {}
    for line in LINES.values():
        _, grouped = _pro_totals(line["dataset"])
        for pro, g in grouped.items():
            out[pro] = _minutes_for(g, line["stages"], lookup)
    return out


def _stage_line(stage: str) -> str:
    for line_id, line in LINES.items():
        if stage in line["stages"]:
            return line_id
    return ""


@app.get("/api/efficiency")
def api_efficiency(date_from: str, date_to: str):
    """Planned, earned and actual hours per step per day.

    Planned is the work sitting on that day. Earned is the estimated time of
    whatever was ticked off that day, which is why the tick log exists. Actual
    is typed in, and falls back to the hours the day was given.
    """
    try:
        date.fromisoformat(date_from), date.fromisoformat(date_to)
    except ValueError:
        raise HTTPException(status_code=400, detail="Dates must be YYYY-MM-DD.")
    if date_to < date_from:
        raise HTTPException(status_code=400, detail="The end date is before the start date.")

    minutes = pro_minutes_map()
    default_minutes = get_product_minutes().get(DEFAULT_GROUP, {})

    def mins_for(pro: str, stage: str):
        value = (minutes.get(pro) or {}).get(stage)
        return value if value is not None else default_minutes.get(stage)

    cells: dict[tuple[str, str], dict] = {}

    def cell(the_date: str, stage: str) -> dict:
        return cells.setdefault((the_date, stage), {
            "date": the_date, "stage": stage, "line": _stage_line(stage),
            "planned_hours": 0.0, "earned_hours": 0.0, "units": 0.0, "pros": {},
        })

    # planned — what the board has on that day
    for e in get_all_schedule_entries():
        the_date = e["scheduled_date"]
        if the_date == HOLDING_DATE or not (date_from <= the_date <= date_to):
            continue
        m = mins_for(e["prod_order_no"], e["stage"])
        if m:
            cell(the_date, e["stage"])["planned_hours"] += (e["qty"] or 0) * m / 60

    # earned — the estimated time of what was ticked that day
    for ev in get_progress_events(date_from, date_to):
        if ev["delta"] <= 0:
            continue
        the_date = ev["at"][:10]
        if not (date_from <= the_date <= date_to):
            continue
        c = cell(the_date, ev["stage"])
        m = mins_for(ev["prod_order_no"], ev["stage"])
        hours = (ev["delta"] * m / 60) if m else 0.0
        c["earned_hours"] += hours
        c["units"] += ev["delta"]
        pro = c["pros"].setdefault(ev["prod_order_no"], {"prod_order_no": ev["prod_order_no"], "units": 0.0, "hours": 0.0})
        pro["units"] += ev["delta"]
        pro["hours"] += hours

    work_hours = {st: {int(k): v for k, v in wk.items()} for st, wk in get_work_hours().items()}
    overrides = {(o["the_date"], o["stage"]): o["hours"] for o in get_day_overrides()}
    actual = get_actual_hours(date_from, date_to)

    rows = []
    for (the_date, stage), c in sorted(cells.items()):
        available = hours_available_on(the_date, stage, work_hours, overrides)
        typed = actual.get((the_date, stage))
        actual_hours = typed if typed is not None else available
        earned = round(c["earned_hours"], 2)
        planned = round(c["planned_hours"], 2)
        rows.append({
            **{k: c[k] for k in ("date", "stage", "line")},
            "label": _stage_label(stage),
            "planned_hours": planned,
            "earned_hours": earned,
            "actual_hours": round(actual_hours, 2),
            "available_hours": round(available, 2),
            "actual_is_default": typed is None,
            "units": round(c["units"], 2),
            "efficiency": round(earned / actual_hours * 100, 1) if actual_hours else None,
            "attainment": round(earned / planned * 100, 1) if planned else None,
            "pros": sorted(
                ({**v, "units": round(v["units"], 2), "hours": round(v["hours"], 2)} for v in c["pros"].values()),
                key=lambda x: -x["hours"],
            ),
        })

    earned_total = round(sum(r["earned_hours"] for r in rows), 2)
    planned_total = round(sum(r["planned_hours"] for r in rows), 2)
    actual_total = round(sum(r["actual_hours"] for r in rows), 2)
    return {
        "date_from": date_from,
        "date_to": date_to,
        "rows": rows,
        "totals": {
            "planned_hours": planned_total,
            "earned_hours": earned_total,
            "actual_hours": actual_total,
            "efficiency": round(earned_total / actual_total * 100, 1) if actual_total else None,
            "attainment": round(earned_total / planned_total * 100, 1) if planned_total else None,
        },
    }


class ActualHoursIn(BaseModel):
    the_date: str
    stage: str
    hours: float | None = None


@app.post("/api/efficiency/actual")
def api_set_actual_hours(request: Request, body: ActualHoursIn):
    require_admin(request, "record actual hours")
    if body.stage not in ALL_STAGES:
        raise HTTPException(status_code=400, detail=f"Unknown step '{body.stage}'.")
    if body.hours is not None and body.hours < 0:
        raise HTTPException(status_code=400, detail="Hours can't be negative.")
    set_actual_hours(body.the_date, body.stage, body.hours)
    write_audit(actor(request), "efficiency.actual",
                f"{body.the_date} {body.stage} -> {'cleared' if body.hours is None else body.hours}")
    return {"saved": True}


app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
