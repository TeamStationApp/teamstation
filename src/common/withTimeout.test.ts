import { expect } from 'chai'
import { describe, it } from 'mocha'

import { TimeoutError, withTimeout } from './withTimeout'

describe('withTimeout', function () {
  it('answers what the work answers in time', async function () {
    expect(await withTimeout(Promise.resolve(3), 50, 'late')).equals(3)
  })

  it('passes on the work’s own failure', async function () {
    const failed = await withTimeout(
      Promise.reject(new Error('broken')),
      50,
      'late'
    ).catch((error: unknown) => error)
    expect(failed).instanceOf(Error)
    expect(failed).not.instanceOf(TimeoutError)
    expect((failed as Error).message).equals('broken')
  })

  it('rejects with a TimeoutError once the time passes first', async function () {
    const failed = await withTimeout(
      new Promise(() => undefined),
      10,
      'late'
    ).catch((error: unknown) => error)
    expect(failed).instanceOf(TimeoutError)
    expect((failed as Error).name).equals('TimeoutError')
    expect((failed as Error).message).equals('late')
  })
})
