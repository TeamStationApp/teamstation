#!/usr/bin/env node
// Builds every platform's launch-splash assets from mobile/icons/splash/:
//
//   node scripts/splash/buildSplashAssets.mjs              (socket npm run splash.assets)
//   node scripts/splash/buildSplashAssets.mjs --frames <dir> --sizes 402x874@3,1920x1080@2
//
// It renders splash.html in headless Chrome (puppeteer) and writes:
//   - timeline.js, the timeline.json splash.html reads;
//   - src/test/fixtures/splashSamples.json, the browser's computed values
//     every 50 ms at four window sizes, which every sampler is tested against,
//     and the rectangles of the rasterised brand images;
//   - scripts/splash/sources.sha256, the hash of the sources, which every
//     generated text file also records;
//   - for each platform whose directory exists: the stadium (HEIC for iOS
//     and tvOS, WebP for Android, each at most 2.5 MB), its blurred copy, the
//     mark and wordmark, the launch storyboard's frame 0 and vignette, and the
//     timeline as Swift or Kotlin constants.
// --frames writes only reference PNGs of splash.html at 0, 0.7, 1.4 and 2 s,
// each <w>x<h> CSS pixels at device scale <s>, named
// reference-<w>x<h>@<s>-t<t>.png, for the end-to-end parity checks.
/* global DOMMatrixReadOnly, getComputedStyle */
import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import puppeteer from 'puppeteer'

import {
  ANIMATED,
  brandSize,
  checkTimeline,
  coverRect,
  frameZeroCrop,
  sourceFiles,
  sourcesHash
} from './splashMath.mjs'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const SAMPLE_SIZES = [
  [390, 844],
  [1194, 834],
  [834, 1194],
  [1920, 1080]
]
export const FRAME_TIMES = [0, 0.7, 1.4, 2]
export const MAX_STADIUM_BYTES = 2.5 * 1024 * 1024
/** The window the brand images are drawn for: the largest side any target reaches. */
export const RASTER_WINDOW = [2000, 1376]
export const RASTER_SCALE = 3

const SPLASH = 'mobile/icons/splash'
const PACKAGE = 'mobile/apps/common/TeamStationSplash'
const KOTLIN = 'android/app/src/main/java/app/teamstation/app/splash'

/**
 * The iPhone and iPad launch screen's frame 0, vignette and all, rendered for
 * each window shape the apps open in, ordered by height over width. A frame
 * rendered for one shape and cropped into another moves the stadium and the
 * vignette, whose circle reaches the window's farthest corner, so the launch
 * storyboard shows the frame whose shape is nearest the window's. Each image
 * set also carries a small stand-in for the other idiom, for a window of that
 * shape (an iPad in Split View), so each device decodes only its own frames at
 * full size. The launch screen's decoded images must stay within iOS's budget,
 * about 24 MB on a simulator: past it, iOS draws the launch screen black. The
 * iPhone frames are 2x (about 19 MB for its four) and the iPad frames 0.75x
 * (about 15 MB for its six); frame 0 is the stadium zoomed 2.8 times, softer
 * than either.
 */
export const IOS_LAUNCH_SHAPES = [
  { idiom: 'iphone', w: 844, h: 390, scale: 2 },
  { idiom: 'iphone', w: 667, h: 375, scale: 2 },
  { idiom: 'ipad', w: 1133, h: 744, scale: 0.75 },
  { idiom: 'ipad', w: 1210, h: 834, scale: 0.75 },
  { idiom: 'ipad', w: 1376, h: 1032, scale: 0.75 },
  { idiom: 'ipad', w: 1032, h: 1376, scale: 0.75 },
  { idiom: 'ipad', w: 834, h: 1210, scale: 0.75 },
  { idiom: 'ipad', w: 744, h: 1133, scale: 0.75 },
  { idiom: 'iphone', w: 375, h: 667, scale: 2 },
  { idiom: 'iphone', w: 390, h: 844, scale: 2 }
]

/** The television's window: always 1920x1080 points. */
export const TV_LAUNCH_SHAPE = { w: 1920, h: 1080, scale: 1 }

/** The stand-in's width in pixels. */
export const STAND_IN_WIDTH = 96

/** A launch shape's image set name. */
export const launchSetName = shape => `LaunchFrame${shape.w}x${shape.h}`

/**
 * Where the storyboard moves from one shape to the next, as height over width:
 * the geometric mean of the two shapes' ratios.
 */
export function launchThresholds(shapes = IOS_LAUNCH_SHAPES) {
  const ratios = shapes.map(shape => shape.h / shape.w)
  return ratios.slice(1).map((ratio, i) => Math.sqrt(ratio * ratios[i]))
}

/**
 * The launch storyboard. The first shape's frame fills the window; above it,
 * the frame of each further shape fills the window inside a gate that is open
 * while the window's height is more than the threshold times its width. The
 * gate's height is min(H, 10000 * max(0, H - t * W)): a hidden helper as tall
 * as t * W, and below it one as tall as what is left of the window, at least 0.
 */
export function launchStoryboard(shapes = IOS_LAUNCH_SHAPES) {
  const root = 'Ze5-6b-2t3'
  const thresholds = launchThresholds(shapes)
  const views = []
  const constraints = []
  const pin = (id, to = root) => {
    for (const edge of ['leading', 'top', 'trailing', 'bottom'])
      constraints.push(
        `<constraint firstItem="${id}" firstAttribute="${edge}" secondItem="${to}" secondAttribute="${edge}" id="${id}-${edge}"/>`
      )
  }
  const image = (id, shape) =>
    `<imageView clipsSubviews="YES" userInteractionEnabled="NO" contentMode="scaleAspectFill" horizontalHuggingPriority="251" verticalHuggingPriority="251" image="${launchSetName(shape)}" translatesAutoresizingMaskIntoConstraints="NO" id="${id}" userLabel="Frame 0 for ${shape.w}x${shape.h}">
                                <rect key="frame" x="0.0" y="0.0" width="375" height="667"/>
                            </imageView>`
  views.push(image('LF0-img', shapes[0]))
  pin('LF0-img')
  thresholds.forEach((t, k) => {
    const i = k + 1
    const [square, rest, gate, img] = [
      `LF${i}-sqr`,
      `LF${i}-rst`,
      `LF${i}-gat`,
      `LF${i}-img`
    ]
    const helper = (id, label) =>
      `<view hidden="YES" userInteractionEnabled="NO" contentMode="scaleToFill" translatesAutoresizingMaskIntoConstraints="NO" id="${id}" userLabel="${label}">
                                <rect key="frame" x="0.0" y="0.0" width="1" height="1"/>
                            </view>`
    views.push(helper(square, `${t.toFixed(4)} x width`))
    views.push(helper(rest, `Height past ${t.toFixed(4)} x width`))
    views.push(`<view clipsSubviews="YES" userInteractionEnabled="NO" contentMode="scaleToFill" translatesAutoresizingMaskIntoConstraints="NO" id="${gate}" userLabel="Open above ${t.toFixed(4)}">
                                <rect key="frame" x="0.0" y="0.0" width="375" height="667"/>
                                <subviews>
                                    ${image(img, shapes[i])}
                                </subviews>
                            </view>`)
    constraints.push(
      `<constraint firstItem="${square}" firstAttribute="leading" secondItem="${root}" secondAttribute="leading" id="${square}-leading"/>`,
      `<constraint firstItem="${square}" firstAttribute="top" secondItem="${root}" secondAttribute="top" id="${square}-top"/>`,
      `<constraint firstItem="${square}" firstAttribute="width" constant="1" id="${square}-width"/>`,
      `<constraint firstItem="${square}" firstAttribute="height" secondItem="${root}" secondAttribute="width" multiplier="${t}" id="${square}-height"/>`,
      `<constraint firstItem="${rest}" firstAttribute="leading" secondItem="${root}" secondAttribute="leading" id="${rest}-leading"/>`,
      `<constraint firstItem="${rest}" firstAttribute="top" secondItem="${square}" secondAttribute="bottom" id="${rest}-top"/>`,
      `<constraint firstItem="${rest}" firstAttribute="width" constant="1" id="${rest}-width"/>`,
      `<constraint firstItem="${rest}" firstAttribute="height" relation="greaterThanOrEqual" constant="0.0" id="${rest}-floor"/>`,
      `<constraint firstItem="${rest}" firstAttribute="bottom" secondItem="${root}" secondAttribute="bottom" priority="999" id="${rest}-bottom"/>`,
      `<constraint firstItem="${gate}" firstAttribute="leading" secondItem="${root}" secondAttribute="leading" id="${gate}-leading"/>`,
      `<constraint firstItem="${gate}" firstAttribute="top" secondItem="${root}" secondAttribute="top" id="${gate}-top"/>`,
      `<constraint firstItem="${gate}" firstAttribute="trailing" secondItem="${root}" secondAttribute="trailing" id="${gate}-trailing"/>`,
      `<constraint firstItem="${gate}" firstAttribute="height" relation="lessThanOrEqual" secondItem="${root}" secondAttribute="height" id="${gate}-most"/>`,
      `<constraint firstItem="${gate}" firstAttribute="height" relation="lessThanOrEqual" secondItem="${rest}" secondAttribute="height" multiplier="10000" id="${gate}-open"/>`,
      `<constraint firstItem="${gate}" firstAttribute="height" secondItem="${root}" secondAttribute="height" priority="750" id="${gate}-full"/>`
    )
    pin(img)
  })
  const resources = shapes
    .map(
      shape =>
        `        <image name="${launchSetName(shape)}" width="${shape.w}" height="${shape.h}"/>`
    )
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- Generated by scripts/splash/buildSplashAssets.mjs: do not edit. -->
<document type="com.apple.InterfaceBuilder3.CocoaTouch.Storyboard.XIB" version="3.0" toolsVersion="15702" targetRuntime="iOS.CocoaTouch" propertyAccessControl="none" useAutolayout="YES" launchScreen="YES" useTraitCollections="YES" useSafeAreas="YES" colorMatched="YES" initialViewController="01J-lp-oVM">
    <device id="retina4_7" orientation="portrait" appearance="light"/>
    <dependencies>
        <deployment identifier="iOS"/>
        <plugIn identifier="com.apple.InterfaceBuilder.IBCocoaTouchPlugin" version="15704"/>
        <capability name="Safe area layout guides" minToolsVersion="9.0"/>
        <capability name="documents saved in the Xcode 8 format" minToolsVersion="8.0"/>
    </dependencies>
    <scenes>
        <!--The launch splash's frame 0, vignette and all, for the window shape nearest the window's, which TeamStationSplash then animates.-->
        <scene sceneID="EHf-IW-A2E">
            <objects>
                <viewController id="01J-lp-oVM" sceneMemberID="viewController">
                    <view key="view" contentMode="scaleToFill" id="${root}">
                        <rect key="frame" x="0.0" y="0.0" width="375" height="667"/>
                        <autoresizingMask key="autoresizingMask" widthSizable="YES" heightSizable="YES"/>
                        <subviews>
                            ${views.join('\n                            ')}
                        </subviews>
                        <color key="backgroundColor" red="0.050980392156862744" green="0.12156862745098039" blue="0.050980392156862744" alpha="1" colorSpace="custom" customColorSpace="sRGB"/>
                        <constraints>
                            ${constraints.join('\n                            ')}
                        </constraints>
                        <viewLayoutGuide key="safeArea" id="Bcu-3y-fUS"/>
                    </view>
                </viewController>
                <placeholder placeholderIdentifier="IBFirstResponder" id="iYj-Kq-Ea1" userLabel="First Responder" sceneMemberID="firstResponder"/>
            </objects>
            <point key="canvasLocation" x="52.173913043478265" y="375"/>
        </scene>
    </scenes>
    <resources>
${resources}
    </resources>
</document>
`
}

/** Which platform targets exist under `outRoot`, by their directories. */
export function targetsPresent(outRoot) {
  return {
    swift: existsSync(join(outRoot, PACKAGE)),
    ios: existsSync(join(outRoot, 'ios/TeamStation/LaunchScreen.storyboard')),
    tv: existsSync(
      join(
        outRoot,
        'appletv/ios/TeamStationTV/Images.xcassets/LaunchFrame.imageset'
      )
    ),
    android: existsSync(join(outRoot, KOTLIN))
  }
}

/** `402x874@3,1920x1080` → [{ w, h, scale }]. */
export function parseSizes(text) {
  return text.split(',').map(part => {
    const match = /^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)(?:@(\d+(?:\.\d+)?))?$/.exec(
      part.trim()
    )
    if (match == null)
      throw new Error(`Not a size: ${part} (want <w>x<h>[@<scale>])`)
    return {
      w: Number(match[1]),
      h: Number(match[2]),
      scale: Number(match[3] ?? 1)
    }
  })
}

/** Throws with an install hint unless every tool is on the PATH. */
export function requireTools(tools, path = process.env.PATH ?? '') {
  for (const tool of tools) {
    const found = path
      .split(':')
      .some(dir => dir !== '' && existsSync(join(dir, tool)))
    if (!found)
      throw new Error(
        `${tool} is not on the PATH; install it (brew install ${tool === 'cwebp' ? 'webp' : tool})`
      )
  }
}

/** The first lines of every generated text file. */
export function header(comment, hash) {
  return `${comment} Generated by scripts/splash/buildSplashAssets.mjs from sources sha256 ${hash}. Do not edit.\n`
}

/** timeline.js, which splash.html loads. */
export function timelineJs(timeline, hash) {
  return `${header('//', hash)}window.SPLASH_TIMELINE = ${JSON.stringify(timeline, null, 2)}\n`
}

const hexColour = hex => `0x${hex.slice(1).toLowerCase()}`
const num = n => (Number.isInteger(n) ? `${n}.0` : String(n))

/** The timeline and raster rectangles as Swift constants for TeamStationSplashCore. */
export function swiftConstants(timeline, raster, hash) {
  const L = timeline.layers
  const gradient = g =>
    `SplashGradient(centerX: ${num(g.center[0])}, centerY: ${num(g.center[1])}, stops: [${g.stops
      .map(
        ([at, hex, a]) =>
          `SplashStop(at: ${num(at)}, rgb: ${hexColour(hex)}, alpha: ${num(a)})`
      )
      .join(', ')}])`
  const layer = name =>
    `SplashLayerTracks(easing: [${L[name].easing.map(num).join(', ')}], tracks: [${ANIMATED[
      name
    ]
      .map(
        track =>
          `"${track}": SplashTrack([${L[name].tracks[track].map(([at, v]) => `(${num(at)}, ${num(v)})`).join(', ')}])`
      )
      .join(', ')}])`
  const rect = r =>
    `SplashRect(x: ${num(r.x)}, y: ${num(r.y)}, width: ${num(r.width)}, height: ${num(r.height)})`
  const s = timeline.stadium
  return `${header('//', hash)}
/// The splash timeline from mobile/icons/splash/timeline.json, and where the
/// rasterised brand images sit, in units of the mark's side from its centre.
public enum SplashTimeline {
  public static let durationMs = ${num(timeline.durationMs)}
  public static let designWidth = ${num(timeline.design.width)}
  public static let designHeight = ${num(timeline.design.height)}
  public static let designSide = ${num(timeline.design.side)}
  public static let stadiumWidth = ${num(s.width)}
  public static let stadiumHeight = ${num(s.height)}
  public static let focusX = ${num(s.focus[0])}
  public static let focusY = ${num(s.focus[1])}
  public static let bleed = ${num(s.bleed)}
  public static let bakedBrightness = ${num(s.bakedBrightness)}
  public static let base = ${gradient(L.base)}
  public static let dark = ${gradient(L.dark)}
  public static let vignette = ${gradient(L.vignette)}
  public static let glow = ${gradient(L.glow)}
  public static let glowSize = ${num(L.glow.size)}
  public static let markCenterX = ${num(L.mark.center[0])}
  public static let markCenterY = ${num(L.mark.center[1])}
  public static let markBlurMax = ${num(L.mark.tracks.blur[0][1])}
  public static let stadiumTracks = ${layer('stadium')}
  public static let darkTracks = ${layer('dark')}
  public static let glowTracks = ${layer('glow')}
  public static let markTracks = ${layer('mark')}
  public static let wordmarkTracks = ${layer('wordmark')}
  public static let markImage = ${rect(raster.mark)}
  public static let wordmarkImage = ${rect(raster.wordmark)}
  public static let wordmarkBox = ${rect(raster.wordmarkBox)}
  public static let wordmarkRestY = ${num(L.wordmark.tracks.translateY.at(-1)[1])}
  public static let fadeMs = ${num(timeline.dismiss.fadeMs)}
  public static let capMs = ${num(timeline.dismiss.capMs)}
}
`
}

/** The same constants for Kotlin, in app.teamstation.app.splash. */
export function kotlinConstants(timeline, raster, hash) {
  const L = timeline.layers
  const gradient = g =>
    `SplashGradient(${num(g.center[0])}, ${num(g.center[1])}, listOf(${g.stops
      .map(
        ([at, hex, a]) => `SplashStop(${num(at)}, ${hexColour(hex)}, ${num(a)})`
      )
      .join(', ')}))`
  const layer = name =>
    `SplashLayerTracks(listOf(${L[name].easing.map(num).join(', ')}), mapOf(${ANIMATED[
      name
    ]
      .map(
        track =>
          `"${track}" to SplashTrack(listOf(${L[name].tracks[track].map(([at, v]) => `${num(at)} to ${num(v)}`).join(', ')}))`
      )
      .join(', ')}))`
  const rect = r =>
    `SplashRect(${num(r.x)}, ${num(r.y)}, ${num(r.width)}, ${num(r.height)})`
  const s = timeline.stadium
  return `${header('//', hash)}
package app.teamstation.app.splash

/**
 * The splash timeline from mobile/icons/splash/timeline.json, and where the
 * rasterised brand images sit, in units of the mark's side from its centre.
 */
object SplashTimeline {
  const val DURATION_MS = ${num(timeline.durationMs)}
  const val DESIGN_WIDTH = ${num(timeline.design.width)}
  const val DESIGN_HEIGHT = ${num(timeline.design.height)}
  const val DESIGN_SIDE = ${num(timeline.design.side)}
  const val STADIUM_WIDTH = ${num(s.width)}
  const val STADIUM_HEIGHT = ${num(s.height)}
  const val FOCUS_X = ${num(s.focus[0])}
  const val FOCUS_Y = ${num(s.focus[1])}
  const val BLEED = ${num(s.bleed)}
  const val BAKED_BRIGHTNESS = ${num(s.bakedBrightness)}
  val BASE = ${gradient(L.base)}
  val DARK = ${gradient(L.dark)}
  val VIGNETTE = ${gradient(L.vignette)}
  val GLOW = ${gradient(L.glow)}
  const val GLOW_SIZE = ${num(L.glow.size)}
  const val MARK_CENTER_X = ${num(L.mark.center[0])}
  const val MARK_CENTER_Y = ${num(L.mark.center[1])}
  const val MARK_BLUR_MAX = ${num(L.mark.tracks.blur[0][1])}
  val STADIUM_TRACKS = ${layer('stadium')}
  val DARK_TRACKS = ${layer('dark')}
  val GLOW_TRACKS = ${layer('glow')}
  val MARK_TRACKS = ${layer('mark')}
  val WORDMARK_TRACKS = ${layer('wordmark')}
  val MARK_IMAGE = ${rect(raster.mark)}
  val WORDMARK_IMAGE = ${rect(raster.wordmark)}
  val WORDMARK_BOX = ${rect(raster.wordmarkBox)}
  const val WORDMARK_REST_Y = ${num(L.wordmark.tracks.translateY.at(-1)[1])}
  const val FADE_MS = ${num(timeline.dismiss.fadeMs)}
  const val CAP_MS = ${num(timeline.dismiss.capMs)}
}
`
}

/** An asset catalog image set holding one universal image. */
export function imageSetContents(filename) {
  return idiomImageSetContents([{ filename, idiom: 'universal' }])
}

/** An image set's Contents.json with one image per idiom. */
export function idiomImageSetContents(images) {
  return `${JSON.stringify({ images, info: { author: 'xcode', version: 1 } }, null, 2)}\n`
}

/**
 * Re-encodes `png` into `out` (HEIC with sips, WebP with cwebp, or JPEG with
 * sips) at the highest quality from 90 down that is at most `maxBytes`.
 */
export function encodeUnder(
  png,
  out,
  format,
  maxBytes = Infinity,
  run = execFileSync
) {
  for (let quality = 90; quality >= 40; quality -= 5) {
    if (format === 'webp')
      run('cwebp', ['-quiet', '-q', String(quality), png, '-o', out])
    else
      run(
        'sips',
        [
          '-s',
          'format',
          format,
          '-s',
          'formatOptions',
          String(quality),
          png,
          '--out',
          out
        ],
        { stdio: 'ignore' }
      )
    if (statSync(out).size <= maxBytes) return quality
  }
  throw new Error(`${out} is still over ${maxBytes} bytes at quality 40`)
}

/** Opens splash.html at `w`×`h` CSS pixels and device scale `scale`. */
async function openSplash(page, root, { w, h, scale = 1, query = '' }) {
  await page.setViewport({
    width: Math.round(w),
    height: Math.round(h),
    deviceScaleFactor: scale
  })
  const url = pathToFileURL(join(root, SPLASH, 'splash.html'))
  url.search = `w=${w}&h=${h}&t=0${query}`
  await page.goto(url.href, { waitUntil: 'load' })
  await page.evaluate(() => window.splashReady)
}

/** The animated values the page computes now, in design units (lengths ÷ k). */
async function readComputed(page) {
  return page.evaluate(() => {
    const style = selector => getComputedStyle(document.querySelector(selector))
    const matrix = selector => new DOMMatrixReadOnly(style(selector).transform)
    const filter = (selector, name) => {
      const match = new RegExp(`${name}\\(([-\\d.e]+)(px)?\\)`).exec(
        style(selector).filter
      )
      return match == null ? (name === 'blur' ? 0 : 1) : Number(match[1])
    }
    const k = Number(
      getComputedStyle(document.getElementById('stage')).getPropertyValue('--k')
    )
    return {
      k,
      stadium: {
        scale: matrix('.stadium').a,
        opacity: Number(style('.stadium').opacity),
        brightness: filter('.stadium', 'brightness'),
        contrast: filter('.stadium', 'contrast'),
        blur: filter('.stadium', 'blur') / k
      },
      dark: { opacity: Number(style('.dark').opacity) },
      glow: {
        opacity: Number(style('.glow').opacity),
        scale: matrix('.glow').a
      },
      mark: {
        opacity: Number(style('.logo').opacity),
        scale: matrix('.logo').a,
        blur: filter('.logo', 'blur') / k
      },
      wordmark: {
        opacity: Number(style('.wordmark').opacity),
        translateY: matrix('.wordmark').f / k,
        scale: matrix('.wordmark').a
      }
    }
  })
}

/** splashSamples' samples: every 50 ms at each size. */
export async function sampleBrowser(
  page,
  root,
  sizes = SAMPLE_SIZES,
  stepMs = 50,
  durationMs = 2000
) {
  const out = {}
  for (const [w, h] of sizes) {
    await openSplash(page, root, { w, h })
    const rows = []
    for (let ms = 0; ms <= durationMs; ms += stepMs) {
      await page.evaluate(at => window.splashSeek(at), ms)
      rows.push({ ms, ...(await readComputed(page)) })
    }
    out[`${w}x${h}`] = rows
  }
  return out
}

/**
 * Rasterises one brand layer (`only=` in splash.html) at RASTER_WINDOW and
 * RASTER_SCALE, padded for its shadows and blur. Returns the PNG and its
 * rectangle in units of the mark's side, from the mark's centre.
 */
async function rasterBrand(page, root, only, file) {
  const [w, h] = RASTER_WINDOW
  await openSplash(page, root, {
    w,
    h,
    scale: RASTER_SCALE,
    query: `&only=${only}`
  })
  const box = await page.evaluate(which => {
    const logo = document.querySelector('.logo').getBoundingClientRect()
    const target = which.startsWith('wordmark')
      ? document.querySelector('.wordmark h1').getBoundingClientRect()
      : logo
    return {
      logo: { x: logo.x, y: logo.y, width: logo.width, height: logo.height },
      target: {
        x: target.x,
        y: target.y,
        width: target.width,
        height: target.height
      }
    }
  }, only)
  const side = box.logo.width
  const pad = side * 0.5
  const clip = {
    x: box.target.x - pad,
    y: box.target.y - pad,
    width: box.target.width + 2 * pad,
    height: box.target.height + 2 * pad
  }
  await page.screenshot({ path: file, clip, omitBackground: true })
  const cx = box.logo.x + side / 2
  const cy = box.logo.y + side / 2
  const unit = r => ({
    x: (r.x - cx) / side,
    y: (r.y - cy) / side,
    width: r.width / side,
    height: r.height / side
  })
  return { rect: unit(clip), box: unit(box.target) }
}

/** Screenshots a full-page render of `html` at `w`×`h`. */
async function shootHtml(page, html, w, h, file) {
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 })
  await page.setContent(html, { waitUntil: 'load' })
  await page.screenshot({ path: file, omitBackground: false })
}

/** The stadium with the design's base brightness and contrast, and optionally a blur. */
export function stadiumHtml(
  root,
  timeline,
  blurPx = 0,
  width = timeline.stadium.width
) {
  const s = timeline.stadium
  const height = Math.round((width * s.height) / s.width)
  const src = pathToFileURL(join(root, SPLASH, 'stadium.jpg')).href
  const filter = `brightness(${s.bakedBrightness}) contrast(${s.bakedContrast})`
  const img = (extra, z) =>
    `<img src="${src}" style="position:absolute;inset:0;width:${width}px;height:${height}px;filter:${filter}${extra};z-index:${z}">`
  return `<html><body style="margin:0;background:#000">${img('', 0)}${blurPx > 0 ? img(` blur(${blurPx}px)`, 1) : ''}</body></html>`
}

/** Writes the reference frames for `sizes` into `dir`; returns their paths. */
export async function writeFrames(page, root, dir, sizes, times = FRAME_TIMES) {
  mkdirSync(dir, { recursive: true })
  const written = []
  for (const { w, h, scale } of sizes) {
    await openSplash(page, root, { w, h, scale })
    for (const t of times) {
      await page.evaluate(ms => window.splashSeek(ms), t * 1000)
      const file = join(dir, `reference-${w}x${h}@${scale}-t${t}.png`)
      await page.screenshot({ path: file })
      written.push(file)
    }
  }
  return written
}

const write = (file, text) => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
}

/**
 * The whole build. `outRoot` is where the outputs go (the repository, or a
 * test's temporary copy); the sources are always read from `root`.
 */
export async function build({
  root = ROOT,
  outRoot = root,
  log = console.log
} = {}) {
  const timeline = checkTimeline(
    JSON.parse(readFileSync(join(root, SPLASH, 'timeline.json'), 'utf8'))
  )
  const hash = sourcesHash(root, sourceFiles(root))
  const targets = targetsPresent(outRoot)
  if (targets.swift || targets.ios || targets.tv) requireTools(['sips'])
  if (targets.android) requireTools(['cwebp'])
  write(join(outRoot, SPLASH, 'timeline.js'), timelineJs(timeline, hash))
  // splash.html reads timeline.js from beside itself, in the sources.
  if (outRoot !== root)
    copyFileSync(
      join(outRoot, SPLASH, 'timeline.js'),
      join(root, SPLASH, 'timeline.js')
    )
  write(join(outRoot, 'scripts/splash/sources.sha256'), `${hash}\n`)

  const temp = mkdtempSync(join(tmpdir(), 'splash-'))
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--allow-file-access-from-files']
  })
  try {
    const page = await browser.newPage()
    const samples = await sampleBrowser(page, root)
    const raster = {}
    for (const only of ['mark', 'markBlurred', 'wordmark', 'wordmarkBlurred']) {
      const { rect, box } = await rasterBrand(
        page,
        root,
        only,
        join(temp, `${only}.png`)
      )
      raster[only] = rect
      if (only === 'wordmark') raster.wordmarkBox = box
    }
    write(
      join(outRoot, 'src/test/fixtures/splashSamples.json'),
      `${JSON.stringify({ sourcesSha256: hash, raster, samples }, null, 1)}\n`
    )
    log(`samples: ${Object.keys(samples).length} sizes`)
    if (!(targets.swift || targets.ios || targets.tv || targets.android))
      return { hash, targets, raster }

    const s = timeline.stadium
    const phone = coverRect(
      timeline,
      timeline.design.width,
      timeline.design.height
    )
    const blurPx = (4 * s.blurredWidth) / phone.width
    await shootHtml(
      page,
      stadiumHtml(root, timeline),
      s.width,
      s.height,
      join(temp, 'stadium.png')
    )
    const blurredHeight = Math.round((s.blurredWidth * s.height) / s.width)
    await shootHtml(
      page,
      stadiumHtml(root, timeline, blurPx, s.blurredWidth),
      s.blurredWidth,
      blurredHeight,
      join(temp, 'stadiumBlurred.png')
    )
    // The placeholder the apps draw over the stadium element until the 4K
    // stadium has decoded: the element's frame 0, the crop's own shape, with
    // the dark layer and without the bleed, so filling the element shows
    // exactly what the stadium will.
    const crop = frameZeroCrop(timeline)
    await openSplash(page, root, {
      w: crop.width,
      h: crop.height,
      query: '&novignette&nobrand&nobleed'
    })
    await page.screenshot({ path: join(temp, 'launchFrame.png') })
    // The TV's launch storyboard: frame 0 of its window, vignette included,
    // which fills the window.
    await openSplash(page, root, { ...TV_LAUNCH_SHAPE, query: '&nobrand' })
    await page.screenshot({ path: join(temp, 'launchFrameTv.png') })
    if (targets.ios)
      for (const shape of IOS_LAUNCH_SHAPES) {
        await openSplash(page, root, { ...shape, query: '&nobrand' })
        await page.screenshot({
          path: join(temp, `${launchSetName(shape)}.png`)
        })
      }

    if (targets.swift) {
      const res = join(outRoot, PACKAGE, 'Sources/TeamStationSplash/Resources')
      mkdirSync(res, { recursive: true })
      const q = encodeUnder(
        join(temp, 'stadium.png'),
        join(res, 'splashStadium.heic'),
        'heic',
        MAX_STADIUM_BYTES
      )
      encodeUnder(
        join(temp, 'stadiumBlurred.png'),
        join(res, 'splashStadiumBlurred.jpg'),
        'jpeg'
      )
      // What the view shows until the full stadium has decoded: frame 0,
      // under the view's own vignette.
      encodeUnder(
        join(temp, 'launchFrame.png'),
        join(res, 'splashLaunchFrame.jpg'),
        'jpeg'
      )
      for (const only of ['mark', 'markBlurred', 'wordmark', 'wordmarkBlurred'])
        copyFileSync(
          join(temp, `${only}.png`),
          join(res, `splash${only[0].toUpperCase()}${only.slice(1)}.png`)
        )
      write(
        join(
          outRoot,
          PACKAGE,
          'Sources/TeamStationSplashCore/SplashTimeline.swift'
        ),
        swiftConstants(timeline, raster, hash)
      )
      log(`swift: stadium HEIC at quality ${q}`)
    }
    if (targets.ios) {
      const catalog = join(outRoot, 'ios/TeamStation/Images.xcassets')
      for (const shape of IOS_LAUNCH_SHAPES) {
        const name = launchSetName(shape)
        const other = shape.idiom === 'iphone' ? 'ipad' : 'iphone'
        const dir = join(catalog, `${name}.imageset`)
        mkdirSync(dir, { recursive: true })
        encodeUnder(join(temp, `${name}.png`), join(dir, `${name}.jpg`), 'jpeg')
        execFileSync('sips', [
          '--resampleWidth',
          String(STAND_IN_WIDTH),
          join(temp, `${name}.png`),
          '--out',
          join(temp, `${name}-standin.png`)
        ])
        encodeUnder(
          join(temp, `${name}-standin.png`),
          join(dir, `${name}-${other}.jpg`),
          'jpeg'
        )
        write(
          join(dir, 'Contents.json'),
          idiomImageSetContents([
            { filename: `${name}.jpg`, idiom: shape.idiom },
            { filename: `${name}-${other}.jpg`, idiom: other }
          ])
        )
      }
      write(
        join(outRoot, 'ios/TeamStation/LaunchScreen.storyboard'),
        launchStoryboard()
      )
      log(
        `ios: launch frames ${IOS_LAUNCH_SHAPES.map(shape => `${shape.w}x${shape.h}@${shape.scale}`).join(', ')}`
      )
    }
    if (targets.tv) {
      // A television's window is always 1920x1080 points.
      const frameSet = join(
        outRoot,
        'appletv/ios/TeamStationTV/Images.xcassets/LaunchFrame.imageset'
      )
      encodeUnder(
        join(temp, 'launchFrameTv.png'),
        join(frameSet, 'LaunchFrame.jpg'),
        'jpeg'
      )
      write(
        join(frameSet, 'Contents.json'),
        imageSetContents('LaunchFrame.jpg')
      )
      log(`tv: launch frame ${TV_LAUNCH_SHAPE.w}x${TV_LAUNCH_SHAPE.h}`)
    }
    if (targets.android) {
      const res = join(outRoot, 'android/app/src/main/res/drawable-nodpi')
      mkdirSync(res, { recursive: true })
      const q = encodeUnder(
        join(temp, 'stadium.png'),
        join(res, 'splash_stadium.webp'),
        'webp',
        MAX_STADIUM_BYTES
      )
      encodeUnder(
        join(temp, 'stadiumBlurred.png'),
        join(res, 'splash_stadium_blurred.webp'),
        'webp'
      )
      for (const [only, name] of [
        ['mark', 'splash_mark'],
        ['markBlurred', 'splash_mark_blurred'],
        ['wordmark', 'splash_wordmark'],
        ['wordmarkBlurred', 'splash_wordmark_blurred']
      ])
        copyFileSync(join(temp, `${only}.png`), join(res, `${name}.png`))
      write(
        join(outRoot, KOTLIN, 'SplashTimeline.kt'),
        kotlinConstants(timeline, raster, hash)
      )
      log(`android: stadium WebP at quality ${q}`)
    }
    return { hash, targets, raster }
  } finally {
    await browser.close()
    rmSync(temp, { recursive: true, force: true })
  }
}

/** Reads the command line. */
export function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--frames') args.frames = argv[++i]
    else if (argv[i] === '--sizes') args.sizes = parseSizes(argv[++i] ?? '')
    else throw new Error(`Unknown argument ${argv[i]}`)
  }
  if ((args.frames == null) !== (args.sizes == null))
    throw new Error('--frames and --sizes go together')
  return args
}

/** The command. */
export async function main(argv, { root = ROOT, log = console.log } = {}) {
  const args = parseArgs(argv)
  if (args.frames == null) {
    await build({ root, log })
    return
  }
  const timeline = checkTimeline(
    JSON.parse(readFileSync(join(root, SPLASH, 'timeline.json'), 'utf8'))
  )
  const browser = await puppeteer.launch({ headless: true })
  try {
    const page = await browser.newPage()
    const files = await writeFrames(
      page,
      root,
      resolve(args.frames),
      args.sizes
    )
    for (const file of files) log(file)
    for (const { w, h } of args.sizes) {
      const { side } = brandSize(timeline, w, h)
      log(`${w}x${h}: mark side ${side.toFixed(1)}`)
    }
  } finally {
    await browser.close()
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).catch(error => {
    console.error(error.message)
    process.exitCode = 1
  })
