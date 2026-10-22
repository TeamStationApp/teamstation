import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'

import { webNarrationPlayer } from './narrationPlayer'
import type { NarrationClient } from './narrationPlayerTypes'

/** An audio element that plays when told and ends when the test says. */
class FakeAudio {
  src = ''
  onended: (() => void) | null = null
  onerror: (() => void) | null = null
  plays: string[] = []
  pauses = 0
  refuse = false

  async play(): Promise<void> {
    this.plays.push(this.src)
    if (this.refuse) throw new Error('NotAllowedError')
  }

  pause(): void {
    this.pauses++
  }
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('the announcer in a browser', function () {
  const created: Blob[] = []
  const revoked: string[] = []
  const original = {
    create: Object.getOwnPropertyDescriptor(URL, 'createObjectURL'),
    revoke: Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')
  }
  beforeEach(function () {
    created.length = 0
    revoked.length = 0
    URL.createObjectURL = (blob: Blob) => {
      created.push(blob)
      return `blob:${created.length}`
    }
    URL.revokeObjectURL = (url: string) => {
      revoked.push(url)
    }
  })
  afterEach(function () {
    for (const [name, descriptor] of [
      ['createObjectURL', original.create],
      ['revokeObjectURL', original.revoke]
    ] as const)
      if (descriptor == null) Reflect.deleteProperty(URL, name)
      else Object.defineProperty(URL, name, descriptor)
  })

  const asked: Array<{ gameId: string; stepKey: string; count: number }> = []
  const client: NarrationClient = {
    narrationAudio: async (gameId, step) => {
      asked.push({ gameId, stepKey: step.key, count: step.count })
      return new Blob(['mp3'], { type: 'audio/mpeg' })
    },
    narrationReady: async () => {
      throw new Error('a browser downloads the sentence')
    },
    narrationSource: (gameId, step) => ({
      uri: `/games/${gameId}/narrations/${step.key}?count=${step.count}`,
      headers: {}
    })
  }

  it('fetches through the client, plays from one element, and frees the audio', async function () {
    const audio = new FakeAudio()
    const player = webNarrationPlayer(
      client,
      'gam_1',
      audio as unknown as HTMLAudioElement
    )
    expect(player.element).equals(null)
    const clip = await player.output.load(
      { key: '0-1', count: 2 },
      new AbortController().signal
    )
    expect(asked.at(-1)).deep.equals({
      gameId: 'gam_1',
      stepKey: '0-1',
      count: 2
    })
    expect(clip).equals('blob:1')
    let ended = false
    const playing = player.output.play(clip).then(() => {
      ended = true
    })
    await settle()
    expect(audio.plays).deep.equals(['blob:1'])
    player.output.pause()
    player.output.resume()
    expect(audio.pauses).equals(1)
    expect(audio.plays).deep.equals(['blob:1', 'blob:1'])
    expect(ended).equals(false)
    audio.onended?.()
    await playing
    expect(ended).equals(true)
    // Nothing playing: play does not start a stale sentence.
    player.output.resume()
    expect(audio.plays).length(2)
    player.output.release(clip)
    expect(revoked).deep.equals(['blob:1'])
  })

  it('unlocks the element once, in the tap', async function () {
    const audio = new FakeAudio()
    audio.refuse = true
    const player = webNarrationPlayer(
      client,
      'gam_1',
      audio as unknown as HTMLAudioElement
    )
    player.unlock()
    player.unlock()
    await settle()
    expect(audio.plays).length(1)
    expect(audio.plays[0]).match(/^data:audio\/wav;base64,/)
  })

  it('ends a sentence that is stopped, fails, or is refused', async function () {
    const audio = new FakeAudio()
    const player = webNarrationPlayer(
      client,
      'gam_1',
      audio as unknown as HTMLAudioElement
    )
    const stopped = player.output.play('blob:a')
    player.output.stop()
    await stopped
    const failed = player.output.play('blob:b')
    audio.onerror?.()
    await failed
    // A second sentence ends the first.
    const first = player.output.play('blob:c')
    const second = player.output.play('blob:d')
    await first
    audio.refuse = true
    player.output.stop()
    await second
    await player.output.play('blob:e')
    expect(audio.plays).deep.equals([
      'blob:a',
      'blob:b',
      'blob:c',
      'blob:d',
      'blob:e'
    ])
  })
})
