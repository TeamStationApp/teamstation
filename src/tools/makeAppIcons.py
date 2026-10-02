#!/usr/bin/env python3
"""Draws the phone app's icon for both platforms from the mark's own path data.

    python3 -m venv /tmp/tsIcons && /tmp/tsIcons/bin/pip install cairosvg
    /tmp/tsIcons/bin/python src/tools/makeAppIcons.py

It is drawn rather than resized: `src/app/components/tsMarkPaths.ts` is the
vector the app puts in its own header, and the gradient's two colours come
from the theme, so the icon is the same mark in the same colours and cannot
drift from what the header draws.

The one difference is the background. In the app the mark is strokes over
nothing, so the header's glass shows through its middle. An icon has nothing
behind it, so it sits on the app's own canvas colour.
"""

from __future__ import annotations

import plistlib
import re
import subprocess
from pathlib import Path

import cairosvg

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
PATHS = ROOT / "src" / "app" / "components" / "tsMarkPaths.ts"
THEME = ROOT / "src" / "app" / "theme" / "tsBallpark.ts"
IOS_ICONS = ROOT / "ios" / "TeamStation" / "Images.xcassets" / "AppIcon.appiconset"
ANDROID_RES = ROOT / "android" / "app" / "src" / "main" / "res"

# Android's launcher crops an adaptive icon to whatever shape the phone's
# launcher uses. Two thirds of the tile is the *square* that survives, and a
# round launcher keeps a circle 2/3 of the tile across, and a square only
# survives inside that circle if its diagonal fits: 0.667 / sqrt(2) = 0.47.
# Drawn at 0.66 the arc's top-left came out cut flat against the mask on the
# emulator, and 0.58 was still not enough — the corners are what get taken,
# and the mark has its arc in one corner and the leaf's tail in another.
ADAPTIVE_SAFE = 0.46
# iOS applies its own rounding and wants the artwork to reach the edges.
IOS_INSET = 0.72

DENSITIES = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}


def read(name: str, source: Path) -> str:
    """One `export const NAME = '...'` out of a TypeScript file."""
    match = re.search(rf"{name} =\s*\n?\s*'([^']*)'", source.read_text())
    if match is None:
        raise SystemExit(f"No {name} in {source}")
    return match.group(1)


def read_list(name: str) -> list[str]:
    text = PATHS.read_text()
    block = re.search(rf"{name}: string\[\] = \[(.*?)\n\]", text, re.S)
    if block is None:
        raise SystemExit(f"No {name} in {PATHS}")
    return re.findall(r"'([^']*)'", block.group(1))


def colour(name: str) -> str:
    match = re.search(rf"{name}: '(#[0-9A-Fa-f]{{6}})'", THEME.read_text())
    if match is None:
        # The palette entries are named rather than spelled at the point of use.
        key = {"backgroundColor": "bone"}[name]
        match = re.search(rf"{key}: '(#[0-9A-Fa-f]{{6}})'", THEME.read_text())
    if match is None:
        raise SystemExit(f"No colour {name} in {THEME}")
    return match.group(1)


def number(name: str) -> float:
    """One `export const NAME = <number>` out of the paths module."""
    match = re.search(rf"{name} = ([0-9.]+)", PATHS.read_text())
    if match is None:
        raise SystemExit(f"No {name} in {PATHS}")
    return float(match.group(1))


def gradient() -> tuple[dict[str, float], list[float]]:
    """The gradient's line and its two stops, as the paths module writes them."""
    text = PATHS.read_text()
    line = re.search(r"MARK_GRADIENT = \{([^}]*)\}", text)
    stops = re.search(r"MARK_GRADIENT_STOPS[^=]*= \[([^\]]*)\]", text)
    if line is None or stops is None:
        raise SystemExit(f"No MARK_GRADIENT in {PATHS}")
    points = {
        key: float(value)
        for key, value in re.findall(r"(\w+): ([0-9.]+)", line.group(1))
    }
    return points, [float(n) for n in stops.group(1).split(",")]


def svg(size: int, scale: float, background: str | None) -> bytes:
    """The mark, centred on a square, at `scale` of the square's width."""
    box = read("MARK_VIEW_BOX", PATHS).split()
    view_x, view_y, view_w, view_h = (float(n) for n in box)
    start, end = colour("markGradientStart"), colour("markGradientEnd")
    points, (stop_start, stop_end) = gradient()

    drawn = size * scale
    offset = (size - drawn) / 2
    fill = (
        f'<rect width="{size}" height="{size}" fill="{background}"/>'
        if background is not None
        else ""
    )
    paths = "".join(f'<path d="{d}"/>' for d in read_list("MARK_PATHS"))
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" '
        f'height="{size}" viewBox="0 0 {size} {size}">{fill}'
        f'<svg x="{offset}" y="{offset}" width="{drawn}" height="{drawn}" '
        f'viewBox="{view_x} {view_y} {view_w} {view_h}">'
        f'<defs><linearGradient id="mark" gradientUnits="userSpaceOnUse" '
        f'x1="{points["x1"]}" y1="{points["y1"]}" '
        f'x2="{points["x2"]}" y2="{points["y2"]}">'
        f'<stop offset="{stop_start}" stop-color="{start}"/>'
        f'<stop offset="{stop_end}" stop-color="{end}"/>'
        f"</linearGradient></defs>"
        f'<g fill="none" stroke="url(#mark)" '
        f'stroke-width="{number("MARK_STROKE_WIDTH")}" '
        f'stroke-linecap="round" stroke-linejoin="round">{paths}</g>'
        f"</svg></svg>"
    ).encode()


def write_png(path: Path, size: int, scale: float, background: str | None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    cairosvg.svg2png(
        bytestring=svg(size, scale, background),
        write_to=str(path),
        output_width=size,
        output_height=size,
    )
    print(f"{path.relative_to(ROOT)}  {size}×{size}")


def build_ios() -> None:
    # One 1024 image: Xcode has taken every other size from it since 13.
    write_png(IOS_ICONS / "AppIcon.png", 1024, IOS_INSET, colour("backgroundColor"))
    (IOS_ICONS / "Contents.json").write_text(
        '{\n  "images" : [\n    {\n      "filename" : "AppIcon.png",\n'
        '      "idiom" : "universal",\n      "platform" : "ios",\n'
        '      "size" : "1024x1024"\n    }\n  ],\n  "info" : {\n'
        '    "author" : "xcode",\n    "version" : 1\n  }\n}\n'
    )


def build_android() -> None:
    canvas = colour("backgroundColor")
    for density, size in DENSITIES.items():
        folder = ANDROID_RES / f"mipmap-{density}"
        # The legacy icons, for a launcher that does not do adaptive ones.
        write_png(folder / "ic_launcher.png", size, IOS_INSET, canvas)
        write_png(folder / "ic_launcher_round.png", size, IOS_INSET, canvas)
        # And the foreground of the adaptive one, which is drawn over a plain
        # background colour and cropped to the launcher's own shape.
        write_png(
            folder / "ic_launcher_foreground.png", size * 2, ADAPTIVE_SAFE, None
        )

    (ANDROID_RES / "values" / "ic_launcher_background.xml").write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n'
        f'    <color name="ic_launcher_background">{canvas}</color>\n'
        "</resources>\n"
    )
    for name in ("ic_launcher", "ic_launcher_round"):
        folder = ANDROID_RES / "mipmap-anydpi-v26"
        folder.mkdir(parents=True, exist_ok=True)
        (folder / f"{name}.xml").write_text(
            '<?xml version="1.0" encoding="utf-8"?>\n'
            '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n'
            '    <background android:drawable="@color/ic_launcher_background"/>\n'
            '    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>\n'
            "</adaptive-icon>\n"
        )


if __name__ == "__main__":
    build_ios()
    build_android()
    # A PNG with an alpha channel is rejected by the App Store, and the one
    # above has none — but say so rather than leaving it to be discovered.
    result = subprocess.run(
        ["sips", "-g", "hasAlpha", str(IOS_ICONS / "AppIcon.png")],
        capture_output=True,
        text=True,
    )
    print(result.stdout.strip().splitlines()[-1])
