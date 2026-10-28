import { expect } from 'chai'
import { describe, it } from 'mocha'

import { anglesOpenPage, type GameAngles, withAngles } from './gameAngles'
import { routePath } from './routes'

describe("the game frame's full-screen player (U12)", function () {
  const page: { name: 'game'; gameId: string; title: string } & GameAngles = {
    name: 'game',
    gameId: 'g1',
    title: '',
    at: 12
  }
  const from = { videoId: 'v2', sec: 41.5 }

  it('carries where the player was opened from, and clears it on close', function () {
    const open = withAngles(page, {
      angles: ['v2'],
      audio: 'v2',
      zoom: null,
      at: null,
      from
    })
    expect(open).deep.equals({
      ...page,
      angles: ['v2'],
      audio: 'v2',
      zoom: undefined,
      at: undefined,
      from
    })
    // Moving through the game leaves it alone.
    expect(withAngles(open, { at: 30 }).from).deep.equals(from)
    const closed = withAngles(open, {
      angles: [],
      audio: null,
      zoom: null,
      at: null,
      from: null
    })
    expect(closed.from).equals(undefined)
    expect(closed.angles).deep.equals([])
  })

  it('never writes it to the address', function () {
    const open = withAngles(page, { angles: ['v2'], audio: 'v2', from })
    // The frame as it is, `from` and all, less the header's title.
    const { title, ...route } = open
    expect(title).equals('')
    expect(route.from).deep.equals(from)
    expect(routePath(route)).equals('/games/g1?t=12&angles=v2&audio=v2')
  })

  it('makes the opening a page of its own, and nothing else', function () {
    expect(anglesOpenPage({ angles: ['v2'], from })).equals(true)
    expect(anglesOpenPage({ angles: ['v1', 'v2'], audio: 'v1' })).equals(false)
    expect(anglesOpenPage({ at: 30 })).equals(false)
    expect(anglesOpenPage({ angles: [], from: null })).equals(false)
  })

  it("carries a highlight's end, and takes the highlight off once it has opened", function () {
    const asked = { ...page, videoId: 'v2', highlightUntil: 47 }
    // Moving through the game keeps it until the player opens.
    expect(withAngles(asked, { at: 30 }).highlightUntil).equals(47)
    const until = { videoId: 'v2', sec: 12, untilSec: 47, untilWallMs: 1_047 }
    const open = withAngles(asked, {
      angles: ['v2'],
      audio: 'v2',
      from: until,
      highlightUntil: null
    })
    expect(open.from).deep.equals(until)
    expect('highlightUntil' in open).equals(false)
    // So a frame drawn again later does not open it a second time.
    expect(withAngles(open, { from: null }).highlightUntil).equals(undefined)
  })
})
