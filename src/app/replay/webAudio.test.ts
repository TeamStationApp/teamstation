import { expect } from 'chai'
import { describe, it } from 'mocha'

import { SILENCE, start } from './webAudio'

/** An element whose `play` answers as the test says. */
const element = (play: () => Promise<void> | undefined): HTMLAudioElement =>
  ({ play }) as unknown as HTMLAudioElement

describe('the web players’ audio', function () {
  it('is a moment of silence to prime an element with', function () {
    expect(SILENCE).match(/^data:audio\/wav;base64,/)
  })

  it('plays, swallowing a refusal, an answer of nothing, and no audio at all', async function () {
    const asked: string[] = []
    start(
      element(async () => {
        asked.push('plays')
      })
    )
    start(
      element(async () => {
        asked.push('refuses')
        throw new Error('NotAllowedError')
      })
    )
    start(
      element(() => {
        asked.push('older browser')
        return undefined
      })
    )
    start(
      element(() => {
        asked.push('throws')
        throw new Error('not supported')
      })
    )
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(asked).deep.equals(['plays', 'refuses', 'older browser', 'throws'])
  })
})
