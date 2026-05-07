#!/usr/bin/env python3
"""
persona_sync.py — push a persona YAML (and its prerequisite scopes /
operator_refs) into shujian-backend.

Single source of truth: the YAML files under personas/. This script is
just a thin transport.

Usage:
  # Bootstrap everything the persona needs, then upsert the persona itself:
  python personas/scripts/persona_sync.py \\
      --backend https://backend-production-fb29.up.railway.app \\
      --user admin --password admin \\
      --bootstrap \\
      personas/onion_boss_analyst.yaml

  # Or just upsert the persona, assuming scopes already exist:
  python personas/scripts/persona_sync.py personas/onion_boss_analyst.yaml

Bootstrap mode walks the persona's `allowed_scopes` and:
  1. for each scope name X → reads personas/scopes/X.yaml (errors if missing)
  2. for any binding referencing operator_ref_key K → reads
     personas/operator_refs/K.yaml (errors if missing)
  3. upserts operator_refs first, then scopes, then the persona

Without --bootstrap, missing scopes produce a clear "create this first"
error and the script exits non-zero.

Exit codes:
  0  persona synced (and prereqs if --bootstrap)
  1  validation / network / auth error
  2  bad invocation
"""

from __future__ import annotations

import argparse
import getpass
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

try:
    import yaml
except ImportError:
    sys.stderr.write("ERROR: PyYAML required.  pip install pyyaml\n")
    sys.exit(2)

REPO_ROOT = Path(__file__).resolve().parents[2]
PERSONAS_DIR = REPO_ROOT / "personas"
SCOPES_DIR = PERSONAS_DIR / "scopes"
OPERATOR_REFS_DIR = PERSONAS_DIR / "operator_refs"


# ─────────────────────────────────────────────────────────────────────────────
# Tiny HTTP client (same shape as scripts/import_vault_secrets.py).
# ─────────────────────────────────────────────────────────────────────────────


class Backend:
    def __init__(self, base: str, tenant_id: str | None = None):
        self.base = base.rstrip("/")
        self.token: str | None = None
        self.tenant_id = tenant_id

    def _request(self, path: str, method: str = "GET", body: Any = None) -> Any:
        url = f"{self.base}{path}"
        data = None
        headers = {"accept": "application/json"}
        if self.token:
            headers["authorization"] = f"Bearer {self.token}"
        if self.tenant_id:
            headers["x-tenant-id"] = self.tenant_id
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["content-type"] = "application/json"
        req = urllib.request.Request(url, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
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
        self.token = r["token"]
        return r

    # Operator refs
    def list_operator_refs(self) -> list[dict]:
        return self._request("/v1/vault/operator-refs")

    def upsert_operator_ref(self, body: dict) -> dict:
        return self._request("/v1/vault/operator-refs", method="POST", body=body)

    # Scopes
    def list_scopes(self) -> list[dict]:
        return self._request("/v1/vault/scopes")

    def upsert_scope(self, body: dict) -> dict:
        return self._request("/v1/vault/scopes", method="POST", body=body)

    # Personas. Axum's nested router exposes the index without a trailing
    # slash (axum 0.8 stopped auto-redirecting); be explicit.
    def list_personas(self) -> list[dict]:
        return self._request("/v1/personas")

    def upsert_persona(self, body: dict) -> dict:
        return self._request("/v1/personas", method="POST", body=body)


# ─────────────────────────────────────────────────────────────────────────────
# YAML loaders
# ─────────────────────────────────────────────────────────────────────────────


def load_yaml(path: Path) -> dict:
    if not path.exists():
        raise FileNotFoundError(str(path))
    with path.open("r", encoding="utf-8") as fh:
        data = yaml.safe_load(fh)
    if not isinstance(data, dict):
        raise ValueError(f"{path}: top level must be a mapping")
    return data


def load_operator_ref(key: str) -> dict:
    path = OPERATOR_REFS_DIR / f"{key}.yaml"
    if not path.exists():
        raise FileNotFoundError(
            f"operator_ref '{key}' not found at {path.relative_to(REPO_ROOT)}"
        )
    data = load_yaml(path)
    for required in ("system", "operator_id", "operator_name"):
        if required not in data:
            raise ValueError(f"{path}: missing required field '{required}'")
    return data


def load_scope(name: str) -> dict:
    path = SCOPES_DIR / f"{name}.yaml"
    if not path.exists():
        raise FileNotFoundError(
            f"scope '{name}' not found at {path.relative_to(REPO_ROOT)}"
        )
    data = load_yaml(path)
    for required in ("name", "bindings"):
        if required not in data:
            raise ValueError(f"{path}: missing required field '{required}'")
    if data["name"] != name:
        raise ValueError(
            f"{path}: filename '{name}.yaml' doesn't match 'name: {data['name']}'"
        )
    return data


# ─────────────────────────────────────────────────────────────────────────────
# Sync logic
# ─────────────────────────────────────────────────────────────────────────────


def collect_referenced_operator_keys(scope_yaml: dict) -> list[str]:
    keys: list[str] = []
    primary = scope_yaml.get("primary_operator_ref_key")
    if isinstance(primary, str):
        keys.append(primary)
    for b in scope_yaml.get("bindings") or []:
        ref = b.get("operator_ref_key")
        if isinstance(ref, str):
            keys.append(ref)
    # de-dupe preserving order
    seen: set[str] = set()
    out: list[str] = []
    for k in keys:
        if k not in seen:
            seen.add(k)
            out.append(k)
    return out


def resolve_scope_bindings(scope_yaml: dict, operator_ref_id_by_key: dict[str, str]) -> dict:
    """
    Walk bindings and replace `operator_ref_key: K` with `operator_ref_id: <uuid>`.
    Same for the optional `primary_operator_ref_key`.
    Returns the body shape the backend's UpsertScopeBody expects.
    """
    new_bindings = []
    for b in scope_yaml.get("bindings") or []:
        b = dict(b)
        if "operator_ref_key" in b:
            key = b.pop("operator_ref_key")
            if key not in operator_ref_id_by_key:
                raise ValueError(
                    f"binding references operator_ref_key '{key}' but it wasn't loaded"
                )
            b["operator_ref_id"] = operator_ref_id_by_key[key]
        new_bindings.append(b)

    body: dict[str, Any] = {
        "name": scope_yaml["name"],
        "description": scope_yaml.get("description"),
        "bindings": new_bindings,
    }
    primary_key = scope_yaml.get("primary_operator_ref_key")
    if isinstance(primary_key, str):
        body["primary_operator_ref_id"] = operator_ref_id_by_key[primary_key]
    return body


def sync(args, persona_yaml: dict) -> int:
    backend = Backend(args.backend, tenant_id=args.tenant_id)
    print(f"→ login {args.user}@{args.backend}")
    backend.login(args.user, args.password)

    persona_slug = persona_yaml["slug"]
    allowed_scope_names: list[str] = persona_yaml.get("allowed_scopes") or []
    print(f"→ persona '{persona_slug}' references {len(allowed_scope_names)} scope(s)")

    # ── 1. Resolve / bootstrap operator_refs (only used by referenced scopes)
    operator_ref_id_by_key: dict[str, str] = {}
    if args.bootstrap:
        # Walk all referenced scopes' YAMLs to discover which operator_refs
        # we need before talking to the backend.
        operator_keys_needed: set[str] = set()
        for sn in allowed_scope_names:
            try:
                sy = load_scope(sn)
            except FileNotFoundError as e:
                sys.stderr.write(f"ERROR: {e}\n")
                return 1
            for k in collect_referenced_operator_keys(sy):
                operator_keys_needed.add(k)

        if operator_keys_needed:
            print(f"→ bootstrap operator_refs: {sorted(operator_keys_needed)}")
            existing_refs = {
                (r["system"], r["operator_id"]): r for r in backend.list_operator_refs()
            }
            for key in sorted(operator_keys_needed):
                ref_yaml = load_operator_ref(key)
                pair = (ref_yaml["system"], ref_yaml["operator_id"])
                if pair in existing_refs:
                    rid = existing_refs[pair]["id"]
                    print(f"  · {key:<28} already present  ({rid})")
                else:
                    body = {
                        "system": ref_yaml["system"],
                        "operator_id": ref_yaml["operator_id"],
                        "operator_name": ref_yaml["operator_name"],
                        "is_shadow": ref_yaml.get("is_shadow", True),
                        "role_hint": ref_yaml.get("role_hint"),
                    }
                    created = backend.upsert_operator_ref(body)
                    rid = created["id"]
                    print(f"  · {key:<28} CREATED          ({rid})")
                operator_ref_id_by_key[key] = rid
    else:
        # Non-bootstrap: just look up operator_refs by (system, operator_id)
        # for any operator-key references we'll encounter when loading
        # scopes (only matters when we're going to send scopes to backend
        # ourselves; with --bootstrap=False we don't, so skip this).
        pass

    # ── 2. Resolve / bootstrap scopes; map name → backend uuid
    print("→ resolving scopes")
    existing_scopes_by_name = {s["name"]: s for s in backend.list_scopes()}
    scope_id_by_name: dict[str, str] = {}
    for sn in allowed_scope_names:
        if args.bootstrap:
            sy = load_scope(sn)
            body = resolve_scope_bindings(sy, operator_ref_id_by_key)
            existing = existing_scopes_by_name.get(sn)
            if existing and json.dumps(existing.get("bindings"), sort_keys=True) == json.dumps(
                body["bindings"], sort_keys=True
            ) and existing.get("description") == body.get("description"):
                print(f"  · {sn:<32} unchanged")
                scope_id_by_name[sn] = existing["id"]
            else:
                created = backend.upsert_scope(body)
                action = "UPDATED" if existing else "CREATED"
                print(f"  · {sn:<32} {action}        ({created['id']})")
                scope_id_by_name[sn] = created["id"]
        else:
            existing = existing_scopes_by_name.get(sn)
            if not existing:
                sys.stderr.write(
                    f"ERROR: scope '{sn}' does not exist in backend.\n"
                    f"  Either pass --bootstrap (uses personas/scopes/{sn}.yaml),\n"
                    f"  or create it via the dashboard before re-running.\n"
                )
                return 1
            scope_id_by_name[sn] = existing["id"]
            print(f"  · {sn:<32} found            ({existing['id']})")

    # ── 3. Upsert the persona itself
    print(f"→ upserting persona '{persona_slug}'")
    existing_persona = next(
        (p for p in backend.list_personas() if p.get("slug") == persona_slug), None
    )
    body = {
        "slug": persona_slug,
        "display_name": persona_yaml["display_name"],
        "description": persona_yaml.get("description"),
        "system_prompt": persona_yaml["system_prompt"],
        "allowed_scopes": [scope_id_by_name[n] for n in allowed_scope_names],
        "cursor_settings": persona_yaml.get("cursor_settings", {}),
        "domain": persona_yaml.get("domain"),
        "spec_version": persona_yaml.get("spec_version", "1.0"),
        "capabilities": persona_yaml.get("capabilities", []),
    }
    out = backend.upsert_persona(body)
    action = "UPDATED" if existing_persona else "CREATED"
    print(f"  · persona {persona_slug:<28} {action}       ({out['id']})")
    print()
    print("done.")
    print(f"  spec_version = {out['spec_version']}")
    print(f"  scopes       = {len(out['allowed_scopes'])}")
    print(f"  capabilities = {len(out.get('capabilities') or [])} surface(s)")
    return 0


# ─────────────────────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────────────────────


def main() -> int:
    p = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("persona_yaml")
    p.add_argument(
        "--backend",
        default=os.environ.get(
            "SHUJIAN_BACKEND", "https://backend-production-fb29.up.railway.app"
        ),
    )
    p.add_argument("--user", default=os.environ.get("SHUJIAN_BACKEND_USER", "admin"))
    p.add_argument(
        "--password",
        default=os.environ.get("SHUJIAN_BACKEND_PASSWORD"),
        help="if omitted, prompt OR read SHUJIAN_BACKEND_PASSWORD env",
    )
    p.add_argument(
        "--tenant-id",
        default=os.environ.get("SHUJIAN_TENANT_ID"),
        help="superuser-only override; otherwise uses session's active tenant",
    )
    p.add_argument(
        "--bootstrap",
        action="store_true",
        help="create missing operator_refs + scopes from personas/{operator_refs,scopes}/*.yaml",
    )
    args = p.parse_args()

    if not args.password:
        args.password = getpass.getpass(f"password for {args.user}@{args.backend}: ")

    persona_path = Path(args.persona_yaml).resolve()
    try:
        persona_yaml = load_yaml(persona_path)
    except (FileNotFoundError, ValueError) as e:
        sys.stderr.write(f"ERROR: {e}\n")
        return 1

    for required in ("slug", "display_name", "system_prompt"):
        if required not in persona_yaml:
            sys.stderr.write(f"ERROR: persona YAML missing required field '{required}'\n")
            return 1

    try:
        return sync(args, persona_yaml)
    except RuntimeError as e:
        sys.stderr.write(f"ERROR: {e}\n")
        return 1


if __name__ == "__main__":
    sys.exit(main())
