import { expect } from 'chai'
import { describe, it } from 'mocha'

import type { Status } from './result'
import type { RunOptions, RunOutcome } from './run'
import { devicesOf, runMany } from './runMany'
import type { StackHandle } from './spec'

const SOAK = 'streaming/basic/four-synthetic#scrub'
const PANEL = 'streaming/targeted/owner-panel#unanswered-read'
const DEVICES = {
  iphone: 'phone-1',
  android: 'pixel-1',
  tv: 'tv-1',
  safari: 'phone-2'
}

const stack = (id: string): { id: string; handle: StackHandle } => ({
  id,
  handle: {
    kind: 'isolated',
    origin: `https://${id}.example.test`,
    webDir: undefined,
    adopt: async origin => origin,
    serverErrors: async () => []
  }
})

/** Runs that end only when the test says, recording what was running together. */
function runs(statusOf: (id: string) => Status = () => 'passed'): {
  run: (options: RunOptions) => Promise<RunOutcome>
  started: Array<{ id: string; stack: string }>
  finish: (index: number) => void
  running: () => number
} {
  const started: Array<{ id: string; stack: string }> = []
  const ends: Array<() => void> = []
  let running = 0
  return {
    started,
    running: () => running,
    finish: index => {
      ends[index]()
    },
    run: async options => {
      started.push({ id: options.id, stack: options.stack?.origin ?? '' })
      running++
      await new Promise<void>(resolve => ends.push(resolve))
      running--
      const status = statusOf(options.id)
      // Only the status is read from the result.
      const result: Partial<RunOutcome['result']> = { status }
      return {
        result: result as RunOutcome['result'],
        exitCode: status === 'passed' ? 0 : 1,
        runDir: `/runs/${started.length}`
      }
    }
  }
}

const tick = async (): Promise<void> => {
  await new Promise(resolve => setImmediate(resolve))
}

describe('run-many', function () {
  it('knows the devices a scenario holds from its surface’s roles', function () {
    expect(devicesOf(SOAK, 'web-chromium', DEVICES).sort()).deep.equals([
      'phone-1',
      'phone-2',
      'pixel-1',
      'tv-1'
    ])
    expect(devicesOf(PANEL, 'web-chromium', DEVICES)).deep.equals([])
  })

  it('runs one scenario per stack at once, and holds back one whose devices are in use', async function () {
    const fake = runs(id => (id === PANEL ? 'failed' : 'passed'))
    const done = runMany({
      scenarios: [SOAK, SOAK, PANEL],
      stacks: [stack('e2e-01'), stack('e2e-02')],
      surface: 'web-chromium',
      devices: DEVICES,
      settings: {},
      run: fake.run
    })
    await tick()
    // The second soak needs the first's phones: the panel goes on the free stack instead.
    expect(fake.started).deep.equals([
      { id: SOAK, stack: 'https://e2e-01.example.test' },
      { id: PANEL, stack: 'https://e2e-02.example.test' }
    ])
    expect(fake.running()).equals(2)
    fake.finish(1)
    await tick()
    expect(fake.started).length(2)
    fake.finish(0)
    await tick()
    await tick()
    expect(fake.started.at(-1)?.id).equals(SOAK)
    fake.finish(2)
    const { rows, exitCode } = await done
    expect(rows.map(row => [row.scenario, row.stack, row.status])).deep.equals([
      [SOAK, 'e2e-01', 'passed'],
      [SOAK, 'e2e-02', 'passed'],
      [PANEL, 'e2e-02', 'failed']
    ])
    expect(exitCode).equals(1)
  })

  it('refuses no stacks, and finishes at once with no scenarios', async function () {
    let failure: unknown
    await runMany({
      scenarios: [PANEL],
      stacks: [],
      surface: 'web-chromium',
      devices: {},
      settings: {},
      run: runs().run
    }).catch((error: unknown) => {
      failure = error
    })
    expect(String(failure)).includes('one stack or more')
    expect(
      await runMany({
        scenarios: [],
        stacks: [stack('e2e-01')],
        surface: 'web-chromium',
        devices: {},
        settings: {},
        run: runs().run
      })
    ).deep.equals({ rows: [], exitCode: 0 })
  })
})
