#!/usr/bin/env python3
"""agent-gw paint backend for the pipeline (alternative to the local Codex CLI).

Two subcommands:

  upload  --image-path <file>            Upload a local image, print its public signed_url.
  paint   --description <text> --output <out.png> --ref <url> [--ref <url>...]
                                         Edit/generate a 1024x1024 image from reference
                                         URLs and download it to --output.

Auth: KIMI_API_KEY env or ~/.kimi/agent-gw.json (same as the image_generation plugin).
Used by pipeline/src/paint.ts when PAINT_BACKEND=agentgw.
"""
import argparse
import sys
from pathlib import Path

TIMEOUT = 600.0
VERSION = "v2"


def client_cls():
    try:
        from agent_gw import AgentGwClient, AgentGwError
    except ImportError:
        raise SystemExit("agent-gw SDK not installed: pip install 'agent-gw>=0.2.6'")
    return AgentGwClient, AgentGwError


def cmd_upload(args) -> int:
    AgentGwClient, AgentGwError = client_cls()
    path = Path(args.image_path)
    try:
        with AgentGwClient(timeout=TIMEOUT) as client:
            obj = client.upload_storage(path, filename=path.name, content_type="image/png")
    except AgentGwError as exc:
        print(f"upload failed for '{path}': {exc}", file=sys.stderr)
        return 1
    url = obj.get("signed_url") if isinstance(obj, dict) else None
    if not url:
        print(f"upload_storage returned no signed_url for '{path}'", file=sys.stderr)
        return 1
    print(url)
    return 0


def cmd_paint(args) -> int:
    AgentGwClient, AgentGwError = client_cls()
    description = Path(args.description_file).read_text() if args.description_file else args.description
    try:
        with AgentGwClient(timeout=TIMEOUT) as client:
            resp = client.tools.generate_image(
                description,
                size="1024x1024",
                background="IMAGE_BACKGROUND_OPAQUE",
                reference_image_urls=args.ref or None,
                version=VERSION,
                timeout=TIMEOUT,
            )
    except AgentGwError as exc:
        print(f"generate failed: {exc}", file=sys.stderr)
        return 1
    media = resp.json().get("media") if hasattr(resp, "json") else None
    url, mime = (media or {}).get("url"), (media or {}).get("mime_type")
    if not url:
        print("generate_image returned no media URL", file=sys.stderr)
        return 1
    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    import subprocess

    proc = subprocess.run(["curl", "-fsSL", url, "-o", str(out)], timeout=300)
    if proc.returncode != 0 or not out.exists():
        print(f"download failed from {url}", file=sys.stderr)
        return 1
    print(f"saved: {out} ({mime})")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest="cmd", required=True)
    up = sub.add_parser("upload")
    up.add_argument("--image-path", required=True)
    pa = sub.add_parser("paint")
    pa.add_argument("--description")
    pa.add_argument("--description-file")
    pa.add_argument("--output", required=True)
    pa.add_argument("--ref", action="append", default=[])
    args = p.parse_args()
    return cmd_upload(args) if args.cmd == "upload" else cmd_paint(args)


if __name__ == "__main__":
    sys.exit(main())
