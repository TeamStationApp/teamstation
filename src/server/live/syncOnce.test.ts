import { expect } from 'chai'
import { describe, it } from 'mocha'

import { syncOnce } from './controller'

describe('live controller tick', () => {
  it('skips a tick while the last sync is still running', async () => {
    let runs = 0
    let finish: () => void = () => {}
    const slow = async (): Promise<void> => {
      runs += 1
      await new Promise<void>(resolve => {
        finish = resolve
      })
    }
    const first = syncOnce(() => {}, slow)
    await syncOnce(() => {}, slow)
    expect(runs).to.equal(1)
    finish()
    await first
    const next = syncOnce(() => {}, slow)
    expect(runs).to.equal(2)
    finish()
    await next
  })

  it('logs a failed sync and lets the next tick run', async () => {
    const logged: string[] = []
    await syncOnce(
      message => logged.push(message),
      async () => {
        throw new Error('ingest gone')
      }
    )
    expect(logged).to.deep.equal(['live: Error: ingest gone'])
    let ran = false
    await syncOnce(
      () => {},
      async () => {
        ran = true
      }
    )
    expect(ran).to.equal(true)
  })
})
