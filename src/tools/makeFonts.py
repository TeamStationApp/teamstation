#!/usr/bin/env python3
"""Builds the two fonts the native apps carry, into app/assets/fonts.

    python3 -m venv /tmp/gsFonts && /tmp/gsFonts/bin/pip install fonttools
    /tmp/gsFonts/bin/python tools/makeFonts.py

Both sources are variable fonts, and neither can be shipped as it stands.

Space Grotesk's default instance is **Light**, a weight this app never asks
for, so a phone handed the variable file would draw the whole app too thin.
It is pinned to the four static weights the theme names — 400, 500, 600, 700 —
each written into the one family `Space Grotesk`, so `fontFamily` plus
`fontWeight` picks a face that was actually drawn rather than a synthetic one.

Material Symbols is 10.6 MB of every icon Google has ever published. It is
pinned to exactly the instance `app/web/index.html` asks the CDN for, then
subset to the icons in `app/components/Icon.tsx`. The `rlig` feature is kept
and nothing else is: that is the one that turns the text `chevron_right` into
the glyph, which is how `Icon` is written.

**Adding a name to `IconName` means running this again.** The list below is
checked against the source file, so a name added there and not here fails
loudly instead of shipping an icon that renders as its own name in words.
"""

from __future__ import annotations

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
CACHE = Path("/tmp/gsFontSources")

SPACE_GROTESK = (
    "https://github.com/google/fonts/raw/main/ofl/spacegrotesk/"
    "SpaceGrotesk%5Bwght%5D.ttf"
)
MATERIAL_SYMBOLS = (
    "https://github.com/google/material-design-icons/raw/master/variablefont/"
    "MaterialSymbolsOutlined%5BFILL%2CGRAD%2Copsz%2Cwght%5D.ttf"
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


def build_space_grotesk() -> None:
    source = download(SPACE_GROTESK, "SpaceGroteskVF.ttf")
    for weight, style in WEIGHTS:
        font = TTFont(source)
        instancer.instantiateVariableFont(
            font, {"wght": weight}, updateFontNames=False, inplace=True
        )
        bold = style == "Bold"
        set_names(
            font,
            family="Space Grotesk",
            # The Mac-compatible subfamily may only be one of four words, so
            # the real style lives in the typographic names beside it.
            subfamily="Bold" if bold else "Regular",
            unique=f"SpaceGrotesk-{style}:gamestation",
            full="Space Grotesk" if style == "Regular" else f"Space Grotesk {style}",
            postscript=f"SpaceGrotesk-{style}",
            typographic_family="Space Grotesk",
            typographic_subfamily=style,
        )
        font["OS/2"].usWeightClass = weight
        font["head"].macStyle = 1 if bold else 0
        selection = font["OS/2"].fsSelection & ~0x61
        font["OS/2"].fsSelection = selection | (0x20 if bold else 0x40)
        out = OUT / f"SpaceGrotesk-{style}.ttf"
        font.save(out)
        print(f"{out.name}  {out.stat().st_size:>8,} bytes  wght {weight}")


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
    subsetter.populate(glyphs=wanted, text="".join(sorted(set("".join(wanted)))))
    subsetter.subset(font)

    set_names(
        font,
        family="Material Symbols Outlined",
        subfamily="Regular",
        unique="MaterialSymbolsOutlined:gamestation",
        full="Material Symbols Outlined",
        postscript="MaterialSymbolsOutlined",
        typographic_family="Material Symbols Outlined",
        typographic_subfamily="Regular",
    )
    out = OUT / "MaterialSymbolsOutlined.ttf"
    font.save(out)
    print(f"{out.name}  {out.stat().st_size:>8,} bytes  {len(wanted)} icons")


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    build_space_grotesk()
    build_material_symbols()
    print("Rebuild the apps: iOS embeds these by reference, Android copies them.")
    sys.exit(0)
