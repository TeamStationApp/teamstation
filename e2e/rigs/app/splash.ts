import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { PNG } from 'pngjs'

import {
  defineHarness,
  type HarnessContext,
  type HarnessSpec
} from '../../core/spec'
import { reference as visualReference } from '../../core/visual'

/**
 * The launch splash's end-to-end steps, shared by the phone, iPad and Android
 * specs in e2e/tests/app-shell/splash. The splash reports itself in its
 * accessibility value (iOS) or content description (Android) as
 * `ready <w>x<h>@<scale>` once React Native has drawn; the driver's own
 * hierarchy dump carries both, so that is what is read.
 */

const compare: {
  compareImages: (
    a: { width: number; height: number; data: Uint8Array },
    b: { width: number; height: number; data: Uint8Array },
    options?: { maskTop?: number; fit?: number }
  ) => { pass: boolean; reason: string }
} = require('../../../scripts/splash/compareToReference.mjs')

export const FRAME_TIMES = [0, 0.7, 1.4, 2]

export interface SplashTarget {
  platform: 'ios' | 'android'
  /** The app id the caller passed for the platform's app. */
  appId: string
  /** Points (or dp) of status bar the reference does not draw, left out of the comparison. */
  statusBar: number
  /** A prefix for checkpoint and artifact names, such as `phone`. */
  name: string
}

export interface SplashReport {
  ready: boolean
  width: number
  height: number
  scale: number
}

/** The splash's report in a raw hierarchy dump, or undefined when it is not on screen. */
export function readReport(raw: string): SplashReport | undefined {
  const match =
    /(ready|loading) (\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)@(\d+(?:\.\d+)?)/.exec(raw)
  if (match == null) return undefined
  return {
    ready: match[1] === 'ready',
    width: Number(match[2]),
    height: Number(match[3]),
    scale: Number(match[4])
  }
}

/** The reference frame's file name for a report and a time. */
export function referenceName(report: SplashReport, t: number): string {
  return `reference-${report.width}x${report.height}@${report.scale}-t${t}.png`
}

const sleep = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

/** Waits until the splash says React Native has drawn, and returns its report. */
export async function waitReady(
  device: any,
  timeoutMs = 30_000
): Promise<SplashReport> {
  const until = Date.now() + timeoutMs
  for (;;) {
    const raw = String(await device.hierarchyRaw())
    const report = readReport(raw)
    if (report?.ready === true) return report
    if (Date.now() > until)
      throw new Error(
        `The splash never reported ready: ${report == null ? 'not on screen' : 'still loading'}`
      )
    await sleep(250)
  }
}

/** Launches the app cold with the splash frozen at `t` seconds. */
export async function launchFrozen(
  device: any,
  target: SplashTarget,
  t: number
): Promise<SplashReport> {
  await device.stopApp(target.appId)
  await device.launchApp({
    appId: target.appId,
    arguments: { TSSplashFreezeAt: t }
  })
  return await waitReady(device)
}

/**
 * A checkpoint whose read-back saves what the screen shows now and compares it
 * with the reference page at the size and scale the splash reports, frozen at
 * `t` seconds. The reference is rendered on first use for each size.
 */
export async function compareNow(
  ctx: HarnessContext,
  device: any,
  target: SplashTarget,
  report: SplashReport,
  t: number
): Promise<void> {
  const reference = visualReference({
    dir: join(ctx.runDir, 'reference'),
    size: `${report.width}x${report.height}@${report.scale}`,
    t
  })
  const id = `splash-${target.name}-t${t}`
  await ctx.checkpoint(id, {
    readBack: async () => {
      const shot = ctx.artifact(`${id}.png`)
      writeFileSync(shot, await device.screenshot())
      const read = (file: string): PNG => PNG.sync.read(readFileSync(file))
      const result = compare.compareImages(read(shot), read(reference), {
        maskTop: target.statusBar * report.scale,
        // Android's 2.625 density leaves the page a pixel short of the screen.
        fit: 3
      })
      if (!result.pass) throw new Error(`${id}: ${result.reason}`)
      console.log(`${id}: ${result.reason}`)
    }
  })
}

/**
 * The frames scenario: for each time, a frozen cold launch, then a checkpoint
 * comparing the screen with the reference page at the reported size.
 */
export async function frames(
  ctx: HarnessContext,
  device: any,
  target: SplashTarget,
  times: number[] = FRAME_TIMES
): Promise<void> {
  for (const t of times) {
    const report = await launchFrozen(device, target, t)
    await compareNow(ctx, device, target, report, t)
  }
}

/**
 * Waits until the splash has left the hierarchy and stays gone for three reads
 * in a row: a single read taken while the main thread is busy can come back
 * without it.
 */
export async function waitGone(device: any, timeoutMs: number): Promise<void> {
  const until = Date.now() + timeoutMs
  let absent = 0
  while (absent < 3) {
    const raw = String(await device.hierarchyRaw())
    absent = raw.includes(SPLASH) ? 0 : absent + 1
    if (absent < 3 && Date.now() > until)
      throw new Error(`The splash was still up after ${timeoutMs} ms`)
    if (absent < 3) await sleep(150)
  }
}

/**
 * Cold-launches the app: the splash is up at once, then gone within 6 s, which
 * is React Native's start (the splash holds frame 0 through it) plus the 2 s
 * animation, with room for a slow simulator.
 */
export async function dismissal(
  device: any,
  target: SplashTarget
): Promise<void> {
  await device.stopApp(target.appId)
  await device.launchApp({ appId: target.appId })
  // UiAutomator waits for the screen to idle before it dumps the hierarchy,
  // so on Android the first dump can come after the splash has gone; the
  // frames scenario proves it was there.
  if (target.platform === 'ios')
    await device.assertVisible({ id: SPLASH, timeout: 3_000 })
  await waitGone(device, 6_000)
}

/** The splash's id in the hierarchy, while it is up. */
const SPLASH = 'tsSplash'

/**
 * Whether the splash is up in any of `reads` reads taken over `windowMs`.
 * A cold launch holds the splash's frame 0 through React Native's start and
 * then plays its 2 s animation, so a process started afresh shows it for
 * seconds; a resumed one never does.
 */
export async function splashSeen(
  device: any,
  windowMs = 1_500,
  reads = 5
): Promise<boolean> {
  for (let read = 0; read < reads; read++) {
    if (String(await device.hierarchyRaw()).includes(SPLASH)) return true
    if (read < reads - 1) await sleep(windowMs / (reads - 1))
  }
  return false
}

/**
 * Launches, waits out the splash, backgrounds the app and brings the same
 * process back with maestro-d's launchApp, told not to stop it. A new
 * process would draw the splash again, so its absence through the first
 * moments back proves the app resumed.
 */
export async function resume(
  ctx: HarnessContext,
  device: any,
  target: SplashTarget
): Promise<void> {
  await dismissal(device, target)
  await device.pressKey('home')
  await sleep(1_000)
  await device.launchApp({ appId: target.appId, stopApp: false })
  if (await splashSeen(device))
    throw new Error(
      'The app did not resume: the splash came back, so it started afresh'
    )
  writeFileSync(
    ctx.artifact(`splash-${target.name}-resumed.png`),
    await device.screenshot()
  )
}

/**
 * Puts the status bar in demo mode (9:41, a full battery, no
 * notifications), so every captured frame is the same in every run. A
 * physical iPhone or iPad has no override and says UNSUPPORTED; its status
 * bar is left out of the comparison anyway (`SplashTarget.statusBar`).
 */
export async function demoStatusBar(
  device: any,
  mode: 'demo' | 'live'
): Promise<void> {
  try {
    await device.setStatusBar({ mode })
  } catch (error) {
    if (!/UNSUPPORTED/i.test(String((error as Error)?.message ?? error)))
      throw error
  }
}

/** The splash target a scenario runs: the app id the caller passed for the platform's app. */
export function targetFor(
  ctx: HarnessContext,
  target: Omit<SplashTarget, 'appId'>
): SplashTarget {
  return {
    ...target,
    appId: ctx.app(
      target.platform === 'ios' ? 'teamstation-ios' : 'teamstation-android'
    )
  }
}

/** A splash spec for one device role on one surface. */
export function defineSplash(options: {
  behaviour: string
  title: string
  surface: 'ios-app' | 'android-app'
  needs: string[]
  covers: string[]
  target: Omit<SplashTarget, 'appId'>
  scenarios: Record<
    string,
    (ctx: HarnessContext, device: any, target: SplashTarget) => Promise<void>
  >
}): HarnessSpec {
  return defineHarness({
    id: `app-shell/splash/${options.behaviour}`,
    title: options.title,
    kind: 'e2e',
    covers: options.covers,
    // The runner points the app at the stack before the scenario, so the
    // launch a scenario exercises is the one that talks to it.
    stack: 'isolated',
    fixtures: [],
    exclusive: false,
    surfaces: {
      [options.surface]: {
        devices: [{ role: 'app', needs: options.needs, simulator: 'allowed' }]
      }
    },
    services: [],
    apps: [
      options.target.platform === 'ios'
        ? 'teamstation-ios'
        : 'teamstation-android'
    ],
    secrets: [],
    costUsd: 0,
    minutes: 4,
    guards: [],
    faults: [],
    manual: false,
    sendsNoMail: true,
    scenarios: Object.fromEntries(
      Object.entries(options.scenarios).map(([name, run]) => [
        name,
        async (ctx: HarnessContext) => {
          const target = targetFor(ctx, options.target)
          const device = await ctx.attach('app', {
            platform: target.platform,
            appId: target.appId
          })
          // The same status bar in every frame, given back however it goes.
          await demoStatusBar(device, 'demo')
          try {
            await run(ctx, device, target)
          } finally {
            await demoStatusBar(device, 'live')
          }
        }
      ])
    )
  })
}
