import { expect } from 'chai'

import type { Pushed } from '../App'
import { screenIdentity as identityOf } from './screenIdentity'
import {
  frameKey,
  rootKey,
  type StackScene,
  swipeCompletes,
  systemBackPops,
  transitionOf
} from './stackScene'

function scene(
  key: string,
  options: Partial<Omit<StackScene, 'key'>> = {}
): StackScene {
  return {
    key,
    group: 'home',
    depth: 1,
    presentation: 'push',
    immersive: false,
    node: null,
    ...options
  }
}

describe('stack transitions (U1)', function () {
  it('follows a forward intent with the incoming presentation', function () {
    expect(
      transitionOf(scene('a'), scene('b', { presentation: 'cover' }), 'forward')
    ).deep.equals({ kind: 'forward', presentation: 'cover' })
    expect(transitionOf(scene('a'), scene('b'), 'forward')).deep.equals({
      kind: 'forward',
      presentation: 'push'
    })
  })

  it('follows a back intent with the outgoing presentation', function () {
    expect(
      transitionOf(scene('a', { presentation: 'cover' }), scene('b'), 'back')
    ).deep.equals({ kind: 'back', presentation: 'cover' })
    expect(transitionOf(scene('a'), scene('b'), 'back')).deep.equals({
      kind: 'back',
      presentation: 'push'
    })
  })

  it('does not move for intent none, the same key or nothing before', function () {
    expect(transitionOf(scene('a'), scene('b'), 'none')).deep.equals({
      kind: 'none'
    })
    expect(transitionOf(scene('a'), scene('a'), 'forward')).deep.equals({
      kind: 'none'
    })
    expect(transitionOf(undefined, scene('a'), 'forward')).deep.equals({
      kind: 'none'
    })
  })

  it('infers an unlabelled move within one tab only', function () {
    const shallow = scene('a', { depth: 1 })
    const deep = scene('b', { depth: 2 })
    expect(transitionOf(shallow, deep, undefined).kind).equals('forward')
    expect(transitionOf(deep, shallow, undefined).kind).equals('back')
    expect(
      transitionOf(shallow, scene('c', { depth: 1 }), undefined).kind
    ).equals('none')
    expect(
      transitionOf(
        shallow,
        scene('d', { group: 'schedule', depth: 2 }),
        undefined
      ).kind
    ).equals('none')
  })

  it('goes back across tabs when the intent says so', function () {
    // Schedule's game, then browser Back onto Home.
    expect(
      transitionOf(
        scene('schedule:game', { group: 'schedule', depth: 1 }),
        scene('home:root', { group: 'home', depth: 0 }),
        'back'
      )
    ).deep.equals({ kind: 'back', presentation: 'push' })
  })
})

describe('stack scene keys (U1)', function () {
  const team = (id: string, tab?: string): Pushed => ({
    name: 'team',
    team: {
      id,
      name: 'Hawks',
      shortName: null,
      logoPath: null,
      logoUrl: null,
      record: null,
      seasonCategory: 'unscheduled',
      canViewPrivate: true,
      kind: 'full'
    },
    tab
  })
  const game = (
    gameId: string,
    extra: { videoId?: string; at?: number; angles?: string[] } = {}
  ): Pushed => ({ name: 'game', gameId, title: 'A game', ...extra })
  const key = (group: string, frames: Pushed[], index: number): string =>
    frameKey(group, frames, index, identityOf)

  it('ignores what changes in place', function () {
    expect(identityOf(team('t1'))).equals(identityOf(team('t1', 'stats')))
    expect(identityOf(game('g1'))).equals(
      identityOf(game('g1', { videoId: 'v', at: 42, angles: ['v'] }))
    )
    expect(identityOf(team('t1'))).not.equals(identityOf(team('t2')))
    expect(identityOf(game('g1'))).not.equals(identityOf(team('g1')))
  })

  it('tells Coach Game teams apart and nothing else by team id', function () {
    expect(
      identityOf({ name: 'coachGame', gameId: 'g', teamId: 'a' })
    ).not.equals(identityOf({ name: 'coachGame', gameId: 'g', teamId: 'b' }))
    const player = (teamId: string): Pushed => ({
      name: 'player',
      userId: '1',
      title: 'Alex',
      teamId
    })
    expect(identityOf(player('a'))).equals(identityOf(player('b')))
  })

  it('tells a song on one team from the same player’s on another', function () {
    const song = (teamId: string): Pushed => ({
      name: 'walkUpSong',
      teamId,
      userId: '1',
      playerName: 'Alex',
      song: null
    })
    expect(identityOf(song('a'))).not.equals(identityOf(song('b')))
  })

  it('counts only the run of one screen directly below', function () {
    const twice = [team('t1'), team('t1', 'stats')]
    expect(key('home', twice, 0)).not.equals(key('home', twice, 1))
    expect(key('home', twice, 1)).match(/#1$/)
    const apart = [game('g1'), team('t1'), game('g1')]
    expect(key('home', apart, 0)).equals(key('home', apart, 2))
    expect(key('home', apart, 2)).match(/#0$/)
    expect(key('home', [game('g1')], 0)).equals(key('home', apart, 2))
  })

  it('names the root and the tab', function () {
    expect(rootKey('schedule')).equals('schedule:root')
    expect(key('videos', [team('t1')], 0)).match(/^videos:team:t1/)
  })
})

describe('stack swipe release (U2)', function () {
  it('completes past half way', function () {
    expect(swipeCompletes(250, 0, 400)).equals(true)
  })
  it('completes a short rightward fling', function () {
    expect(swipeCompletes(60, 800, 400)).equals(true)
  })
  it('springs back short and slow', function () {
    expect(swipeCompletes(150, 100, 400)).equals(false)
    expect(swipeCompletes(0, 900, 400)).equals(false)
  })
  it('springs back on a leftward fling past half way', function () {
    expect(swipeCompletes(300, -400, 400)).equals(false)
  })
})

describe('the system Back gate (U22)', function () {
  it('drags only when the history lands on the frame beneath', function () {
    expect(systemBackPops('/', '/')).equals(true)
    expect(systemBackPops('/teams/t1?tab=team', '/teams/t1?tab=team')).equals(
      true
    )
    // Stats pill, then Back: the history walks to the team's other pill.
    expect(systemBackPops('/teams/t1', '/')).equals(false)
    expect(systemBackPops('/teams/t1', '/teams/t1?tab=team')).equals(false)
    // A tab switch: the previous entry is on another tab.
    expect(systemBackPops('/schedule', '/')).equals(false)
    expect(systemBackPops(undefined, '/')).equals(false)
  })
})
