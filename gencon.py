#!/usr/bin/env python3
"""GenCon 2026 event downloader and search tool."""

import argparse
import csv
import io
import json
import os
import sys
import zipfile
from datetime import datetime, timedelta, timezone

import requests
from tabulate import tabulate

try:
    import openpyxl
    HAS_OPENPYXL = True
except ImportError:
    HAS_OPENPYXL = False

EVENTS_URL = "https://www.gencon.com/downloads/events.zip"
CSV_PATH = os.path.join(os.path.dirname(__file__), "events.csv")
SCHEDULE_PATH = os.path.join(os.path.dirname(__file__), "schedule.json")
DT_FMT = "%m/%d/%Y %I:%M %p"

DAYS = {
    "07/30": "Thu",
    "07/31": "Fri",
    "08/01": "Sat",
    "08/02": "Sun",
    "08/03": "Mon",
}
CONV_DATES = list(DAYS.keys())

# Default convention day window for gap calculation (hour of day, 24h)
DAY_START_HOUR = 8   # 8:00 AM — before this is ignored for suggestions
DAY_END_HOUR = 24    # midnight

# Columns displayed in search results
DISPLAY_COLS = [
    "Game ID",
    "Title",
    "Short Description",
    "Event Type",
    "Game System",
    "Start Date & Time",
    "Duration",
    "Ticket Price",
    "Hall & Room",
    "Table",
    "GM Names",
]

# All searchable text columns
SEARCH_COLS = [
    "Title",
    "Short Description",
    "Long Description",
    "Game System",
    "GM Names",
    "Event Type",
]


def download(force: bool = False) -> None:
    """Download and extract the events CSV."""
    if os.path.exists(CSV_PATH) and not force:
        age_hours = (
            datetime.now(timezone.utc).timestamp() - os.path.getmtime(CSV_PATH)
        ) / 3600
        print(f"events.csv already exists (age: {age_hours:.1f}h). Use --force to re-download.")
        return

    print(f"Downloading events from {EVENTS_URL} ...")
    resp = requests.get(EVENTS_URL, timeout=60)
    resp.raise_for_status()

    with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
        names = zf.namelist()
        csv_names = [n for n in names if n.endswith(".csv")]
        xlsx_names = [n for n in names if n.endswith(".xlsx")]

        if csv_names:
            name = csv_names[0]
            print(f"Extracting {name} ...")
            data = zf.read(name)
            with open(CSV_PATH, "wb") as f:
                f.write(data)
            row_count = data.count(b"\n") - 1
        elif xlsx_names:
            if not HAS_OPENPYXL:
                print("openpyxl is required to read .xlsx files. Run: pip install openpyxl", file=sys.stderr)
                sys.exit(1)
            name = xlsx_names[0]
            print(f"Extracting {name} and converting to CSV ...")
            xlsx_data = zf.read(name)
            wb = openpyxl.load_workbook(io.BytesIO(xlsx_data), read_only=True, data_only=True)
            ws = wb.active
            rows = list(ws.iter_rows(values_only=True))
            wb.close()
            with open(CSV_PATH, "w", newline="", encoding="utf-8") as f:
                writer = csv.writer(f)
                for row in rows:
                    writer.writerow(["" if v is None else str(v) for v in row])
            row_count = len(rows) - 1
        else:
            print(f"No CSV or XLSX file found in ZIP. Contents: {names}", file=sys.stderr)
            sys.exit(1)

    print(f"Saved {row_count:,} events to {CSV_PATH}")


def load_events() -> list[dict]:
    """Load events from the local CSV file."""
    if not os.path.exists(CSV_PATH):
        print("events.csv not found. Run: python gencon.py download", file=sys.stderr)
        sys.exit(1)

    with open(CSV_PATH, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        return list(reader)


def search(
    query: str,
    event_type: str | None,
    day: str | None,
    system: str | None,
    min_tickets: int | None,
    limit: int,
) -> None:
    """Search events and print results."""
    events = load_events()
    query_lower = query.lower() if query else ""

    results = []
    for ev in events:
        # Text search across searchable columns
        if query_lower:
            if not any(query_lower in (ev.get(col) or "").lower() for col in SEARCH_COLS):
                continue

        # Filter: event type
        if event_type and event_type.lower() not in (ev.get("Event Type") or "").lower():
            continue

        # Filter: day of week or date substring (e.g. "Wednesday" or "08/06")
        if day and day.lower() not in (ev.get("Start Date & Time") or "").lower():
            continue

        # Filter: game system
        if system and system.lower() not in (ev.get("Game System") or "").lower():
            continue

        # Filter: available tickets
        if min_tickets is not None:
            try:
                avail = int(ev.get("Tickets Available") or ev.get("Available Tickets") or 0)
                if avail < min_tickets:
                    continue
            except ValueError:
                pass

        results.append(ev)

    total = len(results)
    results = results[:limit]

    if not results:
        print("No events found.")
        return

    # Build display table
    available_cols = list(results[0].keys())
    cols = [c for c in DISPLAY_COLS if c in available_cols]
    # Fallback: add Hall & Room from separate columns if needed
    if "Hall & Room" not in available_cols and "Hall" in available_cols:
        for ev in results:
            ev["Hall & Room"] = f"{ev.get('Hall', '')} {ev.get('Room & Table', '')}".strip()
        cols = [c if c != "Hall & Room" else "Hall & Room" for c in cols]

    rows = []
    for ev in results:
        row = []
        for col in cols:
            val = ev.get(col, "")
            # Truncate long fields
            if col in ("Short Description", "Long Description") and len(val) > 60:
                val = val[:57] + "..."
            row.append(val)
        rows.append(row)

    print(tabulate(rows, headers=cols, tablefmt="simple", maxcolwidths=40))
    print(f"\n{total:,} result(s)" + (f" (showing first {limit})" if total > limit else ""))


def show_types() -> None:
    """List all unique event types."""
    events = load_events()
    types: dict[str, int] = {}
    for ev in events:
        t = ev.get("Event Type") or "(unknown)"
        types[t] = types.get(t, 0) + 1
    for t, count in sorted(types.items(), key=lambda x: -x[1]):
        print(f"  {count:5,}  {t}")


def show_event(game_id: str) -> None:
    """Show full details for a single event by Game ID."""
    events = load_events()
    for ev in events:
        if ev.get("Game ID", "").strip() == game_id.strip():
            for key, val in ev.items():
                if val:
                    print(f"{key}: {val}")
            return
    print(f"Event {game_id!r} not found.")


# ---------------------------------------------------------------------------
# Schedule helpers
# ---------------------------------------------------------------------------

def _load_schedule() -> list[str]:
    """Return list of Game IDs in the schedule."""
    if not os.path.exists(SCHEDULE_PATH):
        return []
    with open(SCHEDULE_PATH) as f:
        return json.load(f).get("events", [])


def _save_schedule(ids: list[str]) -> None:
    with open(SCHEDULE_PATH, "w") as f:
        json.dump({"events": ids}, f, indent=2)


def _parse_event_times(ev: dict) -> tuple[datetime, datetime] | None:
    """Return (start, end) datetimes or None if unparseable."""
    try:
        start = datetime.strptime(ev["Start Date & Time"], DT_FMT)
        end = datetime.strptime(ev["End Date & Time"], DT_FMT)
        return start, end
    except (ValueError, KeyError):
        return None


def _overlaps(a_start: datetime, a_end: datetime, b_start: datetime, b_end: datetime) -> bool:
    return a_start < b_end and b_start < a_end


def _find_conflicts(
    candidate: dict, scheduled_events: list[dict]
) -> list[dict]:
    """Return scheduled events that overlap with candidate."""
    times = _parse_event_times(candidate)
    if times is None:
        return []
    c_start, c_end = times
    conflicts = []
    for ev in scheduled_events:
        t = _parse_event_times(ev)
        if t and _overlaps(c_start, c_end, t[0], t[1]):
            conflicts.append(ev)
    return conflicts


def _fmt_slot(ev: dict) -> str:
    """One-line summary of an event's timeslot."""
    start = ev.get("Start Date & Time", "")
    end = ev.get("End Date & Time", "")
    day = ""
    if start:
        for prefix, name in DAYS.items():
            if start.startswith(prefix):
                day = name + " "
                break
    time_part = ""
    if start and end:
        try:
            s = datetime.strptime(start, DT_FMT)
            e = datetime.strptime(end, DT_FMT)
            time_part = f"{s.strftime('%-I:%M %p')}–{e.strftime('%-I:%M %p')}"
        except ValueError:
            time_part = f"{start}–{end}"
    return f"{day}{time_part}"


def _event_index(events: list[dict]) -> dict[str, dict]:
    return {ev["Game ID"]: ev for ev in events}


# ---------------------------------------------------------------------------
# Schedule commands
# ---------------------------------------------------------------------------

def schedule_add(game_id: str, force: bool = False) -> None:
    """Add an event to the schedule."""
    events = load_events()
    idx = _event_index(events)

    if game_id not in idx:
        print(f"Event {game_id!r} not found in events.csv.", file=sys.stderr)
        sys.exit(1)

    candidate = idx[game_id]
    ids = _load_schedule()

    if game_id in ids:
        print(f"{game_id} is already in your schedule.")
        return

    scheduled = [idx[i] for i in ids if i in idx]
    conflicts = _find_conflicts(candidate, scheduled)

    if conflicts and not force:
        print(f"CONFLICT: {game_id} ({candidate['Title']}) overlaps with:")
        for c in conflicts:
            print(f"  {c['Game ID']}  {_fmt_slot(c)}  {c['Title']}")
        print("Use --force to add anyway.")
        return

    ids.append(game_id)
    _save_schedule(ids)

    slot = _fmt_slot(candidate)
    print(f"Added: [{game_id}] {candidate['Title']}  ({slot})")
    if conflicts:
        print("  WARNING: overlaps with:")
        for c in conflicts:
            print(f"    {c['Game ID']}  {_fmt_slot(c)}  {c['Title']}")


def schedule_remove(game_id: str) -> None:
    """Remove an event from the schedule."""
    ids = _load_schedule()
    if game_id not in ids:
        print(f"{game_id} is not in your schedule.")
        return
    ids.remove(game_id)
    _save_schedule(ids)
    print(f"Removed {game_id} from schedule.")


def schedule_list(day: str | None) -> None:
    """Print the schedule as a day-by-day agenda."""
    ids = _load_schedule()
    if not ids:
        print("Your schedule is empty. Use 'schedule add <GAME_ID>' to add events.")
        return

    events = load_events()
    idx = _event_index(events)

    scheduled = []
    missing = []
    for gid in ids:
        if gid in idx:
            ev = idx[gid]
            t = _parse_event_times(ev)
            scheduled.append((t[0] if t else datetime.min, ev))
        else:
            missing.append(gid)

    scheduled.sort(key=lambda x: x[0])

    # Group by day
    by_day: dict[str, list[dict]] = {}
    for _, ev in scheduled:
        start = ev.get("Start Date & Time", "")
        day_key = start[:5] if start else "Unknown"
        day_label = DAYS.get(day_key, day_key)
        if day and day.lower() not in day_label.lower() and day.lower() not in day_key:
            continue
        by_day.setdefault(day_label, []).append(ev)

    for day_label, evs in by_day.items():
        print(f"\n{'─' * 60}")
        print(f"  {day_label}")
        print(f"{'─' * 60}")
        rows = []
        for ev in evs:
            t = _parse_event_times(ev)
            if t:
                slot = f"{t[0].strftime('%-I:%M %p')}–{t[1].strftime('%-I:%M %p')}"
            else:
                slot = "?"
            title = ev.get("Title", "")
            if len(title) > 42:
                title = title[:39] + "..."
            rows.append([
                ev.get("Game ID", ""),
                slot,
                title,
                ev.get("Event Type", "").split(" - ")[0],
                ev.get("Location", ""),
            ])
        print(tabulate(rows, headers=["Game ID", "Time", "Title", "Type", "Location"], tablefmt="plain"))

    print(f"\n{len(scheduled)} event(s) scheduled.")
    if missing:
        print(f"Warning: {len(missing)} ID(s) not found in events.csv: {', '.join(missing)}")


def schedule_check(game_id: str) -> None:
    """Check if an event conflicts with the schedule without adding it."""
    events = load_events()
    idx = _event_index(events)

    if game_id not in idx:
        print(f"Event {game_id!r} not found.", file=sys.stderr)
        sys.exit(1)

    candidate = idx[game_id]
    ids = _load_schedule()
    scheduled = [idx[i] for i in ids if i in idx]
    conflicts = _find_conflicts(candidate, scheduled)

    print(f"{game_id}: {candidate['Title']}")
    print(f"  {_fmt_slot(candidate)}")
    if not conflicts:
        print("  No conflicts — free to add.")
    else:
        print("  Conflicts with:")
        for c in conflicts:
            print(f"    {c['Game ID']}  {_fmt_slot(c)}  {c['Title']}")


def schedule_alternatives(game_id: str) -> None:
    """Find all timeslots for the same event title and show schedule compatibility."""
    events = load_events()
    idx = _event_index(events)

    if game_id not in idx:
        print(f"Event {game_id!r} not found.", file=sys.stderr)
        sys.exit(1)

    target = idx[game_id]
    title = target.get("Title", "").strip()

    # Find all events with the same title
    matches = [ev for ev in events if ev.get("Title", "").strip() == title]
    matches.sort(key=lambda ev: _parse_event_times(ev)[0] if _parse_event_times(ev) else datetime.min)

    ids = _load_schedule()
    scheduled = [idx[i] for i in ids if i in idx]

    print(f"All timeslots for: {title!r}  ({len(matches)} found)\n")

    rows = []
    for ev in matches:
        gid = ev.get("Game ID", "")
        slot = _fmt_slot(ev)
        conflicts = _find_conflicts(ev, scheduled)
        in_sched = gid in ids

        if in_sched:
            status = "IN SCHEDULE"
        elif conflicts:
            names = ", ".join(c["Game ID"] for c in conflicts)
            status = f"conflicts: {names}"
        else:
            status = "free"

        avail = ev.get("Tickets Available", "?")
        cost = ev.get("Cost $", "")
        location = ev.get("Location", "")

        rows.append([gid, slot, avail, cost, location, status])

    print(tabulate(
        rows,
        headers=["Game ID", "Timeslot", "Avail", "Cost", "Location", "Status"],
        tablefmt="simple",
    ))
    print()
    free = sum(1 for r in rows if r[5] == "free")
    print(f"{free} free slot(s). Use 'schedule add <GAME_ID>' to book one.")


def schedule_clear() -> None:
    """Remove all events from the schedule."""
    ids = _load_schedule()
    if not ids:
        print("Schedule is already empty.")
        return
    resp = input(f"Remove all {len(ids)} event(s) from schedule? [y/N] ")
    if resp.strip().lower() == "y":
        _save_schedule([])
        print("Schedule cleared.")


def schedule_suggest(
    day: str | None,
    event_type: str | None,
    system: str | None,
    min_dur: float | None,
    max_dur: float | None,
    min_tickets: int | None,
    per_gap: int,
) -> None:
    """Suggest events that fit into free gaps in the schedule."""
    events = load_events()
    ids = _load_schedule()
    idx = _event_index(events)
    scheduled_ids = set(ids)

    # Determine which days to process
    dates_to_check = CONV_DATES
    if day:
        dl = day.lower()
        dates_to_check = [
            d for d in CONV_DATES
            if dl in DAYS.get(d, "").lower() or dl in d
        ]
        if not dates_to_check:
            print(f"No GenCon days matched {day!r}. Use Thu/Fri/Sat/Sun/Mon or a date like 07/30.")
            return

    # Index all unscheduled events by their date prefix for fast gap filling
    by_date: dict[str, list[dict]] = {}
    for ev in events:
        gid = ev.get("Game ID", "")
        if gid in scheduled_ids:
            continue
        start = ev.get("Start Date & Time", "")
        if not start:
            continue
        date_key = start[:5]
        by_date.setdefault(date_key, []).append(ev)

    total_suggestions = 0

    for date_key in dates_to_check:
        day_label = DAYS.get(date_key, date_key)

        # Build the scheduled timeline for this day (including events that started
        # the previous day but run into this one)
        day_dt = datetime.strptime(f"{date_key}/2026", "%m/%d/%Y")
        wall_start = day_dt.replace(hour=DAY_START_HOUR)
        wall_end = day_dt + timedelta(hours=DAY_END_HOUR)  # DAY_END_HOUR=24 → midnight

        # Collect scheduled events that overlap this day's wall window
        day_scheduled: list[tuple[datetime, datetime, dict]] = []
        for gid in ids:
            ev = idx.get(gid)
            if not ev:
                continue
            t = _parse_event_times(ev)
            if t and t[0] < wall_end and t[1] > wall_start:
                day_scheduled.append((t[0], t[1], ev))
        day_scheduled.sort()

        # Compute free gaps within the wall window
        gaps: list[tuple[datetime, datetime]] = []
        cursor = wall_start
        for ev_start, ev_end, _ in day_scheduled:
            gap_s = max(cursor, wall_start)
            gap_e = min(ev_start, wall_end)
            if gap_e > gap_s:
                gaps.append((gap_s, gap_e))
            cursor = max(cursor, ev_end)
        # Trailing gap
        if cursor < wall_end:
            gaps.append((max(cursor, wall_start), wall_end))

        if not gaps:
            continue

        # For each gap, find events that fit entirely within it
        candidate_events = by_date.get(date_key, [])

        printed_day_header = False

        for gap_start, gap_end in gaps:
            gap_hours = (gap_end - gap_start).total_seconds() / 3600
            if gap_hours < 0.5:
                continue

            fits: list[tuple[float, float, dict]] = []  # (score, dur, ev)
            for ev in candidate_events:
                t = _parse_event_times(ev)
                if not t:
                    continue
                ev_start, ev_end = t
                if ev_start < gap_start or ev_end > gap_end:
                    continue

                # Apply user filters
                if event_type and event_type.lower() not in (ev.get("Event Type") or "").lower():
                    continue
                if system and system.lower() not in (ev.get("Game System") or "").lower():
                    continue
                try:
                    dur = float(ev.get("Duration") or 0)
                except ValueError:
                    dur = 0
                if min_dur is not None and dur < min_dur:
                    continue
                if max_dur is not None and dur > max_dur:
                    continue
                try:
                    avail = int(ev.get("Tickets Available") or 0)
                except ValueError:
                    avail = 0
                if min_tickets is not None and avail < min_tickets:
                    continue

                # Score: prefer events that fill more of the gap, then by availability
                fill_ratio = dur / gap_hours if gap_hours > 0 else 0
                fits.append((fill_ratio, avail, dur, ev))

            if not fits:
                continue

            # Sort: best fill ratio first, break ties by availability
            fits.sort(key=lambda x: (-x[0], -x[1]))

            if not printed_day_header:
                print(f"\n{'═' * 64}")
                print(f"  {day_label}  ({day_dt.strftime('%B %-d')})")
                print(f"{'═' * 64}")
                printed_day_header = True

            gs = gap_start.strftime("%-I:%M %p")
            ge = gap_end.strftime("%-I:%M %p")
            total_fit = len(fits)
            print(f"\n  Gap: {gs} – {ge}  ({gap_hours:.1f}h free, {total_fit} event(s) fit)")
            print(f"  {'─' * 60}")

            rows = []
            for fill_ratio, avail, dur, ev in fits[:per_gap]:
                t = _parse_event_times(ev)
                slot = (
                    f"{t[0].strftime('%-I:%M')}-{t[1].strftime('%-I:%M %p')}"
                    if t else "?"
                )
                title = ev.get("Title", "")
                if len(title) > 36:
                    title = title[:33] + "..."
                etype = (ev.get("Event Type") or "").split(" - ")[0]
                cost = ev.get("Cost $", "")
                rows.append([ev.get("Game ID", ""), slot, title, etype, avail, cost])

            print(tabulate(
                rows,
                headers=["Game ID", "Time", "Title", "Type", "Avail", "$"],
                tablefmt="plain",
                colalign=("left", "left", "left", "left", "right", "right"),
            ))

            if total_fit > per_gap:
                remaining = total_fit - per_gap
                print(f"  … {remaining} more fit this gap. Use -t/-s/--min/--max to narrow.")

            total_suggestions += min(total_fit, per_gap)

    if total_suggestions == 0:
        print("No suggestions found. Try relaxing your filters or checking different days.")


# ---------------------------------------------------------------------------
# AI-powered event suggestions
# ---------------------------------------------------------------------------

def _ai_search_events(
    params: dict,
    scheduled_ids: list[str],
    idx: dict[str, dict],
    all_events: list[dict],
) -> str:
    """Execute the search_events tool call and return a formatted string for Claude."""
    query      = (params.get("query") or "").strip()
    event_type = (params.get("event_type") or "").strip()
    day        = (params.get("day") or "").strip()
    system     = (params.get("system") or "").strip()
    min_tickets = int(params.get("min_tickets") or 0)
    min_dur     = float(params.get("min_dur") or 0)
    max_dur     = float(params.get("max_dur") or 0)
    limit       = min(int(params.get("limit") or 12), 25)

    query_lower = query.lower()
    scheduled_evs = [idx[i] for i in scheduled_ids if i in idx]
    results: list[dict] = []

    for ev in all_events:
        if ev.get("Game ID") in scheduled_ids:
            continue
        if query_lower and not any(
            query_lower in (ev.get(col) or "").lower() for col in SEARCH_COLS
        ):
            continue
        if event_type and event_type.lower() not in (ev.get("Event Type") or "").lower():
            continue
        if day:
            prefix = (ev.get("Start Date & Time") or "")[:5]
            label  = DAYS.get(prefix, "")
            if not label.lower().startswith(day.lower()) and not prefix.startswith(day):
                continue
        if system and system.lower() not in (ev.get("Game System") or "").lower():
            continue
        try:
            avail = int(ev.get("Tickets Available") or 0)
        except ValueError:
            avail = 0
        if min_tickets > 0 and avail < min_tickets:
            continue
        try:
            dur = float(ev.get("Duration") or 0)
        except ValueError:
            dur = 0
        if min_dur > 0 and dur < min_dur:
            continue
        if max_dur > 0 and dur > max_dur:
            continue
        results.append(ev)

    total = len(results)
    shown = results[:limit]

    lines = [f"Found {total} matching events (showing {len(shown)}):"]
    for ev in shown:
        gid  = ev.get("Game ID", "")
        cfls = _find_conflicts(ev, scheduled_evs)
        flag = " [CONFLICTS WITH SCHEDULE]" if cfls else ""
        try:
            avail_n = int(ev.get("Tickets Available") or 0)
        except ValueError:
            avail_n = 0
        short = (ev.get("Short Description") or "")[:100]
        lines.append(
            f"\n{gid}: {ev.get('Title', '')}{flag}\n"
            f"  Type: {ev.get('Event Type', '')} | System: {ev.get('Game System', '')}\n"
            f"  When: {_fmt_slot(ev)} | Duration: {ev.get('Duration', '')}h\n"
            f"  Location: {ev.get('Location', '')} {ev.get('Room Name', '')}\n"
            f"  Tickets: {avail_n} | Cost: ${ev.get('Cost $', '0')}\n"
            f"  {short}"
        )
    return "\n".join(lines)


def _ai_get_event_details(
    game_id: str,
    scheduled_ids: list[str],
    idx: dict[str, dict],
) -> str:
    """Execute the get_event_details tool call."""
    ev = idx.get(game_id.strip())
    if not ev:
        return f"Event {game_id!r} not found in the catalog."

    scheduled_evs = [idx[i] for i in scheduled_ids if i in idx]
    cfls = _find_conflicts(ev, scheduled_evs)

    if game_id in scheduled_ids:
        status = "Already in your schedule."
    elif cfls:
        status = "CONFLICTS with: " + ", ".join(
            f"{c.get('Game ID')} ({c.get('Title', '')})" for c in cfls
        )
    else:
        status = "Free — no conflicts with your schedule."

    try:
        avail = int(ev.get("Tickets Available") or 0)
    except ValueError:
        avail = 0

    return (
        f"Game ID: {game_id}\n"
        f"Title: {ev.get('Title', '')}\n"
        f"Type: {ev.get('Event Type', '')}\n"
        f"System: {ev.get('Game System', '')} ({ev.get('Rules Edition', '')})\n"
        f"When: {_fmt_slot(ev)}\n"
        f"Duration: {ev.get('Duration', '')}h\n"
        f"GM: {ev.get('GM Names', '')}\n"
        f"Location: {ev.get('Location', '')} · {ev.get('Room Name', '')} · Table {ev.get('Table Number', '')}\n"
        f"Players: {ev.get('Minimum Players', '')}–{ev.get('Maximum Players', '')}\n"
        f"Age: {ev.get('Age Required', '')} | Experience: {ev.get('Experience Required', '')}\n"
        f"Tournament: {ev.get('Tournament?', '')} | Cost: ${ev.get('Cost $', '0')} | Tickets: {avail}\n"
        f"Group: {ev.get('Group', '')}\n"
        f"Summary: {ev.get('Short Description', '')}\n"
        f"Description: {ev.get('Long Description', '')}\n"
        f"Schedule status: {status}"
    )


def _tool_label(name: str, tool_input: dict) -> str:
    """Short human-readable label for a tool call (shown in terminal)."""
    if name == "search_events":
        parts = []
        if tool_input.get("query"):      parts.append(f'"{tool_input["query"]}"')
        if tool_input.get("event_type"): parts.append(tool_input["event_type"])
        if tool_input.get("system"):     parts.append(tool_input["system"])
        if tool_input.get("day"):        parts.append(tool_input["day"])
        desc = ", ".join(parts) if parts else "all events"
        return f"Searching: {desc}"
    if name == "get_event_details":
        return f"Looking up: {tool_input.get('game_id', '?')}"
    return f"Calling: {name}"


def schedule_ai_suggest(
    count: int,
    day: str | None,
    event_type: str | None,
) -> None:
    """Use Claude to suggest events tailored to the user's schedule preferences."""
    try:
        import anthropic as _ant
    except ImportError:
        print(
            "The 'anthropic' package is required for AI suggestions.\n"
            "Install it with: pip install anthropic",
            file=sys.stderr,
        )
        sys.exit(1)

    ids = _load_schedule()
    if not ids:
        print("Your schedule is empty — add some events first so the AI can learn your tastes.")
        print("Try: python gencon.py schedule add <GAME_ID>")
        return

    events    = load_events()
    idx       = _event_index(events)
    scheduled = [idx[i] for i in ids if i in idx]

    # Build a readable schedule summary for the system prompt
    sorted_sched = sorted(
        scheduled,
        key=lambda e: (_parse_event_times(e) or (datetime.min, datetime.min))[0],
    )
    sched_lines = [
        f"  [{ev.get('Game ID','')}] {ev.get('Title','')} | "
        f"{(ev.get('Event Type','') or '').split(' - ')[0]} | "
        f"{ev.get('Game System','')} | "
        f"{_fmt_slot(ev)} | "
        f"{(ev.get('Short Description','') or '')[:80]}"
        for ev in sorted_sched
    ]
    schedule_summary = "\n".join(sched_lines)

    # Compute free gaps so Claude knows what time is available
    gap_lines: list[str] = []
    for g in getSuggestions({}):
        gs = g["gapStart"].strftime("%-I:%M %p")
        ge = g["gapEnd"].strftime("%-I:%M %p")
        gap_lines.append(f"  {g['dayLabel']} {gs} – {ge} ({g['gapHours']:.1f}h free)")
    gap_summary = "\n".join(gap_lines) if gap_lines else "  (full days available)"

    # --- Tool definitions ---------------------------------------------------
    tools: list[dict] = [
        {
            "name": "search_events",
            "description": (
                "Search the GenCon 2026 event catalog. Returns up to `limit` events "
                "matching the criteria, each annotated [CONFLICTS WITH SCHEDULE] if it "
                "overlaps an event already on the user's schedule. Use multiple searches "
                "with different queries to explore broadly."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Text search across title, descriptions, game system, GM names",
                    },
                    "event_type": {
                        "type": "string",
                        "description": "Event type prefix to filter by (e.g. 'RPG', 'BGM', 'TCG', 'WKS')",
                    },
                    "day": {
                        "type": "string",
                        "description": "Day to filter: Thu, Fri, Sat, Sun, or Mon",
                    },
                    "system": {
                        "type": "string",
                        "description": "Game system to filter by (e.g. 'Pathfinder', 'D&D', 'Cthulhu')",
                    },
                    "min_tickets": {
                        "type": "integer",
                        "description": "Minimum available tickets (use 1 to exclude sold-out events)",
                    },
                    "min_dur": {
                        "type": "number",
                        "description": "Minimum event duration in hours",
                    },
                    "max_dur": {
                        "type": "number",
                        "description": "Maximum event duration in hours",
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Max results to return (default 12, max 25)",
                    },
                },
                "required": [],
            },
        },
        {
            "name": "get_event_details",
            "description": (
                "Get full details for a specific event by Game ID, including the long "
                "description. Use this to read the full write-up before recommending."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "game_id": {
                        "type": "string",
                        "description": "The Game ID (e.g. RPG26ND300797)",
                    }
                },
                "required": ["game_id"],
            },
        },
    ]

    # --- System prompt -------------------------------------------------------
    focus_notes = []
    if day:        focus_notes.append(f"The user wants suggestions specifically for: {day}")
    if event_type: focus_notes.append(f"The user prefers event type: {event_type}")
    focus_block = ("\n\nAdditional focus:\n" + "\n".join(focus_notes)) if focus_notes else ""

    system = f"""You are a personalized GenCon 2026 event advisor. Your job is to recommend events the user will genuinely love, based on the specific patterns in their existing schedule.

The user's current schedule ({len(scheduled)} events):
{schedule_summary}

Free time slots available:
{gap_summary}{focus_block}

Your process:
1. Analyze the schedule carefully: what game systems, themes, event types, and duration ranges does the user clearly enjoy?
2. Use search_events to find strong candidates — run several searches with different angles (by system, theme, type, keywords from their event titles/descriptions)
3. Use get_event_details to read the full write-up for your top candidates before committing to a recommendation
4. Only recommend events that DON'T conflict with the schedule (results are flagged [CONFLICTS WITH SCHEDULE])

Deliver exactly {count} recommendations. For each one:
- State the Game ID and title on its own line so it's easy to copy
- Give the day/time and confirm it fits a free slot
- Explain in 2–3 sentences specifically WHY this matches the user's demonstrated tastes — cite concrete things from their schedule
- Note ticket availability so they know if they need to act fast

Be opinionated and direct. Don't hedge. If something is a great fit, say so."""

    messages: list[dict] = [
        {
            "role": "user",
            "content": (
                f"Based on my schedule, suggest {count} events I'd love."
                + (f" Focus on {day}." if day else "")
                + (f" I prefer {event_type} events." if event_type else "")
                + " Be specific about why each one matches my tastes."
            ),
        }
    ]

    # --- Streaming agentic loop ---------------------------------------------
    client = _ant.Anthropic()

    print(f"\n{'─' * 64}")
    print(f"  AI Suggestions  ·  {len(scheduled)} events analyzed  ·  {count} recommendations")
    print(f"{'─' * 64}\n")

    MAX_TURNS = 12
    for _ in range(MAX_TURNS):
        with client.messages.stream(
            model="claude-opus-4-6",
            max_tokens=4096,
            system=system,
            tools=tools,
            messages=messages,
            thinking={"type": "adaptive"},
        ) as stream:
            for event in stream:
                if (
                    event.type == "content_block_delta"
                    and event.delta.type == "text_delta"
                ):
                    print(event.delta.text, end="", flush=True)
            final = stream.get_final_message()

        messages.append({"role": "assistant", "content": final.content})

        if final.stop_reason != "tool_use":
            break

        # Execute tool calls and feed results back
        tool_results = []
        for block in final.content:
            if block.type == "tool_use":
                print(f"\n\n  [{_tool_label(block.name, block.input)}]\n", flush=True)
                if block.name == "search_events":
                    result = _ai_search_events(block.input, ids, idx, events)
                elif block.name == "get_event_details":
                    result = _ai_get_event_details(block.input.get("game_id", ""), ids, idx)
                else:
                    result = f"Unknown tool: {block.name}"
                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": block.id,
                    "content": result,
                })
        messages.append({"role": "user", "content": tool_results})

    print(f"\n\n{'─' * 64}")
    print("  Use 'schedule add <GAME_ID>' to add any of these to your schedule.")
    print(f"{'─' * 64}\n")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="GenCon 2026 event downloader and search tool"
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    # download
    dl = sub.add_parser("download", help="Download (or refresh) the events CSV")
    dl.add_argument("--force", action="store_true", help="Re-download even if CSV exists")

    # search
    se = sub.add_parser("search", help="Search events")
    se.add_argument("query", nargs="?", default="", help="Text to search for")
    se.add_argument("-t", "--type", dest="event_type", help="Filter by event type (e.g. RPG, BGM)")
    se.add_argument("-d", "--day", help="Filter by day/date substring (e.g. Wednesday, 08/06)")
    se.add_argument("-s", "--system", help="Filter by game system")
    se.add_argument("-k", "--tickets", type=int, dest="min_tickets", help="Minimum available tickets")
    se.add_argument("-n", "--limit", type=int, default=25, help="Max results to show (default: 25)")

    # types
    sub.add_parser("types", help="List all event types with counts")

    # show
    sh = sub.add_parser("show", help="Show full details for an event")
    sh.add_argument("game_id", help="Game ID (e.g. RPG26110023)")

    # schedule
    sc = sub.add_parser("schedule", help="Manage your personal event schedule")
    sc_sub = sc.add_subparsers(dest="sc_cmd", required=True)

    sc_add = sc_sub.add_parser("add", help="Add an event to your schedule")
    sc_add.add_argument("game_id", help="Game ID to add")
    sc_add.add_argument("--force", action="store_true", help="Add even if it conflicts")

    sc_rm = sc_sub.add_parser("remove", help="Remove an event from your schedule")
    sc_rm.add_argument("game_id", help="Game ID to remove")

    sc_lst = sc_sub.add_parser("list", help="Show your schedule as a day-by-day agenda")
    sc_lst.add_argument("-d", "--day", help="Filter to a specific day (e.g. Thu, Fri)")

    sc_chk = sc_sub.add_parser("check", help="Check if an event conflicts without adding it")
    sc_chk.add_argument("game_id", help="Game ID to check")

    sc_alt = sc_sub.add_parser("alternatives", help="Show all timeslots for an event's title")
    sc_alt.add_argument("game_id", help="Game ID to look up alternatives for")

    sc_sub.add_parser("clear", help="Remove all events from your schedule")

    sc_sug = sc_sub.add_parser("suggest", help="Suggest events that fit gaps in your schedule")
    sc_sug.add_argument("-d", "--day", help="Limit to a specific day (e.g. Thu, Fri, Sat)")
    sc_sug.add_argument("-t", "--type", dest="event_type", help="Filter by event type (e.g. RPG, BGM)")
    sc_sug.add_argument("-s", "--system", help="Filter by game system")
    sc_sug.add_argument("--min", dest="min_dur", type=float, help="Minimum event duration in hours")
    sc_sug.add_argument("--max", dest="max_dur", type=float, help="Maximum event duration in hours")
    sc_sug.add_argument("-k", "--tickets", type=int, dest="min_tickets", help="Minimum available tickets")
    sc_sug.add_argument("-n", "--per-gap", type=int, default=5, help="Suggestions per gap (default: 5)")

    sc_ai = sc_sub.add_parser("ai-suggest", help="Use Claude AI to suggest events tailored to your tastes")
    sc_ai.add_argument("-n", "--count", type=int, default=5, help="Number of suggestions (default: 5)")
    sc_ai.add_argument("-d", "--day", help="Limit to a specific day (e.g. Thu, Fri)")
    sc_ai.add_argument("-t", "--type", dest="event_type", help="Prefer a specific event type (e.g. RPG, BGM)")

    args = parser.parse_args()

    if args.cmd == "download":
        download(force=args.force)
    elif args.cmd == "search":
        search(
            query=args.query,
            event_type=args.event_type,
            day=args.day,
            system=args.system,
            min_tickets=args.min_tickets,
            limit=args.limit,
        )
    elif args.cmd == "types":
        show_types()
    elif args.cmd == "show":
        show_event(args.game_id)
    elif args.cmd == "schedule":
        if args.sc_cmd == "add":
            schedule_add(args.game_id, force=args.force)
        elif args.sc_cmd == "remove":
            schedule_remove(args.game_id)
        elif args.sc_cmd == "list":
            schedule_list(day=args.day)
        elif args.sc_cmd == "check":
            schedule_check(args.game_id)
        elif args.sc_cmd == "alternatives":
            schedule_alternatives(args.game_id)
        elif args.sc_cmd == "clear":
            schedule_clear()
        elif args.sc_cmd == "suggest":
            schedule_suggest(
                day=args.day,
                event_type=args.event_type,
                system=args.system,
                min_dur=args.min_dur,
                max_dur=args.max_dur,
                min_tickets=args.min_tickets,
                per_gap=args.per_gap,
            )
        elif args.sc_cmd == "ai-suggest":
            schedule_ai_suggest(
                count=args.count,
                day=getattr(args, 'day', None),
                event_type=getattr(args, 'event_type', None),
            )


if __name__ == "__main__":
    main()
