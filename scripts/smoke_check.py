#!/usr/bin/env python
"""Post-deploy smoke check: is the running server actually useful?

A 200 from /api/health is not enough. A broken seeder, a failed migration or an
empty database all return a perfectly healthy 200 while the application shows
the user nothing. This asserts the things that make the app worth serving.

    python scripts/smoke_check.py [--url http://127.0.0.1:8000] [--wait 40]

Exit code 0 if healthy, 1 otherwise. Used by CI and safe to run against any
deployment.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request


def _utf8_console() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError, OSError):
            pass


def get(url: str, timeout: float = 15.0):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return r.status, json.load(r)


def wait_for(base: str, seconds: int) -> bool:
    deadline = time.time() + seconds
    while time.time() < deadline:
        try:
            if get(f"{base}/api/health", timeout=4)[0] == 200:
                return True
        except (urllib.error.URLError, OSError, json.JSONDecodeError, TimeoutError):
            pass
        time.sleep(1)
    return False


def main() -> int:
    _utf8_console()
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--url", default="http://127.0.0.1:8000")
    ap.add_argument("--wait", type=int, default=40, help="seconds to wait for startup")
    args = ap.parse_args()
    base = args.url.rstrip("/")

    if not wait_for(base, args.wait):
        print(f"FAIL  server never became healthy at {base}", file=sys.stderr)
        return 1

    failures: list[str] = []

    def check(label: str, ok: bool, detail: str = "") -> None:
        print(f"{'ok  ' if ok else 'FAIL'}  {label}{f' — {detail}' if detail else ''}")
        if not ok:
            failures.append(label)

    try:
        _, health = get(f"{base}/api/health")
        check("health endpoint", health.get("status") == "ok", health.get("engine", ""))

        _, meta = get(f"{base}/api/meta")
        check("taxonomy served", bool(meta.get("damage_types")),
              f"{len(meta.get('damage_types', {}))} distress types")
        check("weights sum to 1",
              abs(sum(meta.get("weights", {}).values()) - 1.0) < 1e-9)

        _, segs = get(f"{base}/api/segments")
        count = segs.get("count", 0)
        check("network populated", count >= 20, f"{count} segments")

        bands = {s.get("band_code") for s in segs.get("segments", [])}
        bands.discard(None)
        # If every road is critical, the ranking conveys nothing.
        check("priority spread", len(bands) >= 3, ", ".join(sorted(bands)))

        scored = [s for s in segs.get("segments", []) if s.get("rpi") is not None]
        check("segments are scored", len(scored) >= 20, f"{len(scored)} scored")
        check("scores in range",
              all(0 <= s["rpi"] <= 100 and 0 <= (s["pci"] or 0) <= 100 for s in scored))

        _, analytics = get(f"{base}/api/analytics")
        totals = analytics.get("totals", {})
        check("analytics computed", totals.get("segments", 0) > 0,
              f"mean PCI {totals.get('avg_pci')}")

        _, budget = get(f"{base}/api/budget?amount=150000000")
        check("budget allocates", budget.get("funded_count", 0) > 0,
              f"{budget.get('funded_count')} funded")
        check("budget never overspends",
              budget.get("allocated", 0) <= 150_000_000)

        status, _ = get(f"{base}/api/health")
        with urllib.request.urlopen(base + "/", timeout=10) as r:
            check("frontend served", r.status == 200 and b"RoadLens" in r.read(4096))

    except (urllib.error.URLError, OSError, json.JSONDecodeError) as exc:
        print(f"FAIL  request error: {exc}", file=sys.stderr)
        return 1

    print()
    if failures:
        print(f"{len(failures)} check(s) failed: {', '.join(failures)}", file=sys.stderr)
        return 1
    print("All checks passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
