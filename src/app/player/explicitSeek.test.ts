import { expect } from 'chai'
import { describe, it } from 'mocha'

import { onExplicitSeek, seekTo } from './explicitSeek'

describe('a seek the viewer made', function () {
  it('tells every party waiting on the player, then moves it', function () {
    const video = { currentTime: 10 }
    const heard: string[] = []
    const stopA = onExplicitSeek(video, () =>
      heard.push(`a@${video.currentTime}`)
    )
    onExplicitSeek(video, () => heard.push(`b@${video.currentTime}`))
    seekTo(video, 42)
    expect(heard).deep.equals(['a@10', 'b@10'])
    expect(video.currentTime).equals(42)
    stopA()
    seekTo(video, 7)
    expect(heard).deep.equals(['a@10', 'b@10', 'b@42'])
    // A player nobody waits on just moves.
    const other = { currentTime: 0 }
    seekTo(other, 3)
    expect(other.currentTime).equals(3)
  })
})
