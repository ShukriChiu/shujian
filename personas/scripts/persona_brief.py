#!/usr/bin/env python3
"""
persona_brief.py — generate an AI-implementation brief for one capability.

Usage:
  python personas/scripts/persona_brief.py <persona_slug> <capability_id>
  python personas/scripts/persona_brief.py onion_boss_analyst business_snapshot

The output is plain text designed to be pasted into Cursor / Claude with
"implement this in onion-agent (or whatever backend owns the URL)".

The brief tells the implementing AI:
  - HTTP method, path, expected auth header
  - Response JSON example (so it can write a pydantic model)
  - Which fields the dashboard actually consumes (so it knows what
    must be present and stable, vs what's nice-to-have)
  - Performance budget derived from refresh_seconds / timeout_ms
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

try:
    import yaml
except ImportError:
    sys.stderr.write(
        "ERROR: PyYAML required.  pip install pyyaml  (or  uv pip install pyyaml)\n"
    )
    sys.exit(2)

REPO_ROOT = Path(__file__).resolve().parents[2]
PERSONAS_DIR = REPO_ROOT / "personas"


def load_persona(slug: str) -> dict[str, Any]:
    candidate = PERSONAS_DIR / f"{slug}.yaml"
    if not candidate.exists():
        sys.stderr.write(f"ERROR: persona not found: {candidate}\n")
        available = sorted(p.stem for p in PERSONAS_DIR.glob("*.yaml"))
        sys.stderr.write(f"available: {', '.join(available) or '(none)'}\n")
        sys.exit(1)
    with candidate.open("r", encoding="utf-8") as fh:
        return yaml.safe_load(fh)


def find_capability(persona: dict[str, Any], cap_id: str) -> dict[str, Any]:
    for cap in persona.get("capabilities", []) or []:
        if cap.get("id") == cap_id:
            return cap
    sys.stderr.write(f"ERROR: capability '{cap_id}' not found in persona\n")
    available = [c.get("id") for c in persona.get("capabilities", []) or []]
    sys.stderr.write(f"available: {', '.join(available) or '(none)'}\n")
    sys.exit(1)


def render_url(template: str) -> tuple[str, str]:
    """Returns (rendered_with_placeholder, owning_host_hint)."""
    rendered = template
    base_var: str | None = None
    for token in template.split("{")[1:]:
        end = token.find("}")
        if end == -1:
            continue
        var = token[:end]
        if var.endswith("_BASE") or var.endswith("_BASE_URL") or var == "ONION_API_BASE":
            base_var = var
        rendered = rendered.replace("{" + var + "}", "<" + var + ">")
    parsed = urlparse(rendered.replace("<" + (base_var or "X") + ">", "https://placeholder"))
    return rendered, parsed.path or "/"


def collect_field_paths(cap: dict[str, Any]) -> list[tuple[str, str, str]]:
    out: list[tuple[str, str, str]] = []
    for field in cap.get("fields", []) or []:
        out.append((
            field["path"],
            field.get("format", "text"),
            field.get("label", ""),
        ))
    return out


def perf_budget(cap: dict[str, Any]) -> str:
    refresh = cap.get("refresh_seconds")
    timeout = cap.get("source", {}).get("timeout_ms")
    parts: list[str] = []
    if refresh and refresh > 0:
        if refresh <= 30:
            parts.append(f"polled every {refresh}s → keep p95 < {max(500, refresh * 1000 // 5)}ms")
        else:
            parts.append(f"polled every {refresh}s → keep p95 < 2000ms")
    else:
        parts.append("manual refresh only → p95 < 3000ms is fine")
    if timeout:
        parts.append(f"client timeout: {timeout}ms (any single request slower than this fails the widget)")
    return "  - " + "\n  - ".join(parts)


def render_brief(persona: dict[str, Any], cap: dict[str, Any]) -> str:
    slug = persona["slug"]
    cap_id = cap["id"]
    src = cap.get("source", {})
    kind = src.get("kind")
    method = {"http_get": "GET", "http_post": "POST"}.get(kind, "?")
    rendered_url, path = render_url(src.get("url_template", ""))
    auth_env = src.get("auth_env")
    fields = collect_field_paths(cap)
    example = (cap.get("response_shape") or {}).get("example")
    layout = cap.get("layout")
    refresh = cap.get("refresh_seconds")

    lines: list[str] = []
    lines.append(f"=== Capability brief — {slug} :: {cap_id} ===")
    lines.append("")
    lines.append(f"PURPOSE")
    lines.append(f"  {cap.get('label')}: {cap.get('description', '(no description)')}")
    lines.append("")
    lines.append("ROUTE TO IMPLEMENT")
    lines.append(f"  {method} {path}")
    lines.append(f"  full template: {src.get('url_template')}")
    if auth_env:
        lines.append(
            f"  auth: Authorization: Bearer <{auth_env}>"
            f"   ({'AI persona JWT, readonly' if 'ONION' in auth_env else 'see vault binding'})"
        )
    else:
        lines.append("  auth: (none — public)  ⚠️ confirm this is intentional")
    lines.append("")

    lines.append("RESPONSE BODY — must match this shape (one example)")
    if example is not None:
        for line in json.dumps(example, ensure_ascii=False, indent=2).splitlines():
            lines.append("  " + line)
    else:
        lines.append("  (none provided — please add `response_shape.example` to the persona YAML)")
    lines.append("")

    lines.append("FIELDS THE DASHBOARD ACTUALLY READS")
    if fields:
        for path_, fmt, label in fields:
            lines.append(f"  {path_:<32}  format={fmt:<9} label={label}")
        lines.append("")
        lines.append(
            "  → these paths must be present and stable; other keys in the response "
            "are fine but won't be rendered."
        )
    else:
        lines.append("  (none — capability is consumed verbatim by the renderer)")
    lines.append("")

    lines.append("DASHBOARD CONSTRAINTS")
    lines.append(f"  - Renderer: {layout}  (placement: {cap.get('placement', 'workspace_main')})")
    if refresh is not None:
        lines.append(f"  - Refresh cadence: {refresh}s")
    lines.append("  - Performance budget:")
    lines.append(perf_budget(cap))
    lines.append("")

    lines.append("HOW THE TOKEN GETS THERE")
    lines.append(f"  Persona '{slug}' is granted scopes: {persona.get('allowed_scopes')}")
    if auth_env:
        lines.append(
            f"  When dashboard calls /v1/personas/{slug}/issue, shujian-backend resolves\n"
            f"  those scopes into envVars (one of which is {auth_env}) and returns them.\n"
            f"  The dashboard puts {auth_env} into Authorization: Bearer for this URL.\n"
            f"  The backend implementation must validate the JWT (kind=ai_persona) and\n"
            f"  enforce readonly behaviour."
        )
    lines.append("")
    lines.append("PASTE THIS BRIEF INTO CURSOR / CLAUDE TO GENERATE THE ROUTE.")
    return "\n".join(lines)


def main() -> None:
    if len(sys.argv) != 3:
        sys.stderr.write(__doc__ or "")
        sys.exit(2)
    slug, cap_id = sys.argv[1], sys.argv[2]
    persona = load_persona(slug)
    cap = find_capability(persona, cap_id)
    print(render_brief(persona, cap))


if __name__ == "__main__":
    main()
