/**
 * TeamStation's Mason pipeline.
 *
 * `build` tests the checkout, then builds every app at once: TeamStation,
 * Cameraman, Director and Preview for iOS (ad hoc, signed by Mason, each with
 * a Simulator build as an artifact), TeamStation and Cameraman for Android,
 * and the Distributor for macOS (Developer ID, notarized). Every app of a run
 * shares one build number, `YYMMDDCC` per branch in the team's time zone. The
 * `seat` parameter picks the development seat the apps talk to.
 *
 * `release` sends TeamStation's App Store build to TestFlight once an admin or
 * manager approves it.
 *
 * Nodes are chosen by label: `teamstation-test` runs the tests,
 * `teamstation-android` builds the Android apps, and Apple builds run on a Mac
 * with the project's signing label. The stage functions are in
 * `scripts/pipeline/`; the private settings are the `TS_PIPELINE_CONFIG`,
 * `ANDROID_SIGNING` and `ANDROID_KEYSTORE` project secrets.
 */
import type { Setup, StageOptions } from '@mason/types'

import type { Row } from './scripts/pipeline/apps.ts'
import { rows } from './scripts/pipeline/apps.ts'
import {
  android,
  appStore,
  ios,
  macos,
  test
} from './scripts/pipeline/stages.ts'

export { android, appStore, ios, macos, test }

const node = '24'

/** The stage that builds one row. */
export function buildStage(row: Row): StageOptions {
  const common = {
    publishes: [row.app],
    secrets: ['TS_PIPELINE_CONFIG'],
    timeout: '2h' as const
  }
  if (row.platform === 'android')
    return {
      ...common,
      on: { labels: ['teamstation-android'] },
      secrets: ['TS_PIPELINE_CONFIG', 'ANDROID_SIGNING', 'ANDROID_KEYSTORE'],
      tools: {
        node,
        java: '17',
        android: [
          'platform-tools',
          'platforms;android-37.0',
          'build-tools;37.0.0',
          'ndk;27.1.12297006'
        ]
      },
      run: android
    }
  return {
    ...common,
    on: { os: 'macos' },
    apple: {
      distribution: row.platform === 'macos' ? 'developerId' : 'adHoc',
      app: row.app
    },
    tools: {
      node,
      brew:
        row.kind === 'react-native' ? ['xcodegen', 'cocoapods'] : ['xcodegen']
    },
    run: row.platform === 'macos' ? macos : ios
  }
}

export function setup(m: Setup): void {
  m.apiVersion(1)
  m.buildNumber('app', {
    scope: 'branch',
    format: 'YYMMDDCC',
    timeZone: 'America/Los_Angeles',
    check: 'apple'
  })
  m.workflow(
    'build',
    {
      params: {
        seat: {
          type: 'choice',
          choices: ['none', '1', '2', '3', '4', '5'],
          default: 'none',
          description: 'The development seat the apps talk to'
        }
      }
    },
    w => {
      const tested = w.stage('test', {
        on: { labels: ['teamstation-test'] },
        tools: { node },
        timeout: '1h',
        run: test
      })
      w.parallel(
        'build',
        Object.fromEntries(rows.map(row => [row.name, buildStage(row)])),
        { needs: [tested], failFast: false }
      )
    }
  )
  m.workflow(
    'release',
    {
      triggers: [{ request: true }],
      params: {
        groups: {
          type: 'string',
          default: 'Internal',
          description: 'TestFlight groups, separated by commas'
        }
      },
      concurrency: { group: 'workflow' }
    },
    w => {
      const approved = w.approval('approve', {
        roles: ['admin', 'manager'],
        message: 'Send this TeamStation build to TestFlight'
      })
      w.stage('testflight', {
        needs: [approved],
        on: { os: 'macos' },
        apple: { distribution: 'appStore', app: 'app.teamstation.app' },
        buildNumbers: ['app'],
        secrets: ['TS_PIPELINE_CONFIG'],
        tools: { node, brew: ['xcodegen', 'cocoapods'] },
        timeout: '2h',
        run: appStore
      })
    }
  )
}
