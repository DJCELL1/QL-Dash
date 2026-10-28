"""SQLite storage layer for Production Scheduler snapshots."""
import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path

# On a host, point DASHBOARD_DB at a persistent volume so the database survives
# redeploys — a container's own filesystem is wiped on every deploy.
DB_PATH = Path(
    os.environ.get("DASHBOARD_DB")
    or Path(__file__).resolve().parent.parent / "data" / "dashboard.db"
)

SCHEMA = """
CREATE TABLE IF NOT EXISTS snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dataset TEXT NOT NULL,
    snapshot_date TEXT NOT NULL,
    source_file TEXT NOT NULL,
    ingested_at TEXT NOT NULL,
    row_count INTEGER NOT NULL DEFAULT 0,
    UNIQUE(dataset, snapshot_date)
);

CREATE TABLE IF NOT EXISTS records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    snapshot_id INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
    dataset TEXT NOT NULL,
    line_key TEXT NOT NULL,
    work_centre_group TEXT,
    work_centre_no TEXT,
    work_centre_description TEXT,
    status TEXT,
    prod_order_no TEXT,
    sales_order_no TEXT,
    item_no TEXT,
    item_description TEXT,
    operation_no TEXT,
    current_operation_no TEXT,
    operation_due_date TEXT,
    shipment_date TEXT,
    starting_datetime TEXT,
    ending_datetime TEXT,
    location_code TEXT,
    responsibility_centre TEXT,
    source_no TEXT,
    source_name TEXT,
    urgent INTEGER DEFAULT 0,
    shortage INTEGER DEFAULT 0,
    potential_back_order INTEGER DEFAULT 0,
    potential_back_order_reason TEXT,
    potential_back_order_comment TEXT,
    comments TEXT,
    quantity REAL,
    uom TEXT,
    colour_code TEXT,
    colour_description TEXT,
    operation_remaining_qty REAL,
    operation_finished_qty REAL,
    operation_pct_finished REAL,
    order_finished_qty REAL,
    order_remaining_qty REAL,
    order_pct_finished REAL,
    square_metres REAL,
    remaining_square_metres REAL,
    linear_metres REAL,
    remaining_linear_metres REAL,
    required_capacity_minutes REAL,
    expected_capacity_need_minutes REAL,
    stillage_location_code TEXT,
    powder_rating TEXT,
    stove_time TEXT,
    locked INTEGER DEFAULT 0,
    sequence INTEGER,
    raw_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_records_snapshot ON records(snapshot_id);
CREATE INDEX IF NOT EXISTS idx_records_dataset ON records(dataset);
CREATE INDEX IF NOT EXISTS idx_records_line_key ON records(line_key);
CREATE INDEX IF NOT EXISTS idx_records_work_centre ON records(work_centre_no);
-- looking a posted job up by name walks every snapshot ever taken without this
CREATE INDEX IF NOT EXISTS idx_records_pro ON records(dataset, prod_order_no);

CREATE TABLE IF NOT EXISTS processed_files (
    path TEXT PRIMARY KEY,
    mtime REAL NOT NULL,
    size INTEGER NOT NULL,
    dataset TEXT,
    snapshot_date TEXT,
    processed_at TEXT NOT NULL,
    status TEXT NOT NULL,
    error TEXT
);

-- Every change to a step's progress, append-only. stage_progress stays the
-- single source of truth for how much is done; this says when it happened and
-- who did it, which is what Efficiency earns hours from and what gives each
-- unit on the tracker a time.
CREATE TABLE IF NOT EXISTS progress_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prod_order_no TEXT NOT NULL,
    stage TEXT NOT NULL,
    from_qty REAL NOT NULL,
    to_qty REAL NOT NULL,
    delta REAL NOT NULL,
    at TEXT NOT NULL,
    by_user TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_progress_events_at ON progress_events (at);
CREATE INDEX IF NOT EXISTS idx_progress_events_pro ON progress_events (prod_order_no, stage, id);

-- Hours actually worked at a step on a day, typed in on the Efficiency tab.
-- Absent means nobody has said, and the hours available stand in.
-- Warehouse movement numbers entered here, rather than read out of BC's
-- Comments column. One per sales order, and it wins over whatever the export
-- happened to say.
CREATE TABLE IF NOT EXISTS sales_order_wm (
    sales_order_no TEXT PRIMARY KEY,
    wm_number TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    set_by TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS actual_hours (
    the_date TEXT NOT NULL,
    stage TEXT NOT NULL,
    hours REAL NOT NULL,
    updated_at TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (the_date, stage)
);

CREATE TABLE IF NOT EXISTS work_hours (
    stage TEXT NOT NULL,
    weekday INTEGER NOT NULL,          -- 0 = Monday ... 6 = Sunday
    hours REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (stage, weekday)
);

-- Overtime, shutdowns and public holidays: whatever the weekday would normally
-- give, this wins for that date. stage '' means every step on that line.
CREATE TABLE IF NOT EXISTS day_overrides (
    the_date TEXT NOT NULL,
    stage TEXT NOT NULL DEFAULT '',
    hours REAL NOT NULL DEFAULT 0,
    note TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (the_date, stage)
);

-- Minutes per unit at a step, for a product group. The group '__default__' is
-- the catch-all; a product row beats it, and BC's own estimate is the last
-- resort. Rows are kept when a product drops out of the exports.
CREATE TABLE IF NOT EXISTS product_minutes (
    product_group TEXT NOT NULL,
    stage TEXT NOT NULL,
    minutes REAL NOT NULL,
    updated_at TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (product_group, stage)
);

CREATE TABLE IF NOT EXISTS stage_progress (
    prod_order_no TEXT PRIMARY KEY,
    picking_done REAL NOT NULL DEFAULT 0,
    machining_done REAL NOT NULL DEFAULT 0,
    build_wrap_done REAL NOT NULL DEFAULT 0,
    -- The earlier five-stage Queensland line, merged into the three above.
    cut_to_size_done REAL NOT NULL DEFAULT 0,
    components_done REAL NOT NULL DEFAULT 0,
    build_done REAL NOT NULL DEFAULT 0,
    wrap_done REAL NOT NULL DEFAULT 0,
    -- The WA door line's stages. Queensland doesn't run them, but the columns
    -- stay so a database carrying that history keeps it.
    make_done REAL NOT NULL DEFAULT 0,
    press_done REAL NOT NULL DEFAULT 0,
    cnc_done REAL NOT NULL DEFAULT 0,
    glazing_done REAL NOT NULL DEFAULT 0,
    edge_strip_done REAL NOT NULL DEFAULT 0,
    finish_done REAL NOT NULL DEFAULT 0,
    cav_prep_done REAL NOT NULL DEFAULT 0,
    cav_make_done REAL NOT NULL DEFAULT 0,
    pc_prep_done REAL NOT NULL DEFAULT 0,
    pc_coat_done REAL NOT NULL DEFAULT 0,
    pc_pack_done REAL NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schedule_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prod_order_no TEXT NOT NULL,
    stage TEXT NOT NULL,
    scheduled_date TEXT NOT NULL,
    qty REAL NOT NULL,
    sequence INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_schedule_pro ON schedule_entries(prod_order_no);
CREATE INDEX IF NOT EXISTS idx_schedule_date ON schedule_entries(scheduled_date);

-- What the morning meeting committed to for a day. Written once, when the day
-- is locked, and never followed afterwards: the board goes on changing, and the
-- gap between this and the board at the end of the day is the whole point.
CREATE TABLE IF NOT EXISTS day_locks (
    scheduled_date TEXT PRIMARY KEY,
    locked_at TEXT NOT NULL,
    locked_by TEXT
);

-- The running order of a day's work, per department. Keyed by sales order
-- rather than by schedule entry on purpose: an order is ranked as one thing,
-- and most Press and CNC cards have no entry of their own to hang a number on
-- — they follow a dated Make.
CREATE TABLE IF NOT EXISTS day_priorities (
    scheduled_date TEXT NOT NULL,
    section TEXT NOT NULL,
    sales_order_no TEXT NOT NULL,
    priority INTEGER NOT NULL,
    PRIMARY KEY (scheduled_date, section, sales_order_no)
);

CREATE TABLE IF NOT EXISTS day_plan_lines (
    scheduled_date TEXT NOT NULL,
    stage TEXT NOT NULL,
    prod_order_no TEXT NOT NULL,
    qty REAL NOT NULL,
    PRIMARY KEY (scheduled_date, stage, prod_order_no)
);

CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    user TEXT,
    action TEXT NOT NULL,
    detail TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at);

CREATE TABLE IF NOT EXISTS purchase_orders (
    po_no TEXT PRIMARY KEY,
    vendor_no TEXT,
    vendor_name TEXT,
    completely_received INTEGER DEFAULT 0,
    external_doc_no TEXT,
    expected_receipt_date TEXT,
    order_date TEXT,
    receipt_date_confirmed INTEGER DEFAULT 0,
    status TEXT,
    location_code TEXT,
    total_excl_gst REAL,
    total_incl_gst REAL,
    created_by TEXT,
    snapshot_date TEXT,
    ingested_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_po_vendor ON purchase_orders(vendor_no);

CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY,
    salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
);

-- small key/value store; currently just the session-signing secret, kept here
-- so sessions survive a restart even when no secret is set in the environment
CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- The architect's door marks (D-104), which BC's export doesn't carry at all:
-- a production order of nine doors is one row with a quantity, and nothing in
-- it says which door is which. An admin types them in once and they stay.
--
-- One row per job, marks newline-separated in door order. A row with
-- has_numbers = 0 is a job someone has said has no marks — that's what stops
-- it being asked about again, so the absence of a row means "not yet asked".
CREATE TABLE IF NOT EXISTS door_numbers (
    prod_order_no TEXT PRIMARY KEY,
    has_numbers INTEGER NOT NULL,
    marks TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    updated_by TEXT
);

-- What the customer calls the job -- "WACA - TIMBER DOORS STAGE 1" -- which
-- BC keeps as the sales order's External Document No. and the Production
-- Scheduler export doesn't carry. Pasted in from the Sales Orders list.
CREATE TABLE IF NOT EXISTS sales_orders (
    sales_order_no TEXT PRIMARY KEY,
    job_name TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by TEXT
);

CREATE TABLE IF NOT EXISTS sub_job_status (
    prod_order_no TEXT NOT NULL,
    work_centre_no TEXT NOT NULL,
    status TEXT,
    eta_date TEXT,
    priority INTEGER NOT NULL DEFAULT 2,
    note TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (prod_order_no, work_centre_no)
);
"""

STAGE_COLUMNS = {
    # The Queensland aluminium door line, in shop order.
    "picking": "picking_done",
    "machining": "machining_done",
    "build_wrap": "build_wrap_done",
    # Its earlier five stages, kept so progress recorded under them reads back.
    "cut_to_size": "cut_to_size_done",
    "components": "components_done",
    "build": "build_done",
    "wrap": "wrap_done",
    # WA's door line, kept so its recorded progress still reads back.
    "make": "make_done",
    "press": "press_done",
    "cnc": "cnc_done",
    "glazing": "glazing_done",
    "edge_strip": "edge_strip_done",
    "finish": "finish_done",
    # Cavities are a separate in-house line with two steps of their own.
    "cav_prep": "cav_prep_done",
    "cav_make": "cav_make_done",
    # Powdercoating is a third in-house line, three steps.
    "pc_prep": "pc_prep_done",
    "pc_coat": "pc_coat_done",
    "pc_pack": "pc_pack_done",
}


def init_db() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with get_conn() as conn:
        conn.executescript(SCHEMA)
        _add_missing_columns(conn)


def _add_missing_columns(conn) -> None:
    """Bring an existing database up to the current schema.

    CREATE TABLE IF NOT EXISTS leaves a table that already exists untouched, so
    a database created before glazing and edge stripping existed keeps its old
    four columns and every write to a new stage fails. Adding them here is safe
    to run on every start: the check is what the table actually has, and the
    default backfills existing rows with zero rather than disturbing them.
    """
    # Accounts were all equal until door numbers needed an owner.
    if "is_admin" not in {r[1] for r in conn.execute("PRAGMA table_info(users)")}:
        conn.execute("ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0")

    have = {r[1] for r in conn.execute("PRAGMA table_info(stage_progress)")}
    added = []
    for column in ("glazing_done", "edge_strip_done", "cav_prep_done", "cav_make_done",
                   "cut_to_size_done", "machining_done", "components_done",
                   "build_done", "wrap_done",
                   "pc_prep_done", "pc_coat_done", "pc_pack_done",
                   "picking_done", "build_wrap_done"):
        if column not in have:
            conn.execute(f"ALTER TABLE stage_progress ADD COLUMN {column} REAL NOT NULL DEFAULT 0")
            added.append(column)

    # Cavities were briefly a single step called cavity_done before the line was
    # split into Prep and Make. Carry anything recorded then into Prep rather
    # than stranding it in a column nothing reads.
    if "cav_prep_done" in added and "cavity_done" in have:
        conn.execute("UPDATE stage_progress SET cav_prep_done = cavity_done WHERE cavity_done > 0")

    # The door line went from five stages to three. The new columns appearing is
    # the one moment to carry the old stages' history across.
    if "picking_done" in added:
        _merge_door_stages(conn)


def _merge_door_stages(conn) -> None:
    """Fold the five-stage door line into Picking, Machining and Build/Wrap.

    Cut to size becomes Picking. Components, Build and Wrap become Build/Wrap:
    a door counts as through it once it was wrapped, it is booked on the day
    Build was, and its minutes and actual hours are the three added together.
    Ticks already logged under Build and Components stay as they were, since
    re-labelling them would count the same door's time two or three times.
    """
    conn.execute("UPDATE stage_progress SET picking_done = cut_to_size_done, build_wrap_done = wrap_done")
    for table, key, value in (("product_minutes", "product_group", "minutes"),
                              ("actual_hours", "the_date", "hours")):
        conn.execute(
            f"INSERT OR REPLACE INTO {table} ({key}, stage, {value}, updated_at) "
            f"SELECT {key}, 'build_wrap', SUM({value}), MAX(updated_at) FROM {table} "
            "WHERE stage IN ('components', 'build', 'wrap') GROUP BY {key}".replace("{key}", key)
        )
    for table in ("product_minutes", "actual_hours", "work_hours", "day_overrides",
                  "schedule_entries", "day_plan_lines"):
        conn.execute(f"UPDATE OR IGNORE {table} SET stage = 'picking' WHERE stage = 'cut_to_size'")
        conn.execute(f"UPDATE OR IGNORE {table} SET stage = 'build_wrap' WHERE stage = 'build'")
        conn.execute(f"DELETE FROM {table} WHERE stage IN ('cut_to_size', 'components', 'build', 'wrap')")
    conn.execute("UPDATE progress_events SET stage = 'picking' WHERE stage = 'cut_to_size'")
    conn.execute("UPDATE progress_events SET stage = 'build_wrap' WHERE stage = 'wrap'")


@contextmanager
def get_conn():
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.execute("PRAGMA foreign_keys = ON")
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


# Enough to recognise a dashboard database, not a schema version: a backup from
# before a table existed still restores, and init_db() adds what's missing.
EXPECTED_TABLES = {
    "snapshots", "records", "processed_files", "stage_progress",
    "schedule_entries", "audit_log", "purchase_orders", "sub_job_status",
}


def backup_to(dest: Path) -> Path:
    """Consistent copy of the live database.

    Uses SQLite's own backup API rather than copying the file — a plain copy of a
    database being written to can land mid-transaction and come out corrupt.
    """
    dest.parent.mkdir(parents=True, exist_ok=True)
    src = sqlite3.connect(DB_PATH, timeout=30)
    out = sqlite3.connect(dest)
    try:
        src.backup(out)
    finally:
        out.close()
        src.close()
    return dest


def validate_db_file(path: Path) -> None:
    """Raise ValueError unless `path` is a SQLite file holding this app's schema."""
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=10)
    try:
        found = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    except sqlite3.DatabaseError as exc:
        raise ValueError(f"Not a readable SQLite database: {exc}") from exc
    finally:
        conn.close()
    missing = EXPECTED_TABLES - found
    if missing:
        raise ValueError(f"Not a dashboard database — missing tables: {', '.join(sorted(missing))}")


def restore_from(src: Path) -> None:
    """Replace the live database with `src`, keeping the previous file alongside.

    Destructive, so the caller validates first and the old database is kept as
    `<name>.pre-restore` in case the new one turns out to be the wrong export.
    """
    validate_db_file(src)
    if DB_PATH.exists():
        DB_PATH.replace(DB_PATH.with_suffix(DB_PATH.suffix + ".pre-restore"))
    # Read through SQLite rather than moving the file so WAL/journal side files
    # from the uploaded copy can't be left pointing at the wrong database.
    incoming = sqlite3.connect(f"file:{src}?mode=ro", uri=True, timeout=30)
    out = sqlite3.connect(DB_PATH)
    try:
        incoming.backup(out)
    finally:
        out.close()
        incoming.close()


RECORD_COLUMNS = [
    "dataset", "line_key", "work_centre_group", "work_centre_no", "work_centre_description", "status",
    "prod_order_no", "sales_order_no", "item_no", "item_description",
    "operation_no", "current_operation_no", "operation_due_date", "shipment_date",
    "starting_datetime", "ending_datetime", "location_code", "responsibility_centre",
    "source_no", "source_name", "urgent", "shortage", "potential_back_order",
    "potential_back_order_reason", "potential_back_order_comment", "comments",
    "quantity", "uom", "colour_code", "colour_description",
    "operation_remaining_qty", "operation_finished_qty", "operation_pct_finished",
    "order_finished_qty", "order_remaining_qty", "order_pct_finished",
    "square_metres", "remaining_square_metres", "linear_metres", "remaining_linear_metres",
    "required_capacity_minutes", "expected_capacity_need_minutes",
    "stillage_location_code", "powder_rating", "stove_time", "locked", "sequence",
]

# raw_json used to hold a verbatim copy of every source row. Nothing ever read
# it: it was half the database — 15 MB of 28 — and 1.2 MB of it was fetched and
# thrown away on every request that touched a snapshot. The column stays so old
# backups still restore; it is simply no longer written or read.
RECORD_SELECT = ", ".join(("id", "snapshot_id", *RECORD_COLUMNS))


def upsert_snapshot(dataset: str, snapshot_date: str, source_file: str, rows: list[dict]) -> int:
    """Replace any existing snapshot for (dataset, snapshot_date) with the new rows."""
    from datetime import datetime, timezone

    with get_conn() as conn:
        cur = conn.execute(
            "SELECT id FROM snapshots WHERE dataset = ? AND snapshot_date = ?",
            (dataset, snapshot_date),
        )
        existing = cur.fetchone()
        ingested_at = datetime.now(timezone.utc).isoformat()

        if existing:
            snapshot_id = existing["id"]
            conn.execute("DELETE FROM records WHERE snapshot_id = ?", (snapshot_id,))
            conn.execute(
                "UPDATE snapshots SET source_file = ?, ingested_at = ?, row_count = ? WHERE id = ?",
                (source_file, ingested_at, len(rows), snapshot_id),
            )
        else:
            cur = conn.execute(
                "INSERT INTO snapshots (dataset, snapshot_date, source_file, ingested_at, row_count) "
                "VALUES (?, ?, ?, ?, ?)",
                (dataset, snapshot_date, source_file, ingested_at, len(rows)),
            )
            snapshot_id = cur.lastrowid

        placeholders = ", ".join("?" for _ in RECORD_COLUMNS)
        col_names = ", ".join(RECORD_COLUMNS)
        conn.executemany(
            f"INSERT INTO records (snapshot_id, {col_names}) VALUES (?, {placeholders})",
            [
                (snapshot_id, *(row.get(c) for c in RECORD_COLUMNS))
                for row in rows
            ],
        )
        return snapshot_id


def mark_file_processed(path: str, mtime: float, size: int, dataset: str | None,
                         snapshot_date: str | None, status: str, error: str | None = None) -> None:
    from datetime import datetime, timezone

    with get_conn() as conn:
        conn.execute(
            "INSERT INTO processed_files (path, mtime, size, dataset, snapshot_date, processed_at, status, error) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(path) DO UPDATE SET mtime=excluded.mtime, size=excluded.size, "
            "dataset=excluded.dataset, snapshot_date=excluded.snapshot_date, "
            "processed_at=excluded.processed_at, status=excluded.status, error=excluded.error",
            (path, mtime, size, dataset, snapshot_date, datetime.now(timezone.utc).isoformat(), status, error),
        )


def get_processed_file(path: str) -> sqlite3.Row | None:
    with get_conn() as conn:
        cur = conn.execute("SELECT * FROM processed_files WHERE path = ?", (path,))
        return cur.fetchone()


def latest_snapshot(dataset: str) -> sqlite3.Row | None:
    with get_conn() as conn:
        cur = conn.execute(
            "SELECT * FROM snapshots WHERE dataset = ? ORDER BY snapshot_date DESC LIMIT 1",
            (dataset,),
        )
        return cur.fetchone()


def get_records_for_snapshot(snapshot_id: int) -> list[dict]:
    with get_conn() as conn:
        cur = conn.execute(
            f"SELECT {RECORD_SELECT} FROM records WHERE snapshot_id = ?", (snapshot_id,)
        )
        return [dict(r) for r in cur.fetchall()]


def pros_with_dated_schedule() -> set[str]:
    """PROs someone has actually planned onto a day.

    Holding is deliberately excluded: it's a queue of work still to do, and a
    job that has been posted has nothing left to do. Keeping posted jobs there
    would grow a backlog that can never be worked down.
    """
    with get_conn() as conn:
        cur = conn.execute(
            "SELECT DISTINCT prod_order_no FROM schedule_entries WHERE scheduled_date <> 'holding'"
        )
        return {row["prod_order_no"] for row in cur.fetchall()}


def records_last_seen(dataset: str, prod_order_nos) -> list[dict]:
    """Each named PRO's rows from the most recent snapshot it appeared in.

    For jobs that have dropped out of the current export — posted in BC — this
    is where their customer, item and quantity still live.
    """
    pros = list(prod_order_nos)
    if not pros:
        return []
    out: list[dict] = []
    with get_conn() as conn:
        # chunked to stay under SQLite's variable limit on a long backlog
        for i in range(0, len(pros), 400):
            chunk = pros[i:i + 400]
            marks = ",".join("?" * len(chunk))
            cur = conn.execute(
                f"SELECT {RECORD_SELECT} FROM records r "
                f"WHERE r.dataset = ? AND r.prod_order_no IN ({marks}) "
                f"AND r.snapshot_id = (SELECT MAX(r2.snapshot_id) FROM records r2 "
                f"  WHERE r2.dataset = r.dataset AND r2.prod_order_no = r.prod_order_no)",
                (dataset, *chunk),
            )
            out.extend(dict(r) for r in cur.fetchall())
    return out


def all_snapshots() -> list[dict]:
    with get_conn() as conn:
        cur = conn.execute("SELECT * FROM snapshots ORDER BY dataset, snapshot_date")
        return [dict(r) for r in cur.fetchall()]


def first_seen_dates(dataset: str) -> dict[str, str]:
    """Earliest snapshot_date each line_key has appeared in, across all history."""
    with get_conn() as conn:
        cur = conn.execute(
            "SELECT r.line_key, MIN(s.snapshot_date) AS first_date "
            "FROM records r JOIN snapshots s ON r.snapshot_id = s.id "
            "WHERE r.dataset = ? GROUP BY r.line_key",
            (dataset,),
        )
        return {row["line_key"]: row["first_date"] for row in cur.fetchall()}


def get_all_stage_progress() -> dict[str, dict]:
    with get_conn() as conn:
        cur = conn.execute("SELECT * FROM stage_progress")
        return {row["prod_order_no"]: dict(row) for row in cur.fetchall()}


def get_stage_progress(prod_order_no: str) -> sqlite3.Row | None:
    with get_conn() as conn:
        cur = conn.execute("SELECT * FROM stage_progress WHERE prod_order_no = ?", (prod_order_no,))
        return cur.fetchone()


def set_stage_progress(prod_order_no: str, stage: str, done_qty: float, by_user: str = "") -> dict:
    from datetime import datetime, timezone

    if stage not in STAGE_COLUMNS:
        raise ValueError(f"Unknown stage '{stage}'")
    column = STAGE_COLUMNS[stage]
    now = datetime.now(timezone.utc).isoformat()

    with get_conn() as conn:
        # What it was, so the event carries the movement rather than just the
        # new total — a day earns the hours for what was done that day.
        prior = conn.execute(
            f"SELECT {column} AS was FROM stage_progress WHERE prod_order_no = ?", (prod_order_no,)
        ).fetchone()
        was = (prior["was"] if prior else 0) or 0
        if done_qty != was:
            conn.execute(
                "INSERT INTO progress_events (prod_order_no, stage, from_qty, to_qty, delta, at, by_user) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (prod_order_no, stage, was, done_qty, done_qty - was, now, by_user),
            )
        conn.execute(
            f"INSERT INTO stage_progress (prod_order_no, {column}, updated_at) VALUES (?, ?, ?) "
            f"ON CONFLICT(prod_order_no) DO UPDATE SET {column} = excluded.{column}, updated_at = excluded.updated_at",
            (prod_order_no, done_qty, now),
        )
        cur = conn.execute("SELECT * FROM stage_progress WHERE prod_order_no = ?", (prod_order_no,))
        return dict(cur.fetchone())


def get_progress_events(date_from: str | None = None, date_to: str | None = None,
                        prod_order_no: str | None = None) -> list[dict]:
    """Movements in a date range, oldest first. Dates are YYYY-MM-DD, inclusive."""
    where, args = [], []
    if date_from:
        where.append("at >= ?")
        args.append(date_from)
    if date_to:
        where.append("at < ?")
        args.append(date_to + "T99")  # anything that day, whatever the time
    if prod_order_no:
        where.append("prod_order_no = ?")
        args.append(prod_order_no)
    sql = "SELECT * FROM progress_events"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY id"
    with get_conn() as conn:
        return [dict(r) for r in conn.execute(sql, args).fetchall()]


def get_day_plans() -> dict[str, dict]:
    """Every locked day, with the lines it was locked with."""
    with get_conn() as conn:
        plans = {
            r["scheduled_date"]: {
                "date": r["scheduled_date"],
                "locked_at": r["locked_at"],
                "locked_by": r["locked_by"],
                "lines": [],
            }
            for r in conn.execute("SELECT * FROM day_locks").fetchall()
        }
        for r in conn.execute("SELECT * FROM day_plan_lines").fetchall():
            plan = plans.get(r["scheduled_date"])
            if plan is not None:
                plan["lines"].append(
                    {"stage": r["stage"], "prod_order_no": r["prod_order_no"], "qty": r["qty"]}
                )
    return plans


def get_day_priorities() -> dict[str, int]:
    """Every ranked order, keyed "date|section|SO" so the board can look one up
    without walking a list per card."""
    with get_conn() as conn:
        return {
            f"{r['scheduled_date']}|{r['section']}|{r['sales_order_no']}": r["priority"]
            for r in conn.execute("SELECT * FROM day_priorities").fetchall()
        }


def set_day_priorities(scheduled_date: str, section: str, order: list[str]) -> int:
    """Renumber one department's day, top to bottom.

    The whole cell is rewritten rather than the moved order alone: positions
    are only meaningful relative to each other, and patching one row would
    leave the rest holding numbers from a previous arrangement.
    """
    with get_conn() as conn:
        conn.execute(
            "DELETE FROM day_priorities WHERE scheduled_date = ? AND section = ?",
            (scheduled_date, section),
        )
        conn.executemany(
            "INSERT INTO day_priorities (scheduled_date, section, sales_order_no, priority) "
            "VALUES (?, ?, ?, ?)",
            [(scheduled_date, section, so, i + 1) for i, so in enumerate(order)],
        )
    return len(order)


def lock_day(scheduled_date: str, lines: list[dict], locked_by: str | None) -> dict:
    """Record what a day was committed to. Re-locking replaces the old plan."""
    from datetime import datetime, timezone

    now = datetime.now(timezone.utc).isoformat()
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO day_locks (scheduled_date, locked_at, locked_by) VALUES (?, ?, ?) "
            "ON CONFLICT(scheduled_date) DO UPDATE SET locked_at = excluded.locked_at, "
            "locked_by = excluded.locked_by",
            (scheduled_date, now, locked_by),
        )
        conn.execute("DELETE FROM day_plan_lines WHERE scheduled_date = ?", (scheduled_date,))
        conn.executemany(
            "INSERT INTO day_plan_lines (scheduled_date, stage, prod_order_no, qty) VALUES (?, ?, ?, ?)",
            [(scheduled_date, ln["stage"], ln["prod_order_no"], ln["qty"]) for ln in lines],
        )
    return {"date": scheduled_date, "locked_at": now, "locked_by": locked_by, "lines": lines}


def unlock_day(scheduled_date: str) -> bool:
    with get_conn() as conn:
        conn.execute("DELETE FROM day_plan_lines WHERE scheduled_date = ?", (scheduled_date,))
        cur = conn.execute("DELETE FROM day_locks WHERE scheduled_date = ?", (scheduled_date,))
        return cur.rowcount > 0


def history_counts(dataset: str) -> list[dict]:
    """Order counts and key flag totals per snapshot date, for trend charts.

    Counts distinct production orders, not raw rows. BC repeats a PRO once per
    routing operation, so summing rows would plot five doors where there is one
    and would disagree with the order table on the same screen.
    """
    with get_conn() as conn:
        cur = conn.execute(
            "SELECT s.snapshot_date, "
            "COUNT(DISTINCT r.prod_order_no) AS row_count, "
            "COUNT(DISTINCT CASE WHEN r.urgent THEN r.prod_order_no END) AS urgent_count, "
            "COUNT(DISTINCT CASE WHEN r.shortage THEN r.prod_order_no END) AS shortage_count, "
            "COUNT(DISTINCT CASE WHEN r.potential_back_order THEN r.prod_order_no END) AS back_order_count "
            "FROM snapshots s LEFT JOIN records r ON r.snapshot_id = s.id "
            "WHERE s.dataset = ? GROUP BY s.id ORDER BY s.snapshot_date",
            (dataset,),
        )
        return [dict(r) for r in cur.fetchall()]


def get_all_schedule_entries() -> list[dict]:
    with get_conn() as conn:
        cur = conn.execute("SELECT * FROM schedule_entries ORDER BY scheduled_date, stage, sequence, id")
        return [dict(r) for r in cur.fetchall()]


def get_schedule_entry(entry_id: int) -> dict | None:
    with get_conn() as conn:
        cur = conn.execute("SELECT * FROM schedule_entries WHERE id = ?", (entry_id,))
        row = cur.fetchone()
        return dict(row) if row else None


def sum_scheduled_qty(prod_order_no: str, stage: str, exclude_entry_id: int | None = None) -> float:
    with get_conn() as conn:
        if exclude_entry_id is not None:
            cur = conn.execute(
                "SELECT COALESCE(SUM(qty), 0) AS total FROM schedule_entries "
                "WHERE prod_order_no = ? AND stage = ? AND id != ?",
                (prod_order_no, stage, exclude_entry_id),
            )
        else:
            cur = conn.execute(
                "SELECT COALESCE(SUM(qty), 0) AS total FROM schedule_entries WHERE prod_order_no = ? AND stage = ?",
                (prod_order_no, stage),
            )
        return cur.fetchone()["total"] or 0.0


def create_schedule_entry(prod_order_no: str, stage: str, date: str, qty: float, sequence: int = 0) -> dict:
    from datetime import datetime, timezone

    now = datetime.now(timezone.utc).isoformat()
    with get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO schedule_entries (prod_order_no, stage, scheduled_date, qty, sequence, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (prod_order_no, stage, date, qty, sequence, now, now),
        )
        row = conn.execute("SELECT * FROM schedule_entries WHERE id = ?", (cur.lastrowid,)).fetchone()
        return dict(row)


class OverBooked(Exception):
    """Raised when a create would schedule more than the job has left."""

    def __init__(self, available: float):
        self.available = available
        super().__init__(f"Only {available} left to schedule")


def create_schedule_entry_checked(
    prod_order_no: str, stage: str, date: str, qty: float, capacity: float, sequence: int = 0
) -> dict:
    """Check remaining capacity and insert in one transaction.

    Doing the check on one connection and the insert on another let two requests
    arriving together both pass the check before either wrote, double-booking the
    job. BEGIN IMMEDIATE takes the write lock up front so they serialise.
    """
    from datetime import datetime, timezone

    now = datetime.now(timezone.utc).isoformat()
    conn = sqlite3.connect(DB_PATH, timeout=30, isolation_level=None)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("BEGIN IMMEDIATE")
        booked = conn.execute(
            "SELECT COALESCE(SUM(qty), 0) AS t FROM schedule_entries WHERE prod_order_no = ? AND stage = ?",
            (prod_order_no, stage),
        ).fetchone()["t"] or 0.0
        available = max(0.0, capacity - booked)
        if qty > available + 1e-9:
            conn.execute("ROLLBACK")
            raise OverBooked(available)

        cur = conn.execute(
            "INSERT INTO schedule_entries (prod_order_no, stage, scheduled_date, qty, sequence, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (prod_order_no, stage, date, qty, sequence, now, now),
        )
        row = conn.execute("SELECT * FROM schedule_entries WHERE id = ?", (cur.lastrowid,)).fetchone()
        conn.execute("COMMIT")
        return dict(row)
    finally:
        conn.close()


def join_schedule_entries(entry_id: int) -> dict | None:
    """Pull every chunk of one PRO's stage back into this one — the way back
    from a split.

    The whole thing happens in one transaction. Summing and deleting as
    separate steps would let a failure in between leave the job with its other
    chunks gone and this one still holding its old quantity, which is doors
    quietly disappearing off the schedule.
    """
    from datetime import datetime, timezone

    now = datetime.now(timezone.utc).isoformat()
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM schedule_entries WHERE id = ?", (entry_id,)).fetchone()
        if row is None:
            return None

        siblings = conn.execute(
            "SELECT id, qty FROM schedule_entries WHERE prod_order_no = ? AND stage = ?",
            (row["prod_order_no"], row["stage"]),
        ).fetchall()
        total = sum(s["qty"] or 0 for s in siblings)

        conn.execute(
            "DELETE FROM schedule_entries WHERE prod_order_no = ? AND stage = ? AND id <> ?",
            (row["prod_order_no"], row["stage"], entry_id),
        )
        conn.execute(
            "UPDATE schedule_entries SET qty = ?, updated_at = ? WHERE id = ?", (total, now, entry_id)
        )
        merged = dict(conn.execute("SELECT * FROM schedule_entries WHERE id = ?", (entry_id,)).fetchone())
        merged["chunks_joined"] = len(siblings)
        return merged


def update_schedule_entry(entry_id: int, date: str | None = None, qty: float | None = None) -> dict | None:
    from datetime import datetime, timezone

    now = datetime.now(timezone.utc).isoformat()
    with get_conn() as conn:
        existing = conn.execute("SELECT * FROM schedule_entries WHERE id = ?", (entry_id,)).fetchone()
        if not existing:
            return None
        new_date = date if date is not None else existing["scheduled_date"]
        new_qty = qty if qty is not None else existing["qty"]
        conn.execute(
            "UPDATE schedule_entries SET scheduled_date = ?, qty = ?, updated_at = ? WHERE id = ?",
            (new_date, new_qty, now, entry_id),
        )
        row = conn.execute("SELECT * FROM schedule_entries WHERE id = ?", (entry_id,)).fetchone()
        return dict(row)


def unallocate_dates(dates: list[str]) -> int:
    """Send every entry scheduled on these dates back to Holding."""
    from datetime import datetime, timezone

    if not dates:
        return 0
    now = datetime.now(timezone.utc).isoformat()
    placeholders = ", ".join("?" for _ in dates)
    with get_conn() as conn:
        cur = conn.execute(
            f"UPDATE schedule_entries SET scheduled_date = 'holding', updated_at = ? "
            f"WHERE scheduled_date IN ({placeholders})",
            (now, *dates),
        )
        return cur.rowcount


def unallocate_pros(prod_order_nos: list[str]) -> int:
    """Send every dated entry for these jobs back to Holding."""
    from datetime import datetime, timezone

    if not prod_order_nos:
        return 0
    now = datetime.now(timezone.utc).isoformat()
    placeholders = ", ".join("?" for _ in prod_order_nos)
    with get_conn() as conn:
        cur = conn.execute(
            f"UPDATE schedule_entries SET scheduled_date = 'holding', updated_at = ? "
            f"WHERE prod_order_no IN ({placeholders}) AND scheduled_date != 'holding'",
            (now, *prod_order_nos),
        )
        return cur.rowcount


def delete_schedule_entry(entry_id: int) -> bool:
    with get_conn() as conn:
        cur = conn.execute("DELETE FROM schedule_entries WHERE id = ?", (entry_id,))
        return cur.rowcount > 0


PO_COLUMNS = [
    "po_no", "vendor_no", "vendor_name", "completely_received", "external_doc_no",
    "expected_receipt_date", "order_date", "receipt_date_confirmed", "status",
    "location_code", "total_excl_gst", "total_incl_gst", "created_by", "snapshot_date",
]


def replace_purchase_orders(rows: list[dict], snapshot_date: str) -> int:
    """Purchase orders are a full-refresh snapshot — each export replaces the lot.

    Files are scanned in name order, so an older export can be processed after a
    newer one; ignore anything staler than what we already hold rather than
    letting it overwrite good data. Same-day re-drops still apply.
    """
    from datetime import datetime, timezone

    now = datetime.now(timezone.utc).isoformat()
    cols = ", ".join(PO_COLUMNS)
    placeholders = ", ".join("?" for _ in PO_COLUMNS)

    with get_conn() as conn:
        current = conn.execute("SELECT MAX(snapshot_date) d FROM purchase_orders").fetchone()["d"]
        if current and snapshot_date < current:
            return 0

        conn.execute("DELETE FROM purchase_orders")
        conn.executemany(
            f"INSERT OR REPLACE INTO purchase_orders ({cols}, ingested_at) VALUES ({placeholders}, ?)",
            [(*(r.get(c) for c in PO_COLUMNS), now) for r in rows],
        )
        return len(rows)


def write_audit(user: str | None, action: str, detail: str | None = None) -> None:
    from datetime import datetime, timezone

    with get_conn() as conn:
        conn.execute(
            "INSERT INTO audit_log (at, user, action, detail) VALUES (?, ?, ?, ?)",
            (datetime.now(timezone.utc).isoformat(), user or "unknown", action, detail),
        )


def recent_audit(limit: int = 200) -> list[dict]:
    with get_conn() as conn:
        cur = conn.execute("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?", (limit,))
        return [dict(r) for r in cur.fetchall()]


def get_all_purchase_orders() -> dict[str, dict]:
    with get_conn() as conn:
        cur = conn.execute("SELECT * FROM purchase_orders")
        return {r["po_no"]: dict(r) for r in cur.fetchall()}


def reset_stage_progress(prod_order_nos: list[str]) -> int:
    """Clear recorded make/press/cnc/finish quantities for these jobs.

    Removing the row rather than zeroing it keeps the table to jobs that have
    actually been worked — everything falls back to 0 when there's no row.
    """
    if not prod_order_nos:
        return 0
    placeholders = ", ".join("?" for _ in prod_order_nos)
    with get_conn() as conn:
        cur = conn.execute(
            f"DELETE FROM stage_progress WHERE prod_order_no IN ({placeholders})", prod_order_nos
        )
        return cur.rowcount


def get_all_sub_status() -> dict[tuple[str, str], dict]:
    with get_conn() as conn:
        cur = conn.execute("SELECT * FROM sub_job_status")
        return {(r["prod_order_no"], r["work_centre_no"]): dict(r) for r in cur.fetchall()}


def set_sub_status(prod_order_no: str, work_centre_no: str, **fields) -> dict:
    """Upsert one subcontractor job's status/eta/priority/note. Only the fields
    passed in are written; anything omitted keeps its stored value."""
    from datetime import datetime, timezone

    allowed = ("status", "eta_date", "priority", "note")
    updates = {k: v for k, v in fields.items() if k in allowed}
    now = datetime.now(timezone.utc).isoformat()

    with get_conn() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO sub_job_status (prod_order_no, work_centre_no, updated_at) VALUES (?, ?, ?)",
            (prod_order_no, work_centre_no, now),
        )
        if updates:
            sets = ", ".join(f"{k} = ?" for k in updates)
            conn.execute(
                f"UPDATE sub_job_status SET {sets}, updated_at = ? WHERE prod_order_no = ? AND work_centre_no = ?",
                (*updates.values(), now, prod_order_no, work_centre_no),
            )
        row = conn.execute(
            "SELECT * FROM sub_job_status WHERE prod_order_no = ? AND work_centre_no = ?",
            (prod_order_no, work_centre_no),
        ).fetchone()
        return dict(row)


# ---------- users and settings ----------


def get_sales_order_wms() -> dict[str, str]:
    with get_conn() as conn:
        return {r["sales_order_no"]: r["wm_number"]
                for r in conn.execute("SELECT sales_order_no, wm_number FROM sales_order_wm")}


def set_sales_order_wm(sales_order_no: str, wm_number: str | None, set_by: str = "") -> None:
    """A blank clears it, so the number from the export is used again."""
    from datetime import datetime, timezone

    with get_conn() as conn:
        if not wm_number:
            conn.execute("DELETE FROM sales_order_wm WHERE sales_order_no = ?", (sales_order_no,))
            return
        conn.execute(
            "INSERT INTO sales_order_wm (sales_order_no, wm_number, updated_at, set_by) VALUES (?, ?, ?, ?) "
            "ON CONFLICT(sales_order_no) DO UPDATE SET wm_number = excluded.wm_number, "
            "updated_at = excluded.updated_at, set_by = excluded.set_by",
            (sales_order_no, wm_number, datetime.now(timezone.utc).isoformat(), set_by),
        )


def get_actual_hours(date_from: str | None = None, date_to: str | None = None) -> dict[tuple[str, str], float]:
    sql, args = "SELECT the_date, stage, hours FROM actual_hours", []
    where = []
    if date_from:
        where.append("the_date >= ?")
        args.append(date_from)
    if date_to:
        where.append("the_date <= ?")
        args.append(date_to)
    if where:
        sql += " WHERE " + " AND ".join(where)
    with get_conn() as conn:
        return {(r["the_date"], r["stage"]): r["hours"] for r in conn.execute(sql, args)}


def set_actual_hours(the_date: str, stage: str, hours: float | None) -> None:
    """A blank clears the row, so the hours available stand in again."""
    from datetime import datetime, timezone

    with get_conn() as conn:
        if hours is None:
            conn.execute("DELETE FROM actual_hours WHERE the_date = ? AND stage = ?", (the_date, stage))
            return
        conn.execute(
            "INSERT INTO actual_hours (the_date, stage, hours, updated_at) VALUES (?, ?, ?, ?) "
            "ON CONFLICT(the_date, stage) DO UPDATE SET hours = excluded.hours, updated_at = excluded.updated_at",
            (the_date, stage, float(hours), datetime.now(timezone.utc).isoformat()),
        )


def get_work_hours() -> dict[str, dict[int, float]]:
    out: dict[str, dict[int, float]] = {}
    with get_conn() as conn:
        for r in conn.execute("SELECT stage, weekday, hours FROM work_hours"):
            out.setdefault(r["stage"], {})[r["weekday"]] = r["hours"]
    return out


def set_work_hours(rows: list[dict]) -> None:
    with get_conn() as conn:
        conn.executemany(
            "INSERT INTO work_hours (stage, weekday, hours) VALUES (?, ?, ?) "
            "ON CONFLICT(stage, weekday) DO UPDATE SET hours = excluded.hours",
            [(r["stage"], int(r["weekday"]), float(r["hours"])) for r in rows],
        )


def get_day_overrides() -> list[dict]:
    with get_conn() as conn:
        cur = conn.execute(
            "SELECT the_date, stage, hours, note FROM day_overrides ORDER BY the_date, stage"
        )
        return [dict(r) for r in cur.fetchall()]


def set_day_override(the_date: str, stage: str, hours: float, note: str) -> None:
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO day_overrides (the_date, stage, hours, note) VALUES (?, ?, ?, ?) "
            "ON CONFLICT(the_date, stage) DO UPDATE SET hours = excluded.hours, note = excluded.note",
            (the_date, stage, float(hours), note),
        )


def delete_day_override(the_date: str, stage: str) -> None:
    with get_conn() as conn:
        conn.execute("DELETE FROM day_overrides WHERE the_date = ? AND stage = ?", (the_date, stage))


def get_product_minutes() -> dict[str, dict[str, float]]:
    out: dict[str, dict[str, float]] = {}
    with get_conn() as conn:
        for r in conn.execute("SELECT product_group, stage, minutes FROM product_minutes"):
            out.setdefault(r["product_group"], {})[r["stage"]] = r["minutes"]
    return out


def set_product_minutes(rows: list[dict]) -> int:
    from datetime import datetime, timezone

    now = datetime.now(timezone.utc).isoformat()
    with get_conn() as conn:
        # A blank value clears the row so the fallback takes over again.
        clear = [(r["product_group"], r["stage"]) for r in rows if r.get("minutes") in (None, "")]
        if clear:
            conn.executemany("DELETE FROM product_minutes WHERE product_group = ? AND stage = ?", clear)
        keep = [
            (r["product_group"], r["stage"], float(r["minutes"]), now)
            for r in rows
            if r.get("minutes") not in (None, "")
        ]
        if keep:
            conn.executemany(
                "INSERT INTO product_minutes (product_group, stage, minutes, updated_at) VALUES (?, ?, ?, ?) "
                "ON CONFLICT(product_group, stage) DO UPDATE SET minutes = excluded.minutes, "
                "updated_at = excluded.updated_at",
                keep,
            )
    return len(rows)


def get_setting(key: str) -> str | None:
    with get_conn() as conn:
        row = conn.execute("SELECT value FROM app_settings WHERE key = ?", (key,)).fetchone()
        return row["value"] if row else None


def set_setting(key: str, value: str) -> None:
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO app_settings (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )


def count_users() -> int:
    with get_conn() as conn:
        return conn.execute("SELECT COUNT(*) AS n FROM users").fetchone()["n"]


def get_user(username: str) -> dict | None:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM users WHERE username = ? COLLATE NOCASE", (username,)
        ).fetchone()
        return dict(row) if row else None


def list_users() -> list[str]:
    with get_conn() as conn:
        return [r["username"] for r in conn.execute("SELECT username FROM users ORDER BY username")]


def list_accounts() -> list[dict]:
    with get_conn() as conn:
        return [
            {"username": r["username"], "is_admin": bool(r["is_admin"]), "created_at": r["created_at"]}
            for r in conn.execute("SELECT username, is_admin, created_at FROM users ORDER BY username")
        ]


def count_admins() -> int:
    with get_conn() as conn:
        return conn.execute("SELECT COUNT(*) FROM users WHERE is_admin = 1").fetchone()[0]


def set_user_admin(username: str, is_admin: bool) -> bool:
    with get_conn() as conn:
        cur = conn.execute(
            "UPDATE users SET is_admin = ? WHERE username = ? COLLATE NOCASE",
            (1 if is_admin else 0, username),
        )
        return cur.rowcount > 0


def first_account() -> str | None:
    """The oldest account — the one the host seeded, on every deploy so far."""
    with get_conn() as conn:
        row = conn.execute("SELECT username FROM users ORDER BY created_at, username LIMIT 1").fetchone()
        return row["username"] if row else None


# ---------- door numbers ----------

def get_all_door_numbers() -> dict[str, dict]:
    """Every job that has been asked about, by production order."""
    with get_conn() as conn:
        return {
            r["prod_order_no"]: {
                "has_numbers": bool(r["has_numbers"]),
                # Stored one per line so a mark can hold anything but a newline.
                "marks": r["marks"].split("\n") if r["marks"] else [],
                "updated_at": r["updated_at"],
                "updated_by": r["updated_by"],
            }
            for r in conn.execute("SELECT * FROM door_numbers")
        }


def set_door_numbers(prod_order_no: str, has_numbers: bool, marks: list[str], actor: str | None) -> dict:
    from datetime import datetime, timezone

    now = datetime.now(timezone.utc).isoformat()
    text = "\n".join(marks) if has_numbers else ""
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO door_numbers (prod_order_no, has_numbers, marks, updated_at, updated_by) "
            "VALUES (?, ?, ?, ?, ?) "
            "ON CONFLICT(prod_order_no) DO UPDATE SET has_numbers = excluded.has_numbers, "
            "marks = excluded.marks, updated_at = excluded.updated_at, updated_by = excluded.updated_by",
            (prod_order_no, 1 if has_numbers else 0, text, now, actor),
        )
    return {
        "prod_order_no": prod_order_no,
        "has_numbers": has_numbers,
        "marks": marks if has_numbers else [],
        "updated_at": now,
        "updated_by": actor,
    }


# ---------- job names ----------

def get_all_sales_orders() -> dict[str, str]:
    with get_conn() as conn:
        return {
            r["sales_order_no"]: r["job_name"]
            for r in conn.execute("SELECT sales_order_no, job_name FROM sales_orders")
        }


def set_sales_orders(pairs: list[tuple[str, str]], actor: str | None) -> int:
    """Store job names for these orders, replacing what's there."""
    from datetime import datetime, timezone

    if not pairs:
        return 0
    now = datetime.now(timezone.utc).isoformat()
    with get_conn() as conn:
        conn.executemany(
            "INSERT INTO sales_orders (sales_order_no, job_name, updated_at, updated_by) "
            "VALUES (?, ?, ?, ?) "
            "ON CONFLICT(sales_order_no) DO UPDATE SET job_name = excluded.job_name, "
            "updated_at = excluded.updated_at, updated_by = excluded.updated_by",
            [(so, name, now, actor) for so, name in pairs],
        )
    return len(pairs)


def forget_door_numbers(prod_order_no: str) -> bool:
    """Put a job back to never-asked, so it returns to the queue."""
    with get_conn() as conn:
        return conn.execute(
            "DELETE FROM door_numbers WHERE prod_order_no = ?", (prod_order_no,)
        ).rowcount > 0


def upsert_user(username: str, salt: str, password_hash: str) -> None:
    from datetime import datetime, timezone

    with get_conn() as conn:
        conn.execute(
            "INSERT INTO users (username, salt, password_hash, created_at) VALUES (?, ?, ?, ?) "
            "ON CONFLICT(username) DO UPDATE SET salt = excluded.salt, password_hash = excluded.password_hash",
            (username, salt, password_hash, datetime.now(timezone.utc).isoformat()),
        )


def delete_user(username: str) -> int:
    with get_conn() as conn:
        cur = conn.execute("DELETE FROM users WHERE username = ? COLLATE NOCASE", (username,))
        return cur.rowcount
