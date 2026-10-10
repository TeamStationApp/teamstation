#!/usr/bin/env python3
"""Regenerate only the icon font, with fonttools 4.60.1 and a pinned Apache-2.0 source.

Pass --cache with a source-cache directory. The existing font builder preserves
the application's static 400-weight, 24-optical-size outlined instance.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import urllib.request
import sys
from pathlib import Path

from fontTools.ttLib import TTFont

REVISION = "737e3324305806514d7909874fa1818ae1808232"
SHA256 = "5ca6cdf74da4018e8a7687995c9e392b1a7ec49588fade2be3a97a2a06dd3262"
LICENSE_SHA256 = "58d1e17ffe5109a7ae296caafcadfdbe6a7d176f0bc4ab01e12a689b0499d8bd"
BASE = f"https://raw.githubusercontent.com/google/material-design-icons/{REVISION}/"


def checked_source(cache: Path, name: str, remote: str, expected: str) -> Path:
    path = cache / name
    if not path.exists():
        urllib.request.urlretrieve(BASE + remote, path)
    if hashlib.sha256(path.read_bytes()).hexdigest() != expected:
        raise SystemExit(f"Unexpected checksum for {name}; refusing to generate assets")
    return path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cache", required=True, type=Path)
    cache = parser.parse_args().cache
    cache.mkdir(parents=True, exist_ok=True)
    source = checked_source(cache, "MaterialSymbolsOutlined.ttf", "variablefont/MaterialSymbolsOutlined%5BFILL%2CGRAD%2Copsz%2Cwght%5D.ttf", SHA256)
    license_file = checked_source(cache, "LICENSE", "LICENSE", LICENSE_SHA256)
    root = Path(__file__).resolve().parent.parent
    specification = importlib.util.spec_from_file_location("font_builder", root / "src/tools/makeFonts.py")
    builder = importlib.util.module_from_spec(specification)
    sys.dont_write_bytecode = True
    specification.loader.exec_module(builder)
    builder.download = lambda _url, _name: source
    builder.TTFont = lambda path: TTFont(path, recalcTimestamp=False)
    builder.build_material_symbols()
    mapping = root / "src/app/components/iconCodepoints.ts"
    mapping.write_text(mapping.read_text().replace(",\n}", "\n}"))
    (root / "src/app/assets/fonts/MaterialSymbols.LICENSE.txt").write_bytes(license_file.read_bytes())
    print(f"Pinned Material Symbols {REVISION}; checksum verified")


if __name__ == "__main__":
    main()
