#!/usr/bin/env python3
"""Builds the fonts the apps carry, into app/assets/fonts.

    python3 -m venv /tmp/tsFonts && /tmp/tsFonts/bin/pip install fonttools
    /tmp/tsFonts/bin/python tools/makeFonts.py [spacegrotesk inter quicksand materialsymbols]

Both sources are variable fonts, and neither can be shipped as it stands.

Space Grotesk's default instance is **Light**, a weight this app never asks
for, so a phone handed the variable file would draw the whole app too thin.
It is pinned to the four static weights the theme names — 400, 500, 600, 700 —
each written into the one family `Space Grotesk`, so `fontFamily` plus
`fontWeight` picks a face that was actually drawn rather than a synthetic one.
Inter, the scoreboard's lettering (Helvetica Neue cannot be shipped), and
Quicksand, its labels, are made the same way; Inter's optical size is pinned
to its text size, 14. The web serves these very files, so the board is drawn
in the same faces everywhere and never in a system font.

Material Symbols is 10.6 MB of every icon Google has ever published. It is
pinned to exactly the instance `app/web/index.html` asks the CDN for, then
subset to the icons in `app/components/Icon.tsx`. The `rlig` feature is kept,
which is how the web draws an icon from its name, and each icon's private-use
character is kept too, which is how the phone draws it.

**Adding a name to `IconName` means running this again.** The list below is
checked against the source file, so a name added there and not here fails
loudly instead of shipping an icon that renders as its own name in words.
"""

from __future__ import annotations

import os
import re
import sys
import urllib.request
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

HERE = Path(__file__).resolve().parent
OUT = HERE.parent / "app" / "assets" / "fonts"
ICON_SOURCE = HERE.parent / "app" / "components" / "Icon.tsx"
CACHE = Path(os.environ.get("TS_FONT_CACHE", "/tmp/tsFontSources"))

SPACE_GROTESK = (
    "https://github.com/google/fonts/raw/main/ofl/spacegrotesk/"
    "SpaceGrotesk%5Bwght%5D.ttf"
)
MATERIAL_SYMBOLS = (
    "https://github.com/google/material-design-icons/raw/master/variablefont/"
    "MaterialSymbolsOutlined%5BFILL%2CGRAD%2Copsz%2Cwght%5D.ttf"
)

INTER = "https://github.com/google/fonts/raw/main/ofl/inter/Inter%5Bopsz%2Cwght%5D.ttf"
QUICKSAND = (
    "https://github.com/google/fonts/raw/main/ofl/quicksand/Quicksand%5Bwght%5D.ttf"
)

WEIGHTS = [(400, "Regular"), (500, "Medium"), (600, "SemiBold"), (700, "Bold")]


def download(url: str, name: str) -> Path:
    CACHE.mkdir(exist_ok=True)
    path = CACHE / name
    if not path.exists():
        print(f"fetching {name}")
        urllib.request.urlretrieve(url, path)
    return path


def icon_names() -> list[str]:
    """The `IconName` union, read from the file that declares it."""
    text = ICON_SOURCE.read_text()
    block = re.search(r"export type IconName =(.*?)\n\n", text, re.S)
    if block is None:
        raise SystemExit(f"No IconName union in {ICON_SOURCE}")
    return re.findall(r"'([a-z_0-9]+)'", block.group(1))


def set_names(font: TTFont, **records: str) -> None:
    """One clean set of name records, on both the Windows and Mac platforms."""
    table = font["name"]
    ids = {
        "family": 1,
        "subfamily": 2,
        "unique": 3,
        "full": 4,
        "postscript": 6,
        "typographic_family": 16,
        "typographic_subfamily": 17,
    }
    table.names = [n for n in table.names if n.nameID not in set(ids.values())]
    for platform in ((3, 1, 0x409), (1, 0, 0)):
        for key, value in records.items():
            table.setName(value, ids[key], *platform)


# Latin, Latin-1 and Latin Extended-A and B (names with accents), and the
# punctuation, currency and arrows a board or a screen uses.
LATIN = [*range(0x20, 0x250), 0x2BB, 0x2BC, 0x2C6, 0x2DA, 0x2DC,
         *range(0x2000, 0x2070), 0x20AC, 0x2122, 0x2191, 0x2193, 0x2212,
         0x2215, 0xFEFF, 0xFFFD]


def build_family(
    family: str,
    prefix: str,
    url: str,
    pins: dict[str, float] | None = None,
    latin_only: bool = False,
) -> None:
    """A variable font pinned to the four static weights, one family name."""
    source = download(url, f"{prefix}VF.ttf")
    for weight, style in WEIGHTS:
        font = TTFont(source)
        instancer.instantiateVariableFont(
            font, {**(pins or {}), "wght": weight}, updateFontNames=False, inplace=True
        )
        bold = style == "Bold"
        set_names(
            font,
            family=family,
            # The Mac-compatible subfamily may only be one of four words, so
            # the real style lives in the typographic names beside it.
            subfamily="Bold" if bold else "Regular",
            unique=f"{prefix}-{style}:teamstation",
            full=family if style == "Regular" else f"{family} {style}",
            postscript=f"{prefix}-{style}",
            typographic_family=family,
            typographic_subfamily=style,
        )
        font["OS/2"].usWeightClass = weight
        font["head"].macStyle = 1 if bold else 0
        selection = font["OS/2"].fsSelection & ~0x61
        font["OS/2"].fsSelection = selection | (0x20 if bold else 0x40)
        if latin_only:
            options = subset.Options()
            # Tabular figures too: a score or a count that changes keeps its
            # width (`fontVariant: ['tabular-nums']`).
            options.layout_features = ["kern", "liga", "calt", "tnum", "case"]
            options.name_IDs = ["*"]
            options.name_legacy = True
            options.notdef_outline = True
            subsetter = subset.Subsetter(options=options)
            subsetter.populate(unicodes=LATIN)
            subsetter.subset(font)
        out = OUT / f"{prefix}-{style}.ttf"
        font.save(out)
        print(f"{out.name}  {out.stat().st_size:>8,} bytes  wght {weight}")


def build_space_grotesk() -> None:
    build_family("Space Grotesk", "SpaceGrotesk", SPACE_GROTESK)


def build_inter() -> None:
    build_family("Inter", "Inter", INTER, {"opsz": 14}, latin_only=True)


def build_quicksand() -> None:
    build_family("Quicksand", "Quicksand", QUICKSAND)


def build_material_symbols() -> None:
    wanted = icon_names()
    source = download(MATERIAL_SYMBOLS, "MaterialSymbolsOutlined.ttf")
    font = TTFont(source)
    missing = [name for name in wanted if name not in set(font.getGlyphOrder())]
    if missing:
        raise SystemExit(f"Material Symbols has no icon named {missing}")

    # The same instance `index.html` asks the CDN for: `@24,400,0,0`.
    instancer.instantiateVariableFont(
        font,
        {"FILL": 0, "GRAD": 0, "opsz": 24, "wght": 400},
        updateFontNames=False,
        inplace=True,
    )

    # Only the ligatures that spell an icon this app draws. Left whole, the
    # closure from twenty-six letters reaches every ligature in the font, which
    # is every icon in it — 700 KB rather than 8. The coverage table has to be
    # rebuilt from what is left or the subsetter finds it inconsistent and
    # discards the whole feature, which ships a font that draws the words.
    keep = set(wanted)
    for lookup in font["GSUB"].table.LookupList.Lookup:
        for sub_table in lookup.SubTable:
            inner = getattr(sub_table, "ExtSubTable", sub_table)
            ligatures = getattr(inner, "ligatures", None)
            if ligatures is None:
                continue
            for first, entries in list(ligatures.items()):
                left = [lig for lig in entries if lig.LigGlyph in keep]
                if left:
                    ligatures[first] = left
                else:
                    del ligatures[first]
            coverage = getattr(inner, "Coverage", None)
            if coverage is not None:
                coverage.glyphs = [g for g in coverage.glyphs if g in ligatures]

    # Each icon glyph already has a private-use character in Google's font.
    # The phone draws that character. The ligature spelling (`mic`) is what
    # iOS shows as letters when the substitution does not run, which is the
    # dictation button filled with "MIC".
    codepoints: dict[str, int] = {}
    for codepoint, glyph in font.getBestCmap().items():
        if glyph not in keep:
            continue
        current = codepoints.get(glyph)
        if current is None or codepoint < current:
            codepoints[glyph] = codepoint
    missing_code = [name for name in wanted if name not in codepoints]
    if missing_code:
        raise SystemExit(f"Material Symbols has no character for {missing_code}")

    options = subset.Options()
    # `rlig`, not `liga`: Material Symbols files its ligatures as *required*
    # ones, and a subset keeping only `liga` throws every icon away.
    options.layout_features = ["rlig", "rclt"]
    options.layout_scripts = ["*"]
    options.name_IDs = ["*"]
    options.name_legacy = True
    options.notdef_outline = True
    options.glyph_names = True
    subsetter = subset.Subsetter(options=options)
    subsetter.populate(
        glyphs=wanted,
        unicodes=set(codepoints.values()),
        text="".join(sorted(set("".join(wanted)))),
    )
    subsetter.subset(font)

    set_names(
        font,
        family="Material Symbols Outlined",
        subfamily="Regular",
        unique="MaterialSymbolsOutlined:teamstation",
        full="Material Symbols Outlined",
        postscript="MaterialSymbolsOutlined",
        typographic_family="Material Symbols Outlined",
        typographic_subfamily="Regular",
    )
    out = OUT / "MaterialSymbolsOutlined.ttf"
    font.save(out)
    write_codepoints(wanted, codepoints)
    print(f"{out.name}  {out.stat().st_size:>8,} bytes  {len(wanted)} icons")


def write_codepoints(names: list[str], codepoints: dict[str, int]) -> None:
    """The map the phone uses to draw an icon without a ligature."""
    lines = [
        "/**",
        " * One character per icon, the private-use point Google assigned it.",
        " * `makeFonts.py` writes this file and the phone font together: the",
        " * phone draws the character, and the web keeps drawing the ligature",
        " * name because Google's CDN font is what the browser loads.",
        " */",
        "import type { IconName } from './Icon'",
        "",
        "export const iconCodepoints: Record<IconName, number> = {",
    ]
    for name in names:
        lines.append(f"  {name}: 0x{codepoints[name]:x},")
    lines.append("}")
    lines.append("")
    path = HERE.parent / "app" / "components" / "iconCodepoints.ts"
    path.write_text("\n".join(lines))


BUILDS = {
    "spacegrotesk": build_space_grotesk,
    "inter": build_inter,
    "quicksand": build_quicksand,
    "materialsymbols": build_material_symbols,
}


if __name__ == "__main__":
    # Every font, or only those named: `makeFonts.py inter quicksand`.
    wanted = sys.argv[1:] or list(BUILDS)
    unknown = [name for name in wanted if name not in BUILDS]
    if unknown:
        raise SystemExit(f"No font {unknown}; one of {list(BUILDS)}")
    OUT.mkdir(parents=True, exist_ok=True)
    for name in wanted:
        BUILDS[name]()
    print("Rebuild the apps: iOS embeds these by reference, Android copies them.")
    sys.exit(0)
