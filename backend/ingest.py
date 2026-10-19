"""Parse Business Central exports (xlsx/csv) — Production Scheduler and Purchase Orders."""
import math
import re
from datetime import datetime
from pathlib import Path

import pandas as pd

from db import replace_purchase_orders, set_sales_orders, upsert_snapshot

# BC export header -> normalized field name
COLUMN_MAP = {
    "Work Centre Group Filter": "work_centre_group",
    "Status": "status",
    "Prod. Order No.": "prod_order_no",
    "Sales Order No.": "sales_order_no",
    "Operation Due Date": "operation_due_date",
    "Shipment Date": "shipment_date",
    "Location Code": "location_code",
    "Responsibility Centre": "responsibility_centre",
    "Source No.": "source_no",
    "Source Name": "source_name",
    "Potential Back Order": "potential_back_order",
    "Potential Back Order Reason Code": "potential_back_order_reason",
    "Potential Back Order Comment": "potential_back_order_comment",
    "Item No.": "item_no",
    "Item Description": "item_description",
    "Work Centre No.": "work_centre_no",
    "Description": "work_centre_description",
    "Operation No.": "operation_no",
    "Current Operation No.": "current_operation_no",
    "Stillage Location Code": "stillage_location_code",
    "Powder Rating": "powder_rating",
    "Stove Time": "stove_time",
    "Starting Date-Time": "starting_datetime",
    "Ending Date-Time": "ending_datetime",
    "Urgent": "urgent",
    "Expected Capacity Need (Mins.)": "expected_capacity_need_minutes",
    "Required Capacity (minutes)": "required_capacity_minutes",
    "Shortage": "shortage",
    "Comments": "comments",
    "Quantity": "quantity",
    "Square Metres": "square_metres",
    "Remaining Square Metres": "remaining_square_metres",
    "Linear Metres": "linear_metres",
    "Remaining Linear Metres": "remaining_linear_metres",
    "Colour Code": "colour_code",
    "Colour Description": "colour_description",
    "Operation Remaining Qty.": "operation_remaining_qty",
    "Operation Finished Qty.": "operation_finished_qty",
    "Operation Pct. Finished": "operation_pct_finished",
    "Order Finished Quantity": "order_finished_qty",
    "Order Remaining Quantity": "order_remaining_qty",
    "Unit of Measure Code": "uom",
    "Order Pct. Finished": "order_pct_finished",
    "Locked": "locked",
    "Sequence": "sequence",
}

PERCENT_FIELDS = {"operation_pct_finished", "order_pct_finished"}
BOOL_FIELDS = {"urgent", "shortage", "potential_back_order", "locked"}
NUMERIC_FIELDS = {
    "quantity", "square_metres", "remaining_square_metres", "linear_metres",
    "remaining_linear_metres", "operation_remaining_qty", "operation_finished_qty",
    "operation_pct_finished", "order_finished_qty", "order_remaining_qty",
    "order_pct_finished", "required_capacity_minutes", "expected_capacity_need_minutes",
    "sequence",
}

FILENAME_TS_RE = re.compile(r"(\d{4}-\d{2}-\d{2})T(\d{2})_(\d{2})_(\d{2})")

SUPPORTED_EXTENSIONS = {".xlsx", ".xls", ".csv"}


def classify_dataset(work_centre_group: str | None) -> str:
    if not work_centre_group:
        return "other"
    g = str(work_centre_group).strip().upper()
    if g.startswith("JOINERY"):
        return "joinery"
    if g.startswith("SUB"):
        return "subcontractors"
    # Cavities come off a different site and BC labels the group CAVITIES-W.
    # Match on the prefix so a change of suffix doesn't quietly start a second
    # dataset that no tab is reading.
    if g.startswith("CAVITIES"):
        return "cavities"
    return g.lower().replace(" ", "_")


def _clean_value(v):
    if v is None:
        return None
    if isinstance(v, float) and math.isnan(v):
        return None
    if isinstance(v, pd.Timestamp):
        if pd.isna(v):
            return None
        return v.isoformat()
    if isinstance(v, datetime):
        return v.isoformat()
    if isinstance(v, str) and v.strip() == "":
        return None
    return v


def _to_bool_int(v) -> int:
    if v is None:
        return 0
    if isinstance(v, bool):
        return int(v)
    if isinstance(v, (int, float)):
        return 1 if v else 0
    s = str(v).strip().lower()
    return 1 if s in {"1", "true", "yes", "x"} else 0


def _to_float(v):
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if math.isnan(f):
        return None
    return f


# BC has shipped the same report with different header spellings over time
# ("Work Centre" vs "Work Center", with/without "Code"). Normalise to one name so
# the rest of the parser doesn't care which vintage of export it's reading.
COLUMN_ALIASES = {
    "Work Center Group Code Filter": "Work Centre Group Filter",
    "Work Centre Group Code Filter": "Work Centre Group Filter",
    "Work Center Group Filter": "Work Centre Group Filter",
    "Work Center No.": "Work Centre No.",
    "Work Center Filter": "Work Centre Filter",
}


def _normalise_columns(df: pd.DataFrame) -> pd.DataFrame:
    df.columns = [str(c).strip() for c in df.columns]
    df.columns = [COLUMN_ALIASES.get(c, c) for c in df.columns]
    # a couple of exports carry both "Operation Remaining Qty." and the dotless
    # twin — drop exact duplicates so lookups stay unambiguous
    df = df.loc[:, ~df.columns.duplicated()]
    return df


def _read_table(path: Path) -> pd.DataFrame:
    if path.suffix.lower() == ".csv":
        df = pd.read_csv(path, dtype=str, keep_default_na=False, na_values=[""])
    else:
        df = pd.read_excel(path, dtype=str, engine="openpyxl")
    return _normalise_columns(df)


def _parse_snapshot_date(path: Path, df: pd.DataFrame) -> str:
    if "Shortage Last Calculated" in df.columns:
        parsed = pd.to_datetime(df["Shortage Last Calculated"], errors="coerce")
        if parsed.notna().any():
            return parsed.max().date().isoformat()

    m = FILENAME_TS_RE.search(path.name)
    if m:
        return m.group(1)

    return datetime.fromtimestamp(path.stat().st_mtime).date().isoformat()


PO_COLUMN_MAP = {
    "No.": "po_no",
    "Buy-from Vendor No.": "vendor_no",
    "Buy-from Vendor Name": "vendor_name",
    "Completely Received": "completely_received",
    "External Document No.": "external_doc_no",
    "Expected Receipt Date": "expected_receipt_date",
    "Purchase Order Date": "order_date",
    "Expected Receipt Date Confirmed": "receipt_date_confirmed",
    "Status": "status",
    "Location Code": "location_code",
    "Total Excl. GST": "total_excl_gst",
    "Total Incl. GST": "total_incl_gst",
    "Created By": "created_by",
}

PO_BOOL_FIELDS = {"completely_received", "receipt_date_confirmed"}
PO_NUMERIC_FIELDS = {"total_excl_gst", "total_incl_gst"}


def is_purchase_order_export(df: pd.DataFrame) -> bool:
    cols = set(df.columns)
    return {"No.", "Buy-from Vendor No.", "Purchase Order Date"} <= cols


def is_sales_order_export(df: pd.DataFrame) -> bool:
    """The Sales Orders list, which carries what the customer calls each job.

    Sell-to is what makes it a sales order and not something else: the Purchase
    Orders export carries both "No." and "External Document No." too, and buys
    from a vendor rather than selling to a customer. Those two columns alone
    would match it, and reading purchase orders as job names would overwrite
    every one of them with a supplier's reference.
    """
    cols = {str(c).strip() for c in df.columns}
    return {"No.", "External Document No.", "Sell-to Customer No."} <= cols


def parse_sales_orders(path: Path) -> list[tuple[str, str]]:
    """(sales order, job name) for every order that has one."""
    df = _read_table(path)
    df.columns = [str(c).strip() for c in df.columns]

    pairs: dict[str, str] = {}
    for _, row in df.iterrows():
        so = _clean_value(row.get("No."))
        name = _clean_value(row.get("External Document No."))
        if not so or not name:
            continue
        # Later rows win, matching what pasting the same list twice does.
        pairs[str(so).strip().upper()] = " ".join(str(name).split())
    if not pairs:
        raise ValueError("No sales orders with an External Document No. in that file")
    return list(pairs.items())


def parse_purchase_orders(path: Path) -> tuple[str, list[dict]]:
    """Returns (snapshot_date, rows) for db.replace_purchase_orders."""
    df = _read_table(path)
    df.columns = [str(c).strip() for c in df.columns]
    if df.empty:
        raise ValueError("Purchase order file has no data rows")

    snapshot_date = _parse_snapshot_date(path, df)
    rows = []
    for _, series in df.iterrows():
        raw = {k: _clean_value(v) for k, v in series.to_dict().items()}
        row = {field: raw.get(src) for src, field in PO_COLUMN_MAP.items()}
        if not row.get("po_no"):
            continue
        row["po_no"] = str(row["po_no"]).strip()
        for f in PO_BOOL_FIELDS:
            row[f] = _to_bool_int(row.get(f))
        for f in PO_NUMERIC_FIELDS:
            row[f] = _to_float(row.get(f))
        row["snapshot_date"] = snapshot_date
        rows.append(row)

    return snapshot_date, rows


def ingest_purchase_orders(path: Path) -> dict:
    snapshot_date, rows = parse_purchase_orders(path)
    if not rows:
        raise ValueError("No usable purchase order rows found")
    count = replace_purchase_orders(rows, snapshot_date)
    return {"dataset": "purchase_orders", "snapshot_date": snapshot_date, "row_count": count, "source_file": str(path)}


def ingest_sales_orders(path: Path, actor: str | None = None) -> dict:
    """Job names only — this export has no production work in it, so it adds no
    snapshot and nothing on the boards changes except what the labels say."""
    from datetime import date

    pairs = parse_sales_orders(path)
    saved = set_sales_orders(pairs, actor)
    return {
        "dataset": "sales_orders",
        "snapshot_date": date.today().isoformat(),
        "row_count": saved,
        "source_file": str(path),
    }


def parse_file(path: Path) -> tuple[str, str, list[dict]]:
    """Returns (dataset, snapshot_date, rows) ready for db.upsert_snapshot."""
    df = _read_table(path)
    df.columns = [str(c).strip() for c in df.columns]

    if df.empty:
        raise ValueError("File has no data rows")

    if "Work Centre Group Filter" not in df.columns:
        raise ValueError("Not a recognised Production Scheduler export (missing Work Centre Group Filter column)")

    work_centre_group = df["Work Centre Group Filter"].dropna().iloc[0] if df["Work Centre Group Filter"].notna().any() else None
    dataset = classify_dataset(work_centre_group)
    snapshot_date = _parse_snapshot_date(path, df)

    rows = []
    for _, series in df.iterrows():
        raw = {k: _clean_value(v) for k, v in series.to_dict().items()}
        if all(v is None for v in raw.values()):
            continue

        row = {}
        for src_col, field in COLUMN_MAP.items():
            row[field] = raw.get(src_col)

        for f in BOOL_FIELDS:
            row[f] = _to_bool_int(row.get(f))
        for f in NUMERIC_FIELDS:
            row[f] = _to_float(row.get(f))
        for f in PERCENT_FIELDS:
            if row.get(f) is not None:
                row[f] = round(row[f] / 100.0, 2)

        row["dataset"] = dataset
        row["line_key"] = "|".join(
            str(row.get(k) or "") for k in
            ("prod_order_no", "item_no", "operation_no", "work_centre_no")
        )
        rows.append(row)

    return dataset, snapshot_date, rows


def file_kind(path: Path) -> str:
    """What sort of export this is, without ingesting it — so the caller can
    decide whether this person is allowed to load it."""
    probe = _read_table(path)
    probe.columns = [str(c).strip() for c in probe.columns]
    if is_purchase_order_export(probe):
        return "purchase_orders"
    if is_sales_order_export(probe):
        return "sales_orders"
    return "production"


def ingest_file(path: Path, actor: str | None = None) -> dict:
    # purchase order and sales order exports have completely different shapes —
    # route them first
    probe = _read_table(path)
    probe.columns = [str(c).strip() for c in probe.columns]
    if is_purchase_order_export(probe):
        return ingest_purchase_orders(path)
    if is_sales_order_export(probe):
        return ingest_sales_orders(path, actor)

    dataset, snapshot_date, rows = parse_file(path)
    if not rows:
        raise ValueError("No usable rows found in file")
    snapshot_id = upsert_snapshot(dataset, snapshot_date, str(path), rows)
    return {
        "dataset": dataset,
        "snapshot_date": snapshot_date,
        "snapshot_id": snapshot_id,
        "row_count": len(rows),
        "source_file": str(path),
    }
