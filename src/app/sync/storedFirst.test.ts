import { expect } from 'chai'
import type { Cleaner } from 'cleaners'
import { describe, it } from 'mocha'

import { StoredFirst } from './storedFirst'

/** A client whose stored copies answer when `release` is called. */
function storedClient(stored: Record<string, unknown>): {
  client: {
    cached: <T>(key: string, cleaner: Cleaner<T>) => Promise<T | undefined>
  }
  keys: string[]
  release: () => void
} {
  const keys: string[] = []
  let release: () => void = () => undefined
  const held = new Promise<void>(resolve => {
    release = resolve
  })
  return {
    keys,
    release,
    client: {
      cached: async <T>(key: string, cleaner: Cleaner<T>) => {
        keys.push(key)
        await held
        if (key === 'broken') throw new Error('unreadable')
        return key in stored ? cleaner(stored[key]) : undefined
      }
    }
  }
}

const asText: Cleaner<string> = raw => String(raw)

describe('the stored-first paint', function () {
  it('paints the stored copy while no answer has come', async function () {
    const { client, keys, release } = storedClient({ 'game.g1': 'stored' })
    const painted: string[] = []
    const paint = new StoredFirst().paint(client, '/games/g1', asText, value =>
      painted.push(value)
    )
    release()
    expect(await paint).equals(true)
    expect(keys).deep.equals(['game.g1'])
    expect(painted).deep.equals(['stored'])
  })

  it('drops a stored copy an answer beat, whether the read’s own or a live update’s', async function () {
    const { client, release } = storedClient({ 'game.g1': 'stored' })
    const first = new StoredFirst()
    const painted: string[] = []
    const late = first.paint(client, '/games/g1', asText, value =>
      painted.push(value)
    )
    // A socket's update of the game answers before the stored copy is read.
    first.answered()
    release()
    expect(await late).equals(false)
    expect(painted).deep.equals([])
    // Begun after that answer, a paint still goes, until the next.
    expect(
      await first.paint(client, '/games/g1', asText, value =>
        painted.push(value)
      )
    ).equals(true)
    expect(painted).deep.equals(['stored'])
  })

  it('paints nothing for a screen that moved on, a copy never stored, one unreadable, or a path with no document', async function () {
    const { client, release } = storedClient({ 'game.g1': 'stored' })
    release()
    const first = new StoredFirst()
    const never = (): void => {
      throw new Error('painted')
    }
    expect(
      await first.paint(client, '/games/g1', asText, never, () => false)
    ).equals(false)
    expect(await first.paint(client, '/games/g2', asText, never)).equals(false)
    const broken = {
      cached: async () => {
        throw new Error('unreadable')
      }
    }
    expect(await first.paint(broken, '/games/g1', asText, never)).equals(false)
    expect(await first.paint(client, '/auth/me', asText, never)).equals(false)
  })
})
