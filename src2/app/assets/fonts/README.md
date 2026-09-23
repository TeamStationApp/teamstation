# The two fonts, one copy

`Space Grotesk` is the app's type and `Material Symbols Outlined` is its icon
set. The web app fetches both from Google's CDN (`app/web/index.html`); a phone
has to carry them, so they live here and each native project reaches in rather
than keeping a copy of its own — a second copy is a copy that can drift.

- **iOS** references these files in place from the Xcode project and names them
  in `UIAppFonts`.
- **Android** copies them into a generated `res/font` directory at build time
  (`android/app/build.gradle`), because Android resource names may only be
  lowercase with underscores, and registers the two families in
  `MainApplication` so `fontWeight: '500'` and `'600'` resolve to the faces
  drawn for them rather than to a synthetic bold.

  That last part is why `minSdkVersion` is **28**. React Native resolves a
  registered family through `Typeface.create(base, weight, italic)`, which
  only exists from API 28; below it the call collapses to
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

`MaterialSymbolsOutlined[FILL,GRAD,opsz,wght].ttf` is 10.6 MB and holds every
icon Google has drawn. It is pinned to the same instance the web app asks for —
`opsz 24, wght 400, FILL 0, GRAD 0` — and then subset to the twenty-seven icons
in `app/components/Icon.tsx`, keeping the `rlig` feature that turns the text
`chevron_right` into the glyph. 8 KB.

Adding an icon to `IconName` therefore means regenerating this file.
`tools/makeFonts.py` does both jobs.
