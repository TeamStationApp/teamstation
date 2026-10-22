import { expect } from 'chai'

import { frameMatchesPath, makeHistory, suffixDropCount } from './history'

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

const homeLine = [
  '/',
  '/teams/id',
  '/teams/id?tab=schedule',
  '/games/id',
  '/teams/id',
  '/teams/id?tab=team',
  '/players/id'
]
const homeFrames = [
  { name: 'team', team: { id: 'id' } },
  { name: 'game', gameId: 'id' },
  { name: 'player', userId: 'id' }
]

describe('clearing a tab drops only a straight-line suffix', function () {
  it('drops every entry after home on the home path', function () {
    const matches = (path: string): boolean =>
      homeFrames.some(frame => {
        const pathname = path.split('?')[0]
        if (frame.name === 'team') return pathname === '/teams/id'
        if (frame.name === 'game') return pathname === '/games/id'
        return pathname === '/players/id'
      })
    expect(suffixDropCount(homeLine, matches, '/')).equals(6)
    const history = makeHistory()
    history.show({ name: 'team', teamId: 'id' })
    history.show({ name: 'team', teamId: 'id', tab: 'schedule' })
    history.show({ name: 'game', gameId: 'id' })
    history.show({ name: 'team', teamId: 'id' })
    history.show({ name: 'team', teamId: 'id', tab: 'team' })
    history.show({ name: 'player', userId: 'id' })
    expect(history.dropSuffix(homeFrames, '/')).equals(6)
    expect(history.current()).deep.equals({ name: 'home' })
    expect(history.depth()).equals(1)
    expect(history.back()).equals(false)
  })

  it('drops nothing when the survivor would be another tab', function () {
    const history = makeHistory()
    history.show({ name: 'videos', when: 'past' })
    history.show({ name: 'team', teamId: 'id' })
    expect(history.dropSuffix(homeFrames, '/')).equals(0)
    expect(history.depth()).equals(3)
    expect(history.current()).deep.equals({ name: 'team', teamId: 'id' })
  })

  it('drops a season and an encoded group back to Discover', function () {
    const frames = [
      { name: 'group', kind: 'league', id: 'a/b' },
      { name: 'season', season: { id: 'sea_1' } }
    ]
    expect(
      frameMatchesPath(
        { name: 'season', season: { id: 'sea_1' } },
        '/seasons/sea_1?tab=standings'
      )
    ).equals(true)
    expect(
      frameMatchesPath(
        { name: 'group', kind: 'league', id: 'a/b' },
        '/groups/league/a%2Fb?tab=seasons'
      )
    ).equals(true)
    expect(frameMatchesPath({ name: 'team' }, '/teams/id')).equals(false)
    expect(frameMatchesPath({ name: 'game' }, '/games/id')).equals(false)
    expect(frameMatchesPath({ name: 'player' }, '/players/id')).equals(false)
    expect(frameMatchesPath({ name: 'season' }, '/seasons/sea_1')).equals(false)
    expect(
      frameMatchesPath(
        { name: 'group', kind: 'league' },
        '/groups/league/a%2Fb'
      )
    ).equals(false)
    expect(
      frameMatchesPath({ name: 'group', id: 'a/b' }, '/groups/league/a%2Fb')
    ).equals(false)
    expect(frameMatchesPath({ name: 'videos' }, '/videos')).equals(false)

    const history = makeHistory()
    history.show({ name: 'team', teamId: 'id' })
    history.show({ name: 'discover' })
    history.show({ name: 'group', kind: 'league', id: 'a/b' })
    history.show({ name: 'season', seasonId: 'sea_1', tab: 'standings' })
    expect(history.dropSuffix(frames, '/discover')).equals(2)
    expect(history.current()).deep.equals({ name: 'discover' })
    expect(history.back()).equals(true)
  })

  it('drops nothing when a slot under the suffix was never recorded', function () {
    const reloaded: string[] = []
    reloaded[2] = '/games/id'
    const skipped = ['/']
    skipped[2] = '/games/id'
    const matches = (path: string): boolean => path === '/games/id'
    expect(suffixDropCount(reloaded, matches, '/')).equals(0)
    expect(suffixDropCount(skipped, matches, '/')).equals(0)
  })

  it('never drops the seed', function () {
    const history = makeHistory()
    history.seed({ name: 'player', userId: 'id' })
    expect(history.dropSuffix(homeFrames, '/')).equals(0)
    expect(history.depth()).equals(1)
    expect(history.current()).deep.equals({ name: 'player', userId: 'id' })
  })
})
