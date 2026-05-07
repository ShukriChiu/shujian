#!/usr/bin/env python3
"""
persona_validate.py — validate a persona YAML against the v1 schema, plus
extra cross-field sanity checks.

Usage:
  python personas/scripts/persona_validate.py [path-to-yaml ...]

If no paths given, validates every personas/*.yaml.

Exit code:
  0  all files valid
  1  one or more files invalid (errors printed to stderr)
  2  bad invocation / missing dependency
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any

try:
    import yaml
except ImportError:
    sys.stderr.write("ERROR: PyYAML required.  pip install pyyaml\n")
    sys.exit(2)

try:
    from jsonschema import Draft202012Validator
except ImportError:
    sys.stderr.write("ERROR: jsonschema required.  pip install jsonschema\n")
    sys.exit(2)

REPO_ROOT = Path(__file__).resolve().parents[2]
PERSONAS_DIR = REPO_ROOT / "personas"
SCHEMA_PATH = PERSONAS_DIR / "spec" / "persona.schema.json"


def load_yaml(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as fh:
        return yaml.safe_load(fh)


def get_path(obj: Any, dotted: str) -> tuple[bool, Any]:
    """Walk a dot-path; supports a.b.c only (no array indices for now)."""
    cur = obj
    for part in dotted.split("."):
        if isinstance(cur, dict) and part in cur:
            cur = cur[part]
        else:
            return False, None
    return True, cur


def collect_template_vars(template: str) -> list[str]:
    return re.findall(r"\{([A-Z][A-Z0-9_]*)\}", template)


def cross_check(persona: dict[str, Any]) -> list[str]:
    errs: list[str] = []
    slug = persona.get("slug", "?")

    capabilities = persona.get("capabilities", []) or []
    seen_ids: set[str] = set()
    for idx, cap in enumerate(capabilities):
        cap_id = cap.get("id", f"#{idx}")
        if cap_id in seen_ids:
            errs.append(f"capability id '{cap_id}' is duplicated")
        seen_ids.add(cap_id)

        src = cap.get("source", {}) or {}
        kind = src.get("kind")
        if kind in {"http_get", "http_post"}:
            tpl = src.get("url_template", "")
            vars_used = collect_template_vars(tpl)
            for var in vars_used:
                if not re.match(r"^[A-Z][A-Z0-9_]*$", var):
                    errs.append(
                        f"[{cap_id}] url_template var '{{{var}}}' is not SCREAMING_SNAKE_CASE"
                    )

            auth_env = src.get("auth_env")
            if not auth_env and not tpl.startswith("http"):
                errs.append(
                    f"[{cap_id}] http source without auth_env — confirm this is a public endpoint"
                )

        example = ((cap.get("response_shape") or {}).get("example"))
        for field in cap.get("fields", []) or []:
            path = field.get("path")
            if example is not None and path is not None:
                ok, _ = get_path(example, path)
                if not ok:
                    errs.append(
                        f"[{cap_id}] field path '{path}' not found in response_shape.example "
                        f"— either fix the path or add it to the example"
                    )

    if errs:
        return [f"persona '{slug}': {e}" for e in errs]
    return []


def validate_one(path: Path, validator: Draft202012Validator) -> list[str]:
    try:
        data = load_yaml(path)
    except yaml.YAMLError as exc:
        return [f"{path}: YAML parse error: {exc}"]

    out: list[str] = []
    schema_errs = sorted(validator.iter_errors(data), key=lambda e: list(e.path))
    for err in schema_errs:
        loc = "$" + "".join(f".{p}" if isinstance(p, str) else f"[{p}]" for p in err.path)
        out.append(f"{path}: {loc} → {err.message}")

    if not schema_errs:
        for msg in cross_check(data):
            out.append(f"{path}: {msg}")
    return out


def main() -> None:
    if not SCHEMA_PATH.exists():
        sys.stderr.write(f"ERROR: schema missing: {SCHEMA_PATH}\n")
        sys.exit(2)

    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    validator = Draft202012Validator(schema)

    if len(sys.argv) > 1:
        targets = [Path(a).resolve() for a in sys.argv[1:]]
    else:
        targets = sorted(PERSONAS_DIR.glob("*.yaml"))

    if not targets:
        sys.stderr.write("no persona files to validate\n")
        sys.exit(0)

    total_errors = 0
    for path in targets:
        errs = validate_one(path, validator)
        if errs:
            total_errors += len(errs)
            for e in errs:
                sys.stderr.write(e + "\n")
        else:
            print(f"OK  {path.relative_to(REPO_ROOT)}")

    if total_errors:
        sys.stderr.write(f"\n{total_errors} validation error(s)\n")
        sys.exit(1)


if __name__ == "__main__":
    main()
