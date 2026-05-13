#!/usr/bin/env python3
"""Download GenCon events and convert to docs/events.json for the static website."""

import csv
import io
import json
import os
import zipfile
from datetime import datetime, timezone

import requests
import openpyxl

EVENTS_URL   = "https://www.gencon.com/downloads/events.zip"
OUT_PATH     = os.path.join(os.path.dirname(__file__), "..", "docs", "events.json")
VERSION_PATH = os.path.join(os.path.dirname(__file__), "..", "docs", "version.json")
CSV_PATH     = os.path.join(os.path.dirname(__file__), "..", "events.csv")

# CSV column → JSON field name. Columns not listed here are dropped.
FIELD_MAP = [
    ("Game ID",               "id"),
    ("Group",                 "group"),
    ("Title",                 "title"),
    ("Short Description",     "shortDesc"),
    ("Long Description",      "longDesc"),
    ("Event Type",            "type"),
    ("Game System",           "system"),
    ("Rules Edition",         "rulesEdition"),
    ("Minimum Players",       "minPlayers"),
    ("Maximum Players",       "maxPlayers"),
    ("Age Required",          "ageRequired"),
    ("Experience Required",   "experienceRequired"),
    ("Start Date & Time",     "start"),
    ("Duration",              "duration"),
    ("End Date & Time",       "end"),
    ("GM Names",              "gmNames"),
    ("Tournament?",           "tournament"),
    ("Cost $",                "cost"),
    ("Location",              "location"),
    ("Room Name",             "roomName"),
    ("Table Number",          "tableNumber"),
    ("Special Category",      "specialCategory"),
    ("Tickets Available",     "ticketsAvailable"),
]

INT_FIELDS = {"minPlayers", "maxPlayers", "ticketsAvailable"}
FLOAT_FIELDS = {"duration", "cost"}
BOOL_FIELDS = {"tournament"}


def coerce(key: str, val: str) -> object:
    val = val.strip() if val else ""
    if key in INT_FIELDS:
        try:
            return int(float(val)) if val else 0
        except ValueError:
            return 0
    if key in FLOAT_FIELDS:
        try:
            return float(val) if val else 0.0
        except ValueError:
            return 0.0
    if key in BOOL_FIELDS:
        return val.lower() in ("yes", "true", "1")
    return val


def main() -> None:
    print(f"Downloading {EVENTS_URL} ...")
    resp = requests.get(EVENTS_URL, timeout=60)
    resp.raise_for_status()

    raw_rows: list[dict] = []

    with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
        names = zf.namelist()
        xlsx = [n for n in names if n.endswith(".xlsx")]
        csv_ = [n for n in names if n.endswith(".csv")]

        if xlsx:
            print(f"Extracting {xlsx[0]} ...")
            wb = openpyxl.load_workbook(io.BytesIO(zf.read(xlsx[0])), read_only=True, data_only=True)
            ws = wb.active
            all_rows = list(ws.iter_rows(values_only=True))
            wb.close()
            headers = [str(h) if h is not None else "" for h in all_rows[0]]
            for row in all_rows[1:]:
                raw_rows.append(dict(zip(headers, [str(v) if v is not None else "" for v in row])))
        elif csv_:
            print(f"Extracting {csv_[0]} ...")
            text = zf.read(csv_[0]).decode("utf-8-sig")
            reader = csv.DictReader(io.StringIO(text))
            raw_rows = list(reader)
        else:
            print(f"ERROR: No CSV or XLSX found in ZIP. Contents: {names}")
            raise SystemExit(1)

    # Write events.csv for the CLI (gencon.py)
    if raw_rows:
        csv_path = os.path.abspath(CSV_PATH)
        with open(csv_path, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=list(raw_rows[0].keys()))
            writer.writeheader()
            writer.writerows(raw_rows)
        print(f"Wrote {len(raw_rows):,} rows to {csv_path}")

    print(f"Converting {len(raw_rows):,} rows ...")

    events = []
    for row in raw_rows:
        ev = {}
        for csv_col, json_key in FIELD_MAP:
            ev[json_key] = coerce(json_key, row.get(csv_col, ""))
        if not ev.get("id"):
            continue
        events.append(ev)

    out_path = os.path.abspath(OUT_PATH)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(events, f, separators=(",", ":"))

    size_mb = os.path.getsize(out_path) / 1_048_576
    print(f"Wrote {len(events):,} events to {out_path} ({size_mb:.1f} MB)")

    version = {
        "built": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "count": len(events),
    }
    ver_path = os.path.abspath(VERSION_PATH)
    with open(ver_path, "w", encoding="utf-8") as f:
        json.dump(version, f)
    print(f"Wrote {ver_path}")


if __name__ == "__main__":
    main()
