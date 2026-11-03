import { expect } from 'chai'
import { describe, it } from 'mocha'

import { playById } from './playById'

describe('playing a camera’s video by its id', function () {
  const listed = [{ id: 'vid_1' }, { id: 'vid_2' }]

  it('plays a listed video at once, reading nothing', async function () {
    const played: string[] = []
    let reads = 0
    await playById('vid_2', {
      listed,
      reread: async () => {
        reads += 1
        return []
      },
      play: video => played.push(video.id)
    })
    expect(played).deep.equals(['vid_2'])
    expect(reads).equals(0)
  })

  it('reads the videos again for one not listed yet, and plays it once there', async function () {
    const played: string[] = []
    await playById('vid_3', {
      listed,
      reread: async () => [...listed, { id: 'vid_3' }],
      play: video => played.push(video.id)
    })
    expect(played).deep.equals(['vid_3'])
  })

  it('plays nothing when it is still not there, or the game changed', async function () {
    const played: string[] = []
    await playById('vid_3', {
      listed,
      reread: async () => listed,
      play: video => played.push(video.id)
    })
    await playById('vid_3', {
      listed,
      reread: async () => undefined,
      play: video => played.push(video.id)
    })
    expect(played).deep.equals([])
  })
})
