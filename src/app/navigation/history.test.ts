import { expect } from 'chai'

import { makeHistory } from './history'

describe('where the app has been', function () {
  it('starts on whatever it was opened on', function () {
    const history = makeHistory({ name: 'game', gameId: 'g1' })
    expect(history.current()).deep.equals({ name: 'game', gameId: 'g1' })
    expect(history.back()).equals(false)
  })

  it('walks back the way it came', function () {
    const history = makeHistory()
    history.show({ name: 'team', teamId: 't1' })
    history.show({ name: 'game', gameId: 'g1' })
    expect(history.back()).equals(true)
    expect(history.current()).deep.equals({ name: 'team', teamId: 't1' })
    expect(history.back()).equals(true)
    expect(history.current()).deep.equals({ name: 'home' })
  })

  it('says when there is nowhere left to go', function () {
    // Which is what closes the app on Android. A Back button that does
    // nothing on the home screen reads as a hang.
    const history = makeHistory()
    expect(history.back()).equals(false)
  })

  it('corrects a step rather than adding one', function () {
    // Where you are in a video is a property of the screen you are already
    // on. Pushed, watching twenty highlights would need twenty presses of
    // Back to leave the game.
    const history = makeHistory()
    history.show({ name: 'game', gameId: 'g1' })
    history.show({ name: 'game', gameId: 'g1', at: 30 }, true)
    history.show({ name: 'game', gameId: 'g1', at: 90 }, true)
    expect(history.depth()).equals(2)
    expect(history.back()).equals(true)
    expect(history.current()).deep.equals({ name: 'home' })
  })

  it('counts the same address once', function () {
    // iOS can deliver one tap as both a universal link and a handoff
    // activity, and somebody can tap the same link twice.
    const history = makeHistory()
    history.show({ name: 'team', teamId: 't1' })
    history.show({ name: 'team', teamId: 't1' })
    expect(history.depth()).equals(2)
  })

  it('knows a tab is part of the address', function () {
    // Which is why Back from the box score returns to the video rather than
    // leaving the game — the same two addresses a browser would keep.
    const history = makeHistory()
    history.show({ name: 'game', gameId: 'g1', tab: 'watch' })
    history.show({ name: 'game', gameId: 'g1', tab: 'boxScore' })
    expect(history.depth()).equals(3)
    history.back()
    expect(history.current()).deep.equals({
      name: 'game',
      gameId: 'g1',
      tab: 'watch'
    })
  })

  it('starts again on the address a link opened', function () {
    const history = makeHistory()
    history.show({ name: 'team', teamId: 't1' })
    history.seed({ name: 'join', code: 'demo2026' })
    expect(history.depth()).equals(1)
    expect(history.back()).equals(false)
  })
})
