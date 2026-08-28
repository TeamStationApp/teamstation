#!/usr/bin/env node
/**
 * Compose GS Director and GS Cameraman iOS App Icons from the canonical
 * GameStation logo plus a per-app wireframe glyph.
 *
 * Source of truth for the G: `src/client/assets/images/gs_logo.png`
 * (the same file GS Watcher's Android launcher generator uses).
 *
 * Layout: cream canvas (sampled from the logo), G scaled to 75% and
 * placed upper-left, outline glyph lower-right with a cream understroke
 * so it stays readable where it crosses the G.
 *
 * Requires ImageMagick (`magick`) and librsvg (`rsvg-convert`) on PATH.
 * Magick's built-in SVG renderer leaves these stroke-only glyphs blank, so
 * rasterization goes through rsvg-convert. Install on macOS with:
 *   brew install imagemagick librsvg
 *
 * Usage (from repo root or this directory):
 *   node mobile/icons/generateAppIcons.js
 */
const path = require('path')
const fs = require('fs')
const os = require('os')
const { execFileSync } = require('child_process')

const iconsDir = __dirname
const repoRoot = path.resolve(iconsDir, '..', '..')
const SRC_LOGO = path.join(repoRoot, 'src', 'client', 'assets', 'images', 'gs_logo.png')

const CANVAS = 1024
const G_SCALE = 0.75
const G_INSET = Math.round(CANVAS * 0.06)
const GLYPH_SIZE = Math.round(CANVAS * 0.4)
const GLYPH_INSET = Math.round(CANVAS * 0.08)
const HALO_DISK = 8

const APPS = [
  {
    name: 'director',
    svg: path.join(iconsDir, 'clapboard.svg'),
    out: path.join(
      repoRoot,
      'mobile/apps/gsDirector/App/Assets.xcassets/AppIcon.appiconset/AppIcon.png'
    )
  },
  {
    name: 'cameraman',
    svg: path.join(iconsDir, 'cineCamera.svg'),
    out: path.join(
      repoRoot,
      'mobile/apps/gsCameraman/App/Assets.xcassets/AppIcon.appiconset/AppIcon.png'
    )
  }
]

function findBin(name, extraPaths, hint) {
  const candidates = [name, ...extraPaths]
  for (const bin of candidates) {
    try {
      execFileSync(bin, ['--version'], { stdio: 'ignore' })
      return bin
    } catch {
      try {
        execFileSync(bin, ['-version'], { stdio: 'ignore' })
        return bin
      } catch {
        // try next
      }
    }
  }
  throw new Error(hint)
}

const MAGICK = findBin(
  'magick',
  ['/opt/homebrew/bin/magick', '/usr/local/bin/magick'],
  'ImageMagick `magick` not found. Install on macOS with: brew install imagemagick'
)
const RSVG = findBin(
  'rsvg-convert',
  ['/opt/homebrew/bin/rsvg-convert', '/usr/local/bin/rsvg-convert'],
  'librsvg `rsvg-convert` not found. Install on macOS with: brew install librsvg'
)

function magick(...args) {
  execFileSync(MAGICK, args, { stdio: ['ignore', 'pipe', 'inherit'] })
}

function magickOut(...args) {
  return execFileSync(MAGICK, args, { encoding: 'utf8' }).trim()
}

function sampleCream(logoPath) {
  const hex = magickOut(logoPath, '-format', '%[hex:u.p{0,0}]', 'info:')
  const rgb = hex.replace(/[^0-9A-Fa-f]/g, '').slice(0, 6)
  if (rgb.length !== 6) {
    throw new Error(`could not sample cream from ${logoPath}: got ${hex}`)
  }
  return `#${rgb.toUpperCase()}`
}

function squarePadLogo(logoPath, cream, dest) {
  magick(
    logoPath,
    '-background',
    cream,
    '-gravity',
    'center',
    '-extent',
    '%[fx:max(w,h)]x%[fx:max(w,h)]',
    dest
  )
}

function rasterizeSvg(svgPath, sizePx, dest) {
  execFileSync(
    RSVG,
    ['-w', String(sizePx), '-h', String(sizePx), '--background-color=none', svgPath, '-o', dest],
    { stdio: ['ignore', 'pipe', 'inherit'] }
  )
}

function addCreamHalo(glyphPath, cream, dest) {
  magick(
    glyphPath,
    '(',
    '+clone',
    '-alpha',
    'extract',
    '-threshold',
    '1%',
    '-morphology',
    'Dilate',
    `Disk:${HALO_DISK}`,
    '-channel',
    'RGB',
    '-fill',
    cream,
    '-colorize',
    '100',
    '+channel',
    '-alpha',
    'copy',
    ')',
    '+swap',
    '-background',
    'none',
    '-compose',
    'over',
    '-composite',
    dest
  )
}

function composeIcon({ paddedLogo, cream, glyph, dest }) {
  const gPx = Math.round(CANVAS * G_SCALE)
  const glyphX = CANVAS - GLYPH_INSET - GLYPH_SIZE
  const glyphY = CANVAS - GLYPH_INSET - GLYPH_SIZE
  magick(
    '-size',
    `${CANVAS}x${CANVAS}`,
    `xc:${cream}`,
    paddedLogo,
    '-geometry',
    `${gPx}x${gPx}+${G_INSET}+${G_INSET}`,
    '-composite',
    glyph,
    '-geometry',
    `${GLYPH_SIZE}x${GLYPH_SIZE}+${glyphX}+${glyphY}`,
    '-composite',
    '-alpha',
    'off',
    '-depth',
    '8',
    `PNG24:${dest}`
  )
}

function main() {
  if (!fs.existsSync(SRC_LOGO)) {
    throw new Error(`Source logo not found: ${SRC_LOGO}`)
  }
  const cream = sampleCream(SRC_LOGO)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-app-icons-'))
  try {
    const padded = path.join(tmp, 'logo-square.png')
    squarePadLogo(SRC_LOGO, cream, padded)

    for (const app of APPS) {
      if (!fs.existsSync(app.svg)) {
        throw new Error(`Glyph SVG not found: ${app.svg}`)
      }
      fs.mkdirSync(path.dirname(app.out), { recursive: true })
      const glyphRaw = path.join(tmp, `${app.name}-glyph.png`)
      const glyphHalo = path.join(tmp, `${app.name}-glyph-halo.png`)
      rasterizeSvg(app.svg, GLYPH_SIZE, glyphRaw)
      addCreamHalo(glyphRaw, cream, glyphHalo)
      composeIcon({
        paddedLogo: padded,
        cream,
        glyph: glyphHalo,
        dest: app.out
      })
      console.log(
        `[icons] ${app.name}: ${path.relative(repoRoot, app.out)} ` +
          `(canvas ${CANVAS}, G ${Math.round(CANVAS * G_SCALE)} at +${G_INSET}+${G_INSET}, ` +
          `glyph ${GLYPH_SIZE} SE inset ${GLYPH_INSET}, cream ${cream})`
      )
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

main()
