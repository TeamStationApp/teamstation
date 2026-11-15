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
        devices: options.steps.setup.watchers
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
        options.judge(
          await runTargeted(ctx, ROOT, options.steps.setup, options.steps.run)
        )
      }
    }
  })
}
