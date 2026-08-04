#!/usr/bin/env python3
"""
How many people actually got this, and which numbers are lying.

Three things are worth knowing and only one of them is straightforward.

**Release downloads** are exact. GitHub counts every asset fetch, per asset, and
keeps it forever.

**Plugin installs cannot be counted at all.** A Claude Code marketplace is a git
repository; `/plugin marketplace add` is a clone. There is no telemetry, no
callback, nothing to count — so plugin adoption is invisible except as clone
traffic, which brings us to the number that lies.

**Clone traffic counts CI.** Every workflow checkout is a clone. On a day with ten
merged pull requests and three jobs each, that is thirty clones with nothing to do
with adoption — the first reading of this repository was 520 clones and 131
uniques against *three* unique page views. Reported here with that warning
attached, because 131 looks like people and is not.

**Traffic is a fourteen-day window.** GitHub discards it after that. So this
appends a dated snapshot to a JSONL file: run it occasionally and the history
exists; never run it and those two weeks are gone for good.

Usage:
    python3 tools/release/adoption.py                 # print, and snapshot
    python3 tools/release/adoption.py --no-snapshot   # print only

Needs `gh` authenticated. Traffic requires push access to the repository.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

REPO = "TrizenX/agent-pet"


def gh(path: str) -> object | None:
    """One API read. Returns None rather than raising: a missing permission or a
    repository with no releases is a normal answer, not a failure."""
    # No trailing slash when path is empty: `repos/owner/name/` is not the same
    # endpoint as `repos/owner/name`, and the first quietly returns nothing —
    # which showed up as `stars ?` on a repository that plainly has a star count.
    endpoint = f"repos/{REPO}/{path}" if path else f"repos/{REPO}"
    r = subprocess.run(
        ["gh", "api", endpoint],
        capture_output=True,
        text=True,
    )
    if r.returncode != 0:
        return None
    try:
        return json.loads(r.stdout)
    except json.JSONDecodeError:
        return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-snapshot", action="store_true")
    ap.add_argument("--out", default="artifacts/adoption.jsonl")
    args = ap.parse_args()

    repo = gh("") or {}
    releases = gh("releases") or []
    clones = gh("traffic/clones")
    views = gh("traffic/views")

    downloads: list[dict] = []
    for rel in releases if isinstance(releases, list) else []:
        for asset in rel.get("assets", []):
            downloads.append(
                {
                    "release": rel.get("tag_name"),
                    "asset": asset.get("name"),
                    "downloads": asset.get("download_count", 0),
                    "prerelease": rel.get("prerelease", False),
                }
            )
    total_downloads = sum(d["downloads"] for d in downloads)

    print(f"{REPO}\n")
    if not releases:
        print("downloads   no releases yet — nothing to count")
        print("            (`git tag v0.1.0 && git push origin v0.1.0` publishes one)")
    else:
        print(f"downloads   {total_downloads} across {len(downloads)} asset(s)")
        for d in sorted(downloads, key=lambda x: -x["downloads"]):
            tag = f"{d['release']}{' (prerelease)' if d['prerelease'] else ''}"
            print(f"              {d['downloads']:6d}  {d['asset']}  {tag}")

    print(f"stars       {repo.get('stargazers_count', '?')}")
    print(f"forks       {repo.get('forks_count', '?')}")
    print(f"watchers    {repo.get('subscribers_count', '?')}")

    if views:
        print(f"views       {views['count']} ({views['uniques']} unique) over 14 days")
    else:
        print("views       unavailable — traffic needs push access")

    if clones:
        print(f"clones      {clones['count']} ({clones['uniques']} unique) over 14 days")
        print("            ^ includes every CI checkout. Not adoption.")
    else:
        print("clones      unavailable — traffic needs push access")

    print("\nplugin installs are not measurable: a marketplace is a git repo,")
    print("so `/plugin marketplace add` is a clone and nothing reports back.")

    if args.no_snapshot:
        return 0

    row = {
        "t": time.time(),
        "date": time.strftime("%Y-%m-%d"),
        "downloads_total": total_downloads,
        "downloads": downloads,
        "stars": repo.get("stargazers_count"),
        "forks": repo.get("forks_count"),
        "watchers": repo.get("subscribers_count"),
        "views_14d": views["count"] if views else None,
        "views_uniques_14d": views["uniques"] if views else None,
        "clones_14d": clones["count"] if clones else None,
        "clones_uniques_14d": clones["uniques"] if clones else None,
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("a") as fh:
        fh.write(json.dumps(row) + "\n")
    print(f"\nsnapshot appended to {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
