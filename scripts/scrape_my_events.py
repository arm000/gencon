#!/usr/bin/env python3
"""
Scrape registered event IDs from gencon.com and print them,
one per line, to stdout.

Credentials are read from .env (GENCON_EMAIL / GENCON_PASSWORD) or
prompted interactively if not set.
"""

import getpass
import os
import re
import sys

import requests
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))

BASE = "https://www.gencon.com"


def login(session: requests.Session, email: str, password: str) -> None:
    r = session.get(f"{BASE}/login", timeout=15)
    r.raise_for_status()
    m = re.search(r'name="authenticity_token"[^>]*value="([^"]+)"', r.text)
    if not m:
        raise RuntimeError("Could not find CSRF token on login page")

    r = session.post(
        f"{BASE}/users/sign_in",
        data={
            "authenticity_token": m.group(1),
            "user[email]":        email,
            "user[password]":     password,
            "user[remember_me]":  "0",
            "commit":             "Sign In",
        },
        timeout=15,
        allow_redirects=True,
    )
    r.raise_for_status()
    if "/login" in r.url or "Invalid Email or password" in r.text:
        raise RuntimeError("Login failed — check your email/password")
    print(f"Logged in as {email}", file=sys.stderr)


def get_contact_id(session: requests.Session) -> str:
    r = session.get(f"{BASE}/profile", timeout=15)
    if "/login" in r.url:
        raise RuntimeError("Redirected to login — session not authenticated")
    r.raise_for_status()
    m = re.search(r"user-id=['\"](\d+)['\"]", r.text) or re.search(r'"userId":(\d+)', r.text)
    if not m:
        raise RuntimeError("Could not find contact ID on profile page")
    return m.group(1)


def fetch_ids(session: requests.Session, contact_id: str) -> list[int]:
    event_ids: list[int] = []
    page, total_pages = 1, 1
    while page <= total_pages:
        r = session.get(
            f"{BASE}/api/v2/schedule",
            params={"contact_id": contact_id, "page": page},
            headers={"Accept": "application/json"},
            timeout=15,
        )
        r.raise_for_status()
        data = r.json()
        for ev in data.get("data", []):
            if ev.get("event_id"):
                event_ids.append(ev["event_id"])
        total_pages = data.get("total_num_of_pages", 1)
        page += 1
    return list(dict.fromkeys(event_ids))


def main() -> None:
    email    = os.environ.get("GENCON_EMAIL")    or input("GenCon email: ")
    password = os.environ.get("GENCON_PASSWORD") or getpass.getpass("GenCon password: ")

    session = requests.Session()
    session.headers["User-Agent"] = (
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    )

    print("Logging in…", file=sys.stderr)
    login(session, email, password)

    print("Fetching contact ID…", file=sys.stderr)
    contact_id = get_contact_id(session)
    print(f"Contact ID: {contact_id}", file=sys.stderr)

    print("Fetching schedule…", file=sys.stderr)
    ids = fetch_ids(session, contact_id)

    if not ids:
        print("No registered event IDs found.", file=sys.stderr)
        sys.exit(1)

    print(f"Found {len(ids)} event(s):", file=sys.stderr)
    for eid in ids:
        print(eid)


if __name__ == "__main__":
    main()
