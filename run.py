#!/usr/bin/env python
"""Start RoadLens.

    python run.py                 # http://127.0.0.1:8000
    python run.py --port 9000
    python run.py --reload        # auto-reload while developing
"""
import argparse
import sys
import webbrowser
from threading import Timer


def _utf8_console() -> None:
    """Make console output safe on a legacy Windows code page.

    A default Windows console runs cp1252 and raises UnicodeEncodeError on any
    character outside it — an arrow in a startup banner is enough to abort the
    process before the server ever starts. Reconfiguring to UTF-8 with a
    replacing error handler makes output degrade instead of crash.
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError, OSError):
            pass


def main() -> int:
    _utf8_console()
    ap = argparse.ArgumentParser(description="Run the RoadLens server.")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--reload", action="store_true", help="auto-reload on code changes")
    ap.add_argument("--no-browser", action="store_true", help="do not open a browser")
    args = ap.parse_args()

    try:
        import uvicorn
    except ImportError:
        print("Dependencies are missing. Install them with:\n"
              "    pip install -r requirements.txt", file=sys.stderr)
        return 1

    url = f"http://{'127.0.0.1' if args.host == '0.0.0.0' else args.host}:{args.port}/"
    print(f"\n  RoadLens  →  {url}\n  Ctrl+C to stop.\n")

    if not args.no_browser and not args.reload:
        Timer(1.4, lambda: webbrowser.open(url)).start()

    uvicorn.run("backend.main:app", host=args.host, port=args.port,
                reload=args.reload, log_level="info")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
