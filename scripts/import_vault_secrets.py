#!/usr/bin/env python3
"""
Bulk-import secrets into shujian-backend's vault.

Two ways to call it:

    # 1. From a file (typical first-time onboarding):
    python3 scripts/import_vault_secrets.py \\
        --backend https://backend-production-fb29.up.railway.app \\
        --user admin --password admin \\
        --prefix onion. \\
        --file ../onion-agent/.env

    # 2. From stdin (paste-and-go, useful for bridge / dashboard secrets):
    pbpaste | python3 scripts/import_vault_secrets.py \\
        --user admin --password admin --prefix bridge.

Behaviour:
  * Parses .env-style KEY=VALUE lines (quoted values + escapes supported).
  * Skips KEYs that look like non-secret constants (BASE_URL, *_PUBLIC_URL,
    things starting with `https://`) — overridable with --no-skip-public.
  * Maps KEY -> vault name with a deterministic rule:
        FOO_BAR_BAZ            -> <prefix>foo.bar_baz
        DINGTALK_CLIENT_SECRET -> <prefix>dingtalk.client_secret
        R2_SECRET_ACCESS_KEY   -> <prefix>r2.secret_access_key
    First underscore becomes a dot for namespacing; rest stay as-is.
  * Auto-detects `kind`: r2_secret / oauth / webhook / jwt_signing / env.
  * Idempotent: vault upsert API does INSERT ... ON CONFLICT DO UPDATE.
  * --dry-run prints the plan without touching the network.

Exit code 0 if every secret landed; non-zero otherwise (with a per-row
report at the bottom).
"""

from __future__ import annotations

import argparse
import getpass
import json
import re
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass


# ──────────────────────────────────────────────────────────────────────────────
# .env parser. We deliberately don't import python-dotenv to keep this script
# zero-dep — it's also exactly the same grammar the dashboard's TS parser
# implements, so behaviour stays in sync.
# ──────────────────────────────────────────────────────────────────────────────

ENV_LINE = re.compile(
    r"""^\s*
        (?:export\s+)?           # optional `export KEY=...`
        (?P<key>[A-Za-z_][A-Za-z0-9_]*)
        \s*=\s*
        (?P<rawvalue>.*?)        # everything after = up to optional comment
        \s*(?:\#.*)?$            # trailing #comment (only outside quotes)
    """,
    re.VERBOSE,
)


def parse_dotenv(text: str) -> list[tuple[str, str]]:
    """Return list of (key, value) tuples, skipping blanks and comments."""
    pairs: list[tuple[str, str]] = []
    for raw in text.splitlines():
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        m = ENV_LINE.match(raw)
        if not m:
            continue
        key = m.group("key")
        val = m.group("rawvalue")
        # Strip matching quotes; handle \n / \" / \\ inside double-quoted.
        if len(val) >= 2 and val[0] == val[-1] and val[0] in ('"', "'"):
            quote = val[0]
            val = val[1:-1]
            if quote == '"':
                val = (
                    val.replace("\\n", "\n")
                    .replace("\\r", "\r")
                    .replace("\\t", "\t")
                    .replace('\\"', '"')
                    .replace("\\\\", "\\")
                )
        pairs.append((key, val))
    return pairs


# ──────────────────────────────────────────────────────────────────────────────
# Naming + kind detection.
# ──────────────────────────────────────────────────────────────────────────────

PUBLIC_KEY_PATTERNS = (
    "_BASE_URL",
    "_PUBLIC_URL",
    "_PUBLIC_KEY",   # e.g. langfuse public key — debatable, but it's truly public
    "_HOST",
    # Note: "_URL" alone is intentionally NOT here. DATABASE_URL,
    # WEBHOOK_URL, etc. are the canonical secret-bearing URLs.
)


def looks_public(key: str, value: str) -> bool:
    """Best-effort detection of "this isn't really a secret"."""
    upper = key.upper()
    if any(upper.endswith(suf) for suf in PUBLIC_KEY_PATTERNS):
        return True
    # Plain http(s) constants are usually base URLs / docs; secret-bearing
    # URLs (DATABASE_URL, *.webhook URLs that include tokens) start with
    # postgresql:// or contain credentials, so this is conservative.
    if value.startswith(("http://", "https://")) and len(value) < 200 and "@" not in value:
        return True
    return False


def to_vault_name(key: str, prefix: str) -> str:
    """KEY_FOO_BAR -> <prefix>key.foo_bar.

    If the first underscore-segment of the lowercased key matches the
    prefix word (e.g. KEY=ONION_API_KEY with prefix='onion.'), drop it
    to avoid `onion.onion.api_key` style names.
    """
    lower = key.lower()
    if "_" in lower:
        head, tail = lower.split("_", 1)
        prefix_word = prefix.rstrip(".").lower() if prefix else ""
        if head == prefix_word:
            # ONION_API_KEY -> api_key -> onion.api_key
            return f"{prefix}{tail}"
        return f"{prefix}{head}.{tail}"
    return f"{prefix}{lower}"


KIND_RULES: list[tuple[re.Pattern[str], str]] = [
    # r2 namespace anywhere in the name (anchor failed when prefix was 'onion.')
    (re.compile(r"(^|\.)r2\."), "r2_secret"),
    (re.compile(r"\.(bot_configs?|webhook|hook)$"), "webhook"),
    (re.compile(r"\.(jwt_secret|signing_key)$"), "jwt_signing"),
    # Generic credential bucket — keep this LAST so r2.secret_access_key
    # gets r2_secret instead.
    (re.compile(r"\.(client_secret|client_id|api_key|access_token)$"), "oauth"),
]


def detect_kind(name: str) -> str:
    for pattern, kind in KIND_RULES:
        if pattern.search(name):
            return kind
    return "env"


# ──────────────────────────────────────────────────────────────────────────────
# Backend client. Tiny stdlib HTTP wrapper so the script has no pip deps.
# ──────────────────────────────────────────────────────────────────────────────


@dataclass
class Backend:
    base: str
    token: str | None = None

    def _request(self, path: str, method: str = "GET", body: dict | None = None) -> dict | list:
        url = self.base.rstrip("/") + path
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("content-type", "application/json")
        if self.token:
            req.add_header("authorization", f"Bearer {self.token}")
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                payload = resp.read().decode("utf-8")
                return json.loads(payload) if payload else {}
        except urllib.error.HTTPError as e:
            payload = e.read().decode("utf-8", errors="replace")
            try:
                payload = json.loads(payload)
            except Exception:
                pass
            raise RuntimeError(f"{method} {path} → HTTP {e.code}: {payload}") from e
        except urllib.error.URLError as e:
            raise RuntimeError(f"{method} {path} → network error: {e}") from e

    def login(self, identifier: str, password: str) -> dict:
        r = self._request(
            "/v1/auth/login",
            method="POST",
            body={"identifier": identifier, "password": password},
        )
        assert isinstance(r, dict)
        self.token = r["token"]
        return r

    def kek_status(self) -> dict:
        r = self._request("/v1/vault/_admin/kek")
        assert isinstance(r, dict)
        return r

    def list_secrets(self) -> list[dict]:
        r = self._request("/v1/vault/secrets")
        assert isinstance(r, list)
        return r

    def upsert_secret(
        self,
        name: str,
        value: str,
        kind: str,
        description: str | None = None,
    ) -> dict:
        r = self._request(
            "/v1/vault/secrets",
            method="POST",
            body={"name": name, "value": value, "kind": kind, "description": description},
        )
        assert isinstance(r, dict)
        return r


# ──────────────────────────────────────────────────────────────────────────────
# Plan + execute.
# ──────────────────────────────────────────────────────────────────────────────


@dataclass
class PlanRow:
    src_key: str
    name: str
    kind: str
    value: str
    will_skip_reason: str | None = None


def build_plan(
    pairs: list[tuple[str, str]],
    prefix: str,
    skip_public: bool,
    skip_keys: set[str],
) -> list[PlanRow]:
    plan: list[PlanRow] = []
    for key, val in pairs:
        if key in skip_keys:
            continue
        skip = None
        if skip_public and looks_public(key, val):
            skip = "looks public/non-secret (override with --no-skip-public)"
        if not val:
            skip = "empty value"
        name = to_vault_name(key, prefix)
        kind = detect_kind(name)
        plan.append(PlanRow(src_key=key, name=name, kind=kind, value=val, will_skip_reason=skip))
    return plan


def mask(value: str) -> str:
    if len(value) <= 6:
        return "·" * len(value)
    return value[:3] + "…" + value[-3:] + f" ({len(value)} chars)"


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--backend", default="https://backend-production-fb29.up.railway.app")
    p.add_argument("--user", default="admin")
    p.add_argument("--password", default=None,
                   help="if omitted, prompt OR read SHUJIAN_BACKEND_PASSWORD env")
    p.add_argument("--file", default="-",
                   help="path to .env-style file, or '-' for stdin (default)")
    p.add_argument("--prefix", default="onion.",
                   help="vault name prefix; default 'onion.' for the onion-agent .env")
    p.add_argument("--skip", action="append", default=[],
                   help="source KEY to skip (can repeat)")
    p.add_argument("--no-skip-public", action="store_true",
                   help="store *_BASE_URL / *_PUBLIC_URL / http(s) constants too")
    p.add_argument("--dry-run", action="store_true",
                   help="print the plan, don't write to the vault")
    p.add_argument("--description", default="imported via scripts/import_vault_secrets.py")
    args = p.parse_args()

    # Source text
    if args.file == "-":
        source_label = "<stdin>"
        text = sys.stdin.read()
    else:
        source_label = args.file
        with open(args.file, encoding="utf-8") as f:
            text = f.read()

    pairs = parse_dotenv(text)
    if not pairs:
        print(f"no KEY=VALUE pairs found in {source_label}", file=sys.stderr)
        return 2

    plan = build_plan(
        pairs,
        prefix=args.prefix,
        skip_public=not args.no_skip_public,
        skip_keys=set(args.skip),
    )

    # Pretty-print plan
    print(f"\nSource:   {source_label}")
    print(f"Prefix:   {args.prefix}")
    print(f"Backend:  {args.backend}")
    print(f"Total parsed: {len(pairs)}; planned writes: {sum(1 for r in plan if not r.will_skip_reason)}")
    print()
    print(f"{'SRC KEY':<26} {'→ VAULT NAME':<36} {'KIND':<14} VALUE")
    print("-" * 110)
    for r in plan:
        flag = "skip" if r.will_skip_reason else " "
        print(f"{flag:<2}{r.src_key:<24} {r.name:<36} {r.kind:<14} {mask(r.value)}")
        if r.will_skip_reason:
            print(f"   └─ skipped: {r.will_skip_reason}")
    print()

    if args.dry_run:
        print("--dry-run set, exiting without writes.")
        return 0

    # Auth
    password = args.password
    if not password:
        import os
        password = os.environ.get("SHUJIAN_BACKEND_PASSWORD")
    if not password:
        password = getpass.getpass(f"password for {args.user}: ")

    backend = Backend(base=args.backend)
    backend.login(args.user, password)
    kek = backend.kek_status()
    if not kek.get("configured"):
        print(f"FATAL: vault KEK not configured: {kek}", file=sys.stderr)
        return 3
    print(f"✓ logged in; KEK v{kek['active_version']} ({kek['source']}, fp={kek['fingerprint'][:8]})")

    existing = {s["name"]: s for s in backend.list_secrets()}

    ok, fail = 0, 0
    failures: list[tuple[str, str]] = []
    for r in plan:
        if r.will_skip_reason:
            continue
        action = "UPDATE" if r.name in existing else "CREATE"
        try:
            backend.upsert_secret(r.name, r.value, r.kind, args.description)
            print(f"  {action:<6} {r.name:<36} kind={r.kind}")
            ok += 1
        except Exception as e:  # noqa: BLE001
            print(f"  FAILED {r.name}: {e}", file=sys.stderr)
            failures.append((r.name, str(e)))
            fail += 1

    print()
    print(f"Done. {ok} written, {fail} failed.")
    if failures:
        print("\nFailures:")
        for name, msg in failures:
            print(f"  - {name}: {msg}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
