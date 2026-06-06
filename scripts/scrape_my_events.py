#!/usr/bin/env python3
"""
Scrape registered event IDs from gencon.com/my_packets and print them,
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

BASE       = "https://www.gencon.com"
GAME_ID_RE = re.compile(r'\b[A-Z]{2,6}26[A-Z0-9]{2,}\b')


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


def fetch_ids(session: requests.Session) -> list[str]:
    r = session.get(f"{BASE}/my_packets", timeout=15)
    if "/login" in r.url:
        raise RuntimeError("Redirected to login — session not authenticated")
    r.raise_for_status()
    return list(dict.fromkeys(GAME_ID_RE.findall(r.text)))


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

    print("Fetching /my_packets…", file=sys.stderr)
    ids = fetch_ids(session)

    if not ids:
        print("No registered event IDs found.", file=sys.stderr)
        sys.exit(1)

    print(f"Found {len(ids)} event(s):", file=sys.stderr)
    for gid in ids:
        print(gid)


if __name__ == "__main__":
    main()
