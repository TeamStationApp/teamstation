import { globToRegExp } from './glob'
import type { BrowserNeed, DeviceNeed, E2eSpec, SurfaceNeeds } from './spec'

/**
 * The words a spec declares its needs in. A device role names a class and
 * the features it must have; a browser names what its page does. The runner
 * matches them against each hub device's own capabilities, never a name.
 */
export const DEVICE_CLASSES = [
  'ios-phone',
  'ipad',
  'android-phone',
  'android-tablet',
  'apple-tv'
] as const
export type DeviceClass = (typeof DEVICE_CLASSES)[number]

export const FEATURES = [
  'camera',
  'microphone',
  'push',
  'gpu',
  'keyboard-hardware'
] as const
export type Feature = (typeof FEATURES)[number]

export type Capability = DeviceClass | Feature

export const BROWSER_FEATURES = ['video', 'gpu'] as const
export type BrowserFeature = (typeof BROWSER_FEATURES)[number]

/** Needs a simulator or emulator cannot meet, so a role with one runs on a device. */
export const REAL_ONLY: readonly Feature[] = ['camera', 'push', 'gpu']

/** The 3D screens, which only a GPU draws: a spec covering them declares `gpu`. */
export const GPU_SCREENS = [
  'src/app/scoring',
  'src/app/replay',
  'src/app/field'
] as const

export function isCapability(value: string): value is Capability {
  return (
    (DEVICE_CLASSES as readonly string[]).includes(value) ||
    (FEATURES as readonly string[]).includes(value)
  )
}

/** What a role may run on: a role that does not say may not use a simulator. */
export function simulatorFor(need: DeviceNeed): 'allowed' | 'never' {
  if (need.needs.some(cap => (REAL_ONLY as readonly string[]).includes(cap))) {
    return 'never'
  }
  return need.simulator ?? 'never'
}

/**
 * A role's problems in the new vocabulary. A role written before it (no
 * `simulator`) is read through the mapping table until M4 converts it, so
 * its old words are not checked here.
 */
export function deviceNeedProblems(need: DeviceNeed): string[] {
  if (need.simulator == null) return []
  const problems: string[] = []
  if (need.simulator !== 'allowed' && need.simulator !== 'never') {
    problems.push(
      `role "${need.role}": simulator is allowed or never, not "${String(need.simulator)}"`
    )
  }
  for (const cap of need.needs) {
    if (!isCapability(cap)) {
      problems.push(`role "${need.role}": unknown capability "${cap}"`)
    }
  }
  if (
    !need.needs.some(cap => (DEVICE_CLASSES as readonly string[]).includes(cap))
  ) {
    problems.push(`role "${need.role}": names no device class`)
  }
  if (need.simulator === 'allowed') {
    for (const cap of need.needs) {
      if ((REAL_ONLY as readonly string[]).includes(cap)) {
        problems.push(
          `role "${need.role}": simulator: 'allowed' with ${cap}, which only a real device has`
        )
      }
    }
  }
  return problems
}

export function browserNeedProblems(need: BrowserNeed): string[] {
  const problems: string[] = []
  for (const feature of need.needs) {
    if (!(BROWSER_FEATURES as readonly string[]).includes(feature)) {
      problems.push(
        `browser "${need.role}": unknown browser feature "${feature}"`
      )
    }
  }
  if (need.codecs != null && !need.needs.includes('video')) {
    problems.push(`browser "${need.role}": codecs without video`)
  }
  return problems
}

/** Where a browser runs: video or a GPU on the Mac, anything else on a droplet. */
export function placement(need: BrowserNeed | undefined): 'mac' | 'droplet' {
  const needs = need?.needs ?? []
  return needs.includes('video') || needs.includes('gpu') ? 'mac' : 'droplet'
}

/** Every capability problem of a spec's surfaces. */
export function capabilityProblems(spec: Pick<E2eSpec, 'surfaces'>): string[] {
  const problems: string[] = []
  for (const [surface, needs] of Object.entries(spec.surfaces) as Array<
    [string, SurfaceNeeds | undefined]
  >) {
    for (const need of needs?.devices ?? []) {
      for (const problem of deviceNeedProblems(need)) {
        problems.push(`${surface}: ${problem}`)
      }
    }
    if (needs?.browser != null) {
      if (!surface.startsWith('web-')) {
        problems.push(`${surface}: a browser need is for a web surface`)
      }
      for (const problem of browserNeedProblems(needs.browser)) {
        problems.push(`${surface}: ${problem}`)
      }
    }
  }
  return problems
}

/** Whether a `covers` glob reaches into one of the 3D screens' folders. */
function reachesGpuScreen(glob: string): boolean {
  const pattern = globToRegExp(glob)
  return GPU_SCREENS.some(
    dir =>
      glob.startsWith(`${dir}/`) ||
      pattern.test(`${dir}/index.tsx`) ||
      pattern.test(`${dir}/index.ts`)
  )
}

/**
 * A spec that covers the scoring, replay or field screens and leaves `gpu`
 * off a role or its browser. `validate --strict` applies it from M4.
 */
export function gpuProblems(
  spec: Pick<E2eSpec, 'covers' | 'surfaces'>
): string[] {
  if (!spec.covers.some(reachesGpuScreen)) return []
  const problems: string[] = []
  for (const [surface, needs] of Object.entries(spec.surfaces) as Array<
    [string, SurfaceNeeds | undefined]
  >) {
    for (const need of needs?.devices ?? []) {
      if (!need.needs.includes('gpu')) {
        problems.push(
          `${surface}: role "${need.role}" covers a 3D screen without gpu`
        )
      }
    }
    // On web-safari-ios and web-chrome-android the browser is the phone's
    // own, so the role's gpu covers it.
    if (
      surface === 'web-chromium' &&
      !(needs?.browser?.needs ?? []).includes('gpu')
    ) {
      problems.push(`${surface}: the browser covers a 3D screen without gpu`)
    }
  }
  return problems
}
