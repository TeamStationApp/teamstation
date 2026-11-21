import { ROOT } from '../../core/manifest'
import { defineE2e, type E2eSpec } from '../../core/spec'
import { runTargeted, type TargetedOutcome, type WatcherRole } from './targeted'
import type { TargetedScenario } from './targetedScenarios'

/** What each watcher role needs of its device, as the suite's device catalogue names it. */
const NEEDS: Record<Exclude<WatcherRole, 'chrome'>, string[]> = {
  iphone: ['ios-phone'],
  safari: ['ios-phone'],
  android: ['android-phone'],
  ipad: ['ipad'],
  tv: ['apple-tv']
}

/** Every watcher a targeted scenario can have. */
const ROLES: WatcherRole[] = [
  'iphone',
  'android',
  'ipad',
  'chrome',
  'tv',
  'safari'
]

/**
 * `TARGETED_WATCHERS` in the environment: a comma list of the watchers a
 * targeted run keeps, of the scenario's own, for a bench missing one (no
 * spare iPad), or none to keep them all. It applies to every scenario, so a
 * watcher a scenario does not have is left out of it, not refused.
 */
export function targetedWatchers(
  watchers: WatcherRole[],
  env: Record<string, string | undefined> = process.env
): WatcherRole[] {
  const asked = env.TARGETED_WATCHERS?.split(',')
    .map(role => role.trim())
    .filter(role => role !== '')
  if (asked == null || asked.length === 0) return watchers
  for (const role of asked) {
    if (!ROLES.includes(role as WatcherRole)) {
      throw new Error(
        `TARGETED_WATCHERS: no watcher "${role}" (there are ${ROLES.join(', ')})`
      )
    }
  }
  return watchers.filter(role => asked.includes(role))
}

/**
 * A targeted streaming scenario as the suite runs it: one `web-chromium`
 * surface (Chrome is the browser it opens), with a device role for each other
 * watcher, on an attached stack.
 */
export function defineTargeted(options: {
  /** The id's middle part: `targeted`, or `basic` for the basic soak. */
  group?: string
  behaviour: string
  scenario: string
  title: string
  minutes: number
  covers: string[]
  steps: TargetedScenario
  /** The scenario's pass criterion, stated in its own file. */
  judge: (outcome: TargetedOutcome) => void
}): E2eSpec {
  const setup = {
    ...options.steps.setup,
    watchers: targetedWatchers(options.steps.setup.watchers)
  }
  return defineE2e({
    id: `streaming/${options.group ?? 'targeted'}/${options.behaviour}`,
    title: options.title,
    kind: 'e2e',
    covers: options.covers,
    stack: 'isolated',
    fixtures: [],
    exclusive: true,
    surfaces: {
      'web-chromium': {
        devices: setup.watchers
          .filter(
            (role): role is Exclude<WatcherRole, 'chrome'> => role !== 'chrome'
          )
          .map(role => ({
            role,
            needs: NEEDS[role],
            hardware: 'required' as const
          }))
      }
    },
    services: ['web', 'api'],
    apps: ['teamstation-ios', 'teamstation-android', 'teamstation-tv'],
    secrets: [],
    costUsd: 0,
    minutes: options.minutes,
    guards: [],
    faults: [],
    manual: false,
    scenarios: {
      [options.scenario]: async ctx => {
        options.judge(await runTargeted(ctx, ROOT, setup, options.steps.run))
      }
    }
  })
}
