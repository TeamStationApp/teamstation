# The fonts, one copy

`Space Grotesk` is the app's type, `Inter` and `Quicksand` are the
scoreboard's, and `Material Symbols Outlined` is its icon set. Every text font
is carried here and used on all three platforms, and nothing is ever drawn in
a system font: a system font draws at another size on each platform, which the
scoreboard especially cannot have. Inter stands in for 1.0's Helvetica Neue,
which cannot be shipped. Each native project reaches in rather than keeping a
copy of its own — a second copy is a copy that can drift — and the web build
copies the text fonts into `dist/fonts`, where `app/web/index.html` declares
them with `font-display: block`, so the browser waits for them rather than
drawing a system font first. The icons alone still come from Google's CDN.

- **iOS** references these files in place from the Xcode project and names them
  in `UIAppFonts`.
- **The web** serves the text fonts from `dist/fonts` (`build.mjs`). A
  production build names each one `<Family>-<Style>-<hash>.ttf`, the hash of
  its content, so a browser may keep it for ever, and rewrites `index.html`'s
  `/fonts/<Family>-<Style>.ttf` to match; nothing else is rewritten, so any
  other page that names a font must go through the same step (`withFonts`).
  `--serve` keeps the plain names.
- **Android** copies them into a generated `res/font` directory at build time
  (`android/app/build.gradle`), because Android resource names may only be
  lowercase with underscores, and registers the families in
  `MainApplication` so `fontWeight: '500'` and `'600'` resolve to the faces
  drawn for them rather than to a synthetic bold.

  That last part is why `minSdkVersion` is at least **28** (it is 30, for the
  phone streaming library). React Native resolves a registered family through
  `Typeface.create(base, weight, italic)`, which only exists from API 28;
  below it the call collapses to
  `Typeface.create(base, style)` and every weight under 700 becomes regular —
  which would silently cost the app two of its four weights on Android 7 and 8
  and show up as "the type looks wrong on that one phone". The app asks for
  500 and 600 in about twenty-five places, so two weights is not a graceful
  degradation, it is a different design.

## How they were made

`SpaceGrotesk[wght].ttf` from `google/fonts` is a variable font whose default
instance is **Light**, which is not a weight this app uses anywhere; shipped as
it is, every word in the app would be too thin. So it is pinned to four static
instances at 400, 500, 600 and 700, each named into the one family `Space
Grotesk` so the family name plus a weight picks the right face.

`Inter[opsz,wght].ttf` and `Quicksand[wght].ttf` are pinned the same way, to
the same four weights. Inter's optical size is pinned to 14, its text size, and
it is cut to Latin (accented names included) with its tabular figures kept,
which takes each weight from 340 KB to 81 KB. Their licences are beside them.

`MaterialSymbolsOutlined[FILL,GRAD,opsz,wght].ttf` is 10.6 MB and holds every
icon Google has drawn. It is pinned to the same instance the web app asks for —
`opsz 24, wght 400, FILL 0, GRAD 0` — and then subset to the icons
in `app/components/Icon.tsx`, keeping the `rlig` feature that turns the text
`chevron_right` into the glyph. 8 KB.

Adding an icon to `IconName` therefore means regenerating this file.
`tools/makeFonts.py` does all of it; name the fonts to build only those
(`makeFonts.py inter quicksand`).
