import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { PNG } from 'pngjs'

import { defineE2e, type E2eContext, type E2eSpec } from '../../core/spec'

/**
 * The launch splash's end-to-end steps, shared by the phone, iPad and Android
 * specs in e2e/tests/app-shell/splash. The splash reports itself in its
 * accessibility value (iOS) or content description (Android) as
 * `ready <w>x<h>@<scale>` once React Native has drawn; the driver's own
 * hierarchy dump carries both, so that is what is read.
 */

const root = resolve(__dirname, '../../..')
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
  ctx: E2eContext,
  device: any,
  target: SplashTarget,
  report: SplashReport,
  t: number
): Promise<void> {
  const references = join(ctx.runDir, 'reference')
  const reference = join(references, referenceName(report, t))
  if (!existsSync(reference))
    execFileSync(
      'node',
      [
        'scripts/splash/buildSplashAssets.mjs',
        '--frames',
        references,
        '--sizes',
        `${report.width}x${report.height}@${report.scale}`
      ],
      { cwd: root, stdio: 'inherit' }
    )
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
  ctx: E2eContext,
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
    absent = raw.includes('tsSplash') ? 0 : absent + 1
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
  await device.assertVisible({
    id: 'tsSplash',
    timeout: 3_000,
    optional: target.platform === 'android'
  })
  await waitGone(device, 6_000)
}

/** The app's process id on `udid`, or undefined when it is not running. */
export function appPid(target: SplashTarget, udid: string): string | undefined {
  if (target.platform === 'ios') {
    const list = execFileSync('xcrun', [
      'simctl',
      'spawn',
      udid,
      'launchctl',
      'list'
    ]).toString()
    const line = list
      .split('\n')
      .find(row => row.includes(`UIKitApplication:${target.appId}[`))
    return line?.split('\t')[0]
  }
  const pid = execFileSync('adb', ['-s', udid, 'shell', 'pidof', target.appId])
    .toString()
    .trim()
  return pid === '' ? undefined : pid
}

/**
 * Launches, waits out the splash, backgrounds the app and brings the same
 * process back. maestro-d's launchApp can start a new process, so the app is
 * brought forward by the platform's own command, which only activates it, and
 * the process id proves it was a resume.
 */
export async function resume(
  ctx: E2eContext,
  device: any,
  target: SplashTarget
): Promise<void> {
  const udid = ctx.device('app')
  await dismissal(device, target)
  const before = appPid(target, udid)
  await device.pressKey('home')
  await sleep(1_000)
  if (target.platform === 'ios')
    execFileSync('xcrun', ['simctl', 'launch', udid, target.appId])
  else
    execFileSync('adb', [
      '-s',
      udid,
      'shell',
      'monkey',
      '-p',
      target.appId,
      '-c',
      'android.intent.category.LAUNCHER',
      '1'
    ])
  const after = appPid(target, udid)
  if (before == null || before !== after)
    throw new Error(
      `The app did not resume: process ${String(before)} became ${String(after)}`
    )
}

/** A splash spec for one device role on one surface. */
export function defineSplash(options: {
  behaviour: string
  title: string
  surface: 'ios-app' | 'android-app'
  needs: string[]
  covers: string[]
  target: SplashTarget
  scenarios: Record<
    string,
    (ctx: E2eContext, device: any, target: SplashTarget) => Promise<void>
  >
  /** Runs once the device is attached, before the scenario. */
  prepare?: (ctx: E2eContext, device: any) => Promise<void>
}): E2eSpec {
  return defineE2e({
    id: `app-shell/splash/${options.behaviour}`,
    title: options.title,
    kind: 'e2e',
    covers: options.covers,
    stack: 'none',
    fixtures: [],
    exclusive: false,
    surfaces: {
      [options.surface]: {
        devices: [{ role: 'app', needs: options.needs, hardware: 'none' }]
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
        async (ctx: E2eContext) => {
          const device = await ctx.attach('app', {
            platform: options.target.platform,
            appId: options.target.appId
          })
          await options.prepare?.(ctx, device)
          await run(ctx, device, options.target)
        }
      ])
    )
  })
}
