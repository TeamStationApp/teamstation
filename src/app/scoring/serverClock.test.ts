import { expect } from 'chai'
import { describe, it } from 'mocha'

import type { PreferenceStorage } from './scoringPreferenceStore'
import { CLOCK_REFRESH_MS, ServerClock } from './serverClock'

/** Storage in memory, which can be made to refuse. */
function memory(held: Record<string, string> = {}): PreferenceStorage & {
  held: Record<string, string>
  refuse: boolean
} {
  return {
    held,
    refuse: false,
    async getItem(key) {
      if (this.refuse) throw new Error('refused')
      return held[key] ?? null
    },
    async setItem(key, value) {
      if (this.refuse) throw new Error('refused')
      held[key] = value
    }
  }
}
const KEY = 'teamstation:scoring:serverClockOffset'
const DEVICE = Date.parse('2026-09-25T12:00:00Z')
/** A server 1.5 s ahead of the device, answering at once. */
const ahead = async (): Promise<number> => DEVICE + 1500

describe('the scoring clock (U43)', function () {
  it('reads the device clock until an offset is measured', async function () {
    const clock = new ServerClock(ahead, memory(), { local: () => DEVICE })
    await clock.restored
    expect(clock.offset).equals(0)
    expect(clock.now().getTime()).equals(DEVICE)
    await clock.measure()
    expect(clock.offset).equals(1500)
    expect(clock.now().toISOString()).equals('2026-09-25T12:00:01.500Z')
  })

  it('keeps the offset for scoring offline, and uses it when it cannot measure', async function () {
    const storage = memory()
    const first = new ServerClock(ahead, storage, { local: () => DEVICE })
    await first.measure()
    expect(storage.held[KEY]).equals('1500')
    const offline = new ServerClock(
      async () => {
        throw new Error('offline')
      },
      storage,
      { local: () => DEVICE }
    )
    await offline.restored
    await offline.measure()
    expect(offline.offset).equals(1500)
  })

  it('prefers a measurement to the kept offset, and ignores one it cannot read', async function () {
    let answer: (now: number) => void = () => undefined
    const storage = memory({ [KEY]: '9000' })
    const slow = { ...storage }
    let release: () => void = () => undefined
    slow.getItem = async key =>
      await new Promise(resolve => {
        release = () => {
          resolve(storage.held[key] ?? null)
        }
      })
    const clock = new ServerClock(
      async () =>
        await new Promise<number>(resolve => {
          answer = resolve
        }),
      slow,
      { local: () => DEVICE }
    )
    const measuring = clock.measure()
    for (let i = 0; i < 5; i++) {
      await new Promise(resolve => setTimeout(resolve, 0))
      answer(DEVICE + 1500)
    }
    await measuring
    release()
    await clock.restored
    expect(clock.offset).equals(1500)

    const garbled = new ServerClock(ahead, memory({ [KEY]: 'soon' }))
    await garbled.restored
    expect(garbled.offset).equals(0)
    const refused = memory({ [KEY]: '700' })
    refused.refuse = true
    const blocked = new ServerClock(ahead, refused, { local: () => DEVICE })
    await blocked.restored
    expect(blocked.offset).equals(0)
    await blocked.measure()
    expect(blocked.offset).equals(1500)
  })

  it('measures when it starts keeping time and every five minutes until stopped', async function () {
    const timers: Array<{ run: () => void; ms: number }> = []
    let asked = 0
    const clock = new ServerClock(
      async () => {
        asked++
        return DEVICE + 1500
      },
      memory(),
      {
        local: () => DEVICE,
        setInterval: (run, ms) => {
          const timer = { run, ms }
          timers.push(timer)
          return timer
        },
        clearInterval: handle => {
          timers.splice(timers.indexOf(handle as (typeof timers)[0]), 1)
        }
      }
    )
    const stop = clock.keepTime()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(asked).equals(5)
    expect(timers.map(timer => timer.ms)).deep.equals([CLOCK_REFRESH_MS])
    expect(CLOCK_REFRESH_MS).equals(300_000)
    timers[0].run()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(asked).equals(10)
    stop()
    expect(timers).length(0)
  })

  it('keeps time on the platform timers by default', function () {
    const stop = new ServerClock(ahead, memory()).keepTime()
    stop()
  })
})
