#!/usr/bin/env python3
"""tt-bridge experience script template (stdlib only, non-interactive).

Contract:
    python3 script.py --url <url> [--json] [--expect <selector>] [-- <args>]
    env: TT_BRIDGE_URL, TT_BRIDGE_ENTRY_ID, TT_BRIDGE_EXPERIENCE_DIR
    stdout: {"ok": true|false, "steps": [...], "evidence": {...}}
    exit:   0 goal reached, 1 goal not reached, 2 usage error / precondition missing

This template implements the contract end to end with a deliberately small,
honest goal: confirm the tab is on the expected URL and that the page reached
the state identified by --expect. Replace the marked site-flow block with the
real steps, and keep the final assertion tied to an observable signal.

Rules:
    - never prompt for input; never open a TTY
    - never print secrets, cookies or tokens (not in JSON, steps, or evidence)
    - prefer role/text locators over brittle CSS chains
    - a click that did not error is NOT success; assert the resulting state
"""

import argparse
import json
import os
import subprocess
import sys
import time

EXIT_OK = 0
EXIT_MISS = 1
EXIT_PRECONDITION = 2

# Set to True only after replacing the site-flow block below. Until then the
# script exits 2, so a copied-but-unedited template can never record a false hit.
STEPS_IMPLEMENTED = False

# Fill this in when you replace the site-flow block: a selector (or text) that
# proves the goal was reached. `--expect` overrides it; env
# TT_BRIDGE_EXPECT_SELECTOR is the last fallback. Keep it observable, not a
# "page loaded" proxy.
GOAL_SELECTOR = None


class PreconditionError(RuntimeError):
    """Raised when the script cannot even start (bad args, wrong page)."""


def tt_bridge(*args, timeout=60):
    """Run `tt-bridge <args>` and return the decoded stdout value.

    `eval` prints the JS return value directly, so a JS expression returning an
    object yields a dict here; a JS expression returning a JSON string yields
    that string (see `as_object`).
    """
    cmd = ["tt-bridge", *map(str, args)]
    if "--json" not in cmd:
        cmd.append("--json")
    proc = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=timeout,
        stdin=subprocess.DEVNULL,
    )
    raw = (proc.stdout or "").strip()
    if proc.returncode != 0:
        raise RuntimeError(f"tt-bridge failed ({proc.returncode}): {raw or proc.stderr.strip()}")
    try:
        return json.loads(raw if raw else "{}")
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"tt-bridge returned non-JSON: {raw[:200]}") from exc


def as_object(value):
    """Decode a JSON string returned by a JS expression; pass dicts through."""
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return {"text": value}
        return parsed if isinstance(parsed, dict) else {"value": parsed}
    return {"value": value}


def page_state():
    return as_object(tt_bridge(
        "eval",
        "({url: document.URL, title: document.title, ready: document.readyState})",
    ))


def wait_for_selector(selector, timeout=10.0, interval=0.25):
    """Poll until the selector matches a visible element; return the element text."""
    expression = (
        "(() => { const el = document.querySelector(%s);"
        " if (!el) return null;"
        " return {text: (el.innerText || el.textContent || '').trim().slice(0, 200),"
        " tag: el.tagName.toLowerCase()}; })()" % json.dumps(selector)
    )
    deadline = time.monotonic() + timeout
    while True:
        found = as_object(tt_bridge("eval", expression))
        if found.get("tag"):
            return found
        if time.monotonic() >= deadline:
            return None
        time.sleep(interval)


def parse_args(argv):
    parser = argparse.ArgumentParser(
        description="<one line: what this script achieves on the site>",
        epilog=(
            "Reads TT_BRIDGE_URL / TT_BRIDGE_ENTRY_ID / TT_BRIDGE_EXPERIENCE_DIR. "
            "Extra args after `--` are available in `args.extra`."
        ),
    )
    parser.add_argument("--url", default=os.environ.get("TT_BRIDGE_URL"), help="target page URL")
    parser.add_argument("--json", action="store_true", help="machine-readable stdout (always emitted)")
    parser.add_argument("--expect", default=None,
                        help="selector that must become visible for the goal to count as reached")
    parser.add_argument("extra", nargs=argparse.REMAINDER, help="args forwarded by `experience run -- ...`")
    args, unknown = parser.parse_known_args(argv)
    # `experience run -- …` forwards args without the separator, so unknown flags
    # must be tolerated (and exposed) rather than rejected with exit 2.
    args.extra = [*args.extra, *unknown]
    if not args.url:
        parser.error("--url is required (or set TT_BRIDGE_URL)")
    return args


def url_base(url):
    """Literal prefix of a URL or glob pattern (entries may declare `/**`)."""
    base = url.split("?")[0].split("#")[0]
    base = base.split("*")[0]
    return base.rstrip("/")


def run_flow(args, steps, evidence):
    """Replace this body with the site-specific steps; keep the assertions."""
    page = page_state()
    steps.append({"action": "read page", "ok": True, "title": page.get("title")})
    evidence["url"] = page.get("url", "")
    evidence["title"] = page.get("title", "")
    evidence["entry"] = os.environ.get("TT_BRIDGE_ENTRY_ID", "")

    current = page.get("url") or ""
    if not current.startswith(url_base(args.url)):
        raise PreconditionError(f"unexpected page: {current} (expected {args.url})")

    # --- site flow: replace below -------------------------------------
    # Example: click/focus/type through tt_bridge(...) and assert after each
    # state change. Text/locator-first is encouraged:
    #   tt_bridge("click", 'role=button[name="Respond"]')
    #   tt_bridge("type", "one paragraph")
    # --- site flow: replace above -------------------------------------
    if not STEPS_IMPLEMENTED:
        raise PreconditionError("site flow not implemented: edit run_flow() and set STEPS_IMPLEMENTED = True")

    goal = args.expect or GOAL_SELECTOR or os.environ.get("TT_BRIDGE_EXPECT_SELECTOR")
    if not goal:
        raise PreconditionError(
            "no goal configured: set GOAL_SELECTOR, pass --expect <selector>, "
            "or set TT_BRIDGE_EXPECT_SELECTOR"
        )
    found = wait_for_selector(goal)
    steps.append({"action": f"wait for {goal}", "ok": bool(found)})
    if not found:
        raise RuntimeError(f"expected element never appeared: {goal}")
    evidence["matched"] = found
    evidence["verified"] = True


def main(argv=None):
    args = parse_args(sys.argv[1:] if argv is None else argv)
    steps = []
    evidence = {}

    try:
        run_flow(args, steps, evidence)
    except PreconditionError as exc:
        print(json.dumps({
            "ok": False,
            "steps": steps,
            "evidence": evidence,
            "error": str(exc),
        }, ensure_ascii=False))
        if not args.json:
            print(f"PRECONDITION: {exc}", file=sys.stderr)
        return EXIT_PRECONDITION
    except subprocess.TimeoutExpired as exc:
        print(json.dumps({
            "ok": False,
            "steps": steps,
            "evidence": evidence,
            "error": f"timeout: {exc}",
        }, ensure_ascii=False))
        return EXIT_MISS
    except RuntimeError as exc:
        print(json.dumps({
            "ok": False,
            "steps": steps,
            "evidence": evidence,
            "error": str(exc),
        }, ensure_ascii=False))
        if not args.json:
            print(f"FAILED: {exc}", file=sys.stderr)
        return EXIT_MISS

    print(json.dumps({"ok": True, "steps": steps, "evidence": evidence}, ensure_ascii=False))
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
