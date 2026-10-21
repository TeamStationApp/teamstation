import { expect } from 'chai'
import { describe, it } from 'mocha'

import { latestQueue } from './latestQueue'

describe('a queue that keeps only the newest waiting task', function () {
  it('runs one at a time, and of those asked for meanwhile only the newest, in order', async function () {
    const queue = latestQueue()
    const ran: string[] = []
    let release: () => void = () => undefined
    queue(async () => {
      ran.push('first')
      await new Promise<void>(resolve => (release = resolve))
    })
    for (const name of ['second', 'third', 'fourth'])
      queue(async () => {
        ran.push(name)
      })
    expect(ran).deep.equals(['first'])
    release()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(ran).deep.equals(['first', 'fourth'])
    // A failing task does not stop the next.
    queue(async () => {
      throw new Error('refused')
    })
    queue(async () => {
      ran.push('after')
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(ran.at(-1)).equals('after')
  })
})
