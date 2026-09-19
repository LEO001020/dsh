#!/usr/bin/env python3
"""Build the @deepseek-ai name -> source-directory map for the pinned checkout.

The package's node_modules entries are Windows junctions, which store an ABSOLUTE
target. Moving the install (D:\\DSH -> D:\\Code\\DSH and back) therefore breaks
every one of them at once, and the ad-hoc ones added while tests were being
written are not in link-dsh.cmd at all. This derives the map from the checkout's
own manifests so the link set can be regenerated completely instead of
incrementally patched.
"""
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".")
names = [line.strip() for line in pathlib.Path(sys.argv[2]).read_text().splitlines() if line.strip()]

by_name = {}
for manifest in root.rglob("package.json"):
    if "node_modules" in manifest.parts:
        continue
    try:
        data = json.loads(manifest.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        continue
    name = data.get("name")
    if isinstance(name, str) and name.startswith("@deepseek-ai/"):
        # First writer wins so a nested duplicate cannot shadow the canonical dir.
        by_name.setdefault(name, manifest.parent)

resolved, missing = [], []
for name in names:
    target = by_name.get(name)
    if target is None:
        missing.append(name)
    else:
        resolved.append((name, target.as_posix()))

print(json.dumps({"resolved": resolved, "missing": missing}, indent=1))
print(f"# resolved {len(resolved)} of {len(names)}", file=sys.stderr)
for name in missing:
    print(f"# UNRESOLVED {name}", file=sys.stderr)
