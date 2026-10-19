import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  LIVE_RELOAD_MS,
  MAX_LIVE_RELOAD_MS,
  type ReloadClock,
  reloadStalledLive
} from './liveReload'

function fixture(): {
  player: { currentTime: number; ended: boolean }
  restarts: () => number
  advance: (seconds: number) => void
  want: (value: boolean) => void
  stop: () => void
} {
  let now = 0
  let run: (() => void) | undefined
  const clock: ReloadClock = {
    now: () => now,
    setTimeout: next => {
      run = next
      return next
    },
    clearTimeout: () => {
      run = undefined
    }
  }
  let restarts = 0
  const player = { currentTime: 2941, ended: false }
  let wanted = true
  const stop = reloadStalledLive(
    player,
    () => wanted,
    () => {
      restarts += 1
    },
    clock
  )
  return {
    player,
    restarts: () => restarts,
    advance: seconds => {
      for (let i = 0; i < seconds; i++) {
        now += 1000
        run?.()
      }
    },
    want: value => {
      wanted = value
    },
    stop
  }
}

describe('a live phone player that stopped for good', function () {
  it('is restarted after twenty seconds without moving', function () {
    const f = fixture()
    f.advance(LIVE_RELOAD_MS / 1000 - 1)
    expect(f.restarts()).equals(0)
    f.advance(1)
    expect(f.restarts()).equals(1)
    f.stop()
  })

  it('waits longer each time while the game stays away, up to a minute', function () {
    const f = fixture()
    const at: number[] = []
    for (let second = 1; second <= 260; second++) {
      const before = f.restarts()
      f.advance(1)
      if (f.restarts() > before) at.push(second)
    }
    expect(at).deep.equals([20, 60, 120, 180, 240])
    expect(MAX_LIVE_RELOAD_MS).equals(60_000)
    f.stop()
  })

  it('starts counting again once the picture moves past where it stopped', function () {
    const f = fixture()
    f.advance(40)
    expect(f.restarts()).equals(1)
    f.player.currentTime += 1
    // The tick that sees it move, then nineteen more.
    f.advance(20)
    expect(f.restarts()).equals(1)
    f.advance(1)
    expect(f.restarts(), 'back to twenty seconds').equals(2)
    f.stop()
  })

  it('does not take a replay of what it already had for the game coming back', function () {
    const f = fixture()
    f.advance(20)
    expect(f.restarts()).equals(1)
    // Reopened a few seconds back, it plays up to where it stopped.
    f.player.currentTime = 2930
    f.advance(1)
    for (let second = 0; second < 11; second++) {
      f.player.currentTime += 1
      f.advance(1)
    }
    expect(f.player.currentTime).equals(2941)
    // Still away: the next restart comes on the doubled wait.
    f.advance(28)
    expect(f.restarts()).equals(2)
    f.stop()
  })

  it('counts a viewer watching well back from where it stopped as playing', function () {
    const f = fixture()
    f.advance(20)
    expect(f.restarts()).equals(1)
    // Off to an earlier inning while the game is away.
    f.player.currentTime = 2400
    f.advance(1)
    for (let second = 0; second < 120; second++) {
      f.player.currentTime += 1
      f.advance(1)
    }
    expect(f.restarts(), 'no restarts while it plays').equals(1)
    f.stop()
  })

  it('leaves a player that has reached the end alone', function () {
    const f = fixture()
    f.player.ended = true
    f.advance(120)
    expect(f.restarts()).equals(0)
    f.stop()
  })

  it('leaves a viewer who does not want it playing alone', function () {
    const f = fixture()
    f.want(false)
    f.advance(120)
    expect(f.restarts()).equals(0)
    f.want(true)
    f.advance(20)
    expect(f.restarts()).equals(1)
    f.stop()
    f.advance(600)
    expect(f.restarts()).equals(1)
  })

  it('only restarts a player that has failed', function () {
    let now = 0
    let run: (() => void) | undefined
    let failed = false
    let restarts = 0
    reloadStalledLive(
      { currentTime: 10 },
      () => true,
      () => {
        restarts += 1
      },
      {
        now: () => now,
        setTimeout: next => {
          run = next
          return next
        },
        clearTimeout: () => undefined
      },
      () => failed
    )
    for (let second = 0; second < 300; second++) {
      now += 1000
      run?.()
    }
    expect(restarts, 'waiting for footage').equals(0)
    failed = true
    now += 1000
    run?.()
    expect(restarts, 'failed, and long still').equals(1)
  })

  it('can run on the real clock', function () {
    reloadStalledLive(
      { currentTime: 0 },
      () => true,
      () => undefined
    )()
  })
})
