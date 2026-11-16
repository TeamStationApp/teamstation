import { expect } from 'chai'
import { describe, it } from 'mocha'

import { harnessRuns, type ManifestScenario, sweepStatus } from './harnessSweep'

const scenario = (
  id: string,
  surfaces: string[],
  stack = 'isolated'
): ManifestScenario => ({
  id,
  file: `e2e/tests/${id.split('#')[0]}.e2e.ts`,
  stack,
  minutes: 3,
  surfaces: Object.fromEntries(surfaces.map(surface => [surface, {}]))
})

describe('the sweep of harness scenarios', function () {
  it('runs each scenario of the file on Chromium, and lists every other surface as waiting for its device', function () {
    const runs = harnessRuns('e2e/tests/assistant/chat/split-view.e2e.ts', [
      scenario('assistant/chat/split-view#opens-beside', [
        'web-chromium',
        'ios-app'
      ]),
      scenario('assistant/chat/composer#types', ['web-chromium'])
    ])
    expect(runs.map(run => [run.id, run.surface, run.skip])).deep.equals([
      ['assistant/chat/split-view#opens-beside', 'web-chromium', undefined],
      [
        'assistant/chat/split-view#opens-beside',
        'ios-app',
        'ios-app needs its device, which this sweep has none of'
      ]
    ])
  })

  it('lists a scenario that runs against a deployed seat as waiting for one', function () {
    const [run] = harnessRuns('e2e/tests/account/sign-in/password.e2e.ts', [
      scenario(
        'account/sign-in/password#own-team-only',
        ['web-chromium'],
        'seat'
      )
    ])
    expect(run.skip).equals(
      'runs against a deployed seat, which this sweep has none of'
    )
  })

  it("lists a scenario that plays the app's HEVC video as waiting for a machine that decodes it", function () {
    const [run] = harnessRuns('e2e/tests/assistant/chat/split-view.e2e.ts', [
      scenario('assistant/chat/split-view#video-keeps-playing', [
        'web-chromium'
      ])
    ])
    expect(run.skip).equals(
      "plays the app's HEVC video, which this sweep's Chrome cannot decode"
    )
  })

  it('counts a run as passed only when it passed', function () {
    expect(sweepStatus('passed')).equals('passed')
    expect(sweepStatus('passed-degraded')).equals('passed')
    expect(sweepStatus('blocked')).equals('blocked')
    for (const status of [
      'failed',
      'quarantined',
      'needs-review',
      'unbaselined',
      undefined
    ])
      expect(sweepStatus(status), String(status)).equals('failed')
  })
})
