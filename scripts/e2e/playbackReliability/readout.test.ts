import assert from 'node:assert/strict'

import { describe, it } from 'mocha'

import { judgeReadout, parseReadout, type Readout } from './readout'

function tile(name: string, atSec: number, playing = true): string {
  return `${name.padEnd(9)} buf 3.2s  ready 4  at ${atSec.toFixed(1)}  to ${atSec.toFixed(1)}  ${playing ? 'playing' : 'paused'}  ok`
}

/** Snapshots every 500 ms of one tile at the given positions. */
function snapshots(positions: number[], held: boolean[] = []): Readout[] {
  return positions.map((atSec, index) =>
    parseReadout(
      [
        tile('1st', atSec),
        `clock ${atSec.toFixed(1)}s  ${held[index] ? 'held' : 'playing'}  ahead ≤ 30s`
      ],
      index * 500
    )
  )
}

describe('playback probe: readout', function () {
  it('parses tile lines, the clock line and the gate, and skips everything else', function () {
    const readout = parseReadout(
      [
        'Demo Hawks 11U',
        '1st       buf 0.0s  ready 1  at 2729.3  to —  paused  stalled 4.2s  parked notYet  left out',
        'Home      buf 12.5s  ready 4  at 2731.0  to 2731.0  playing  ok  waits short 4.1s',
        'clock 812.4s  held  ahead ≤ 30s  heard 1st  gate all-short 4.1s'
      ],
      1234
    )
    assert.equal(readout.atMs, 1234)
    assert.deepEqual(readout.tiles[0], {
      name: '1st',
      bufSec: 0,
      ready: 1,
      atSec: 2729.3,
      toSec: null,
      playing: false,
      stalledSec: 4.2,
      parked: 'notYet',
      leftOut: true
    })
    assert.equal(readout.tiles[1].playing, true)
    assert.equal(readout.tiles[1].stalledSec, null)
    assert.equal(readout.tiles[1].leftOut, false)
    assert.deepEqual(readout.clock, {
      clockSec: 812.4,
      held: true,
      gate: 'all-short 4.1s'
    })
    assert.equal(
      parseReadout(['clock 1.0s  playing  ahead ≤ 30s'], 0).clock?.gate,
      null
    )
    assert.equal(parseReadout([], 0).clock, null)
  })

  it('passes a tile moving at real speed with the grid playing', function () {
    const verdict = judgeReadout(snapshots([100, 100.5, 101, 101.5, 102]))
    assert.equal(verdict.pass, true)
    assert.equal(verdict.rates['1st'], 1)
    assert.equal(verdict.heldMs, 0)
  })

  it('fails a tile that stands still for seconds, in the middle or to the end', function () {
    // Every 500 ms: still from 1000 to 4000 in the middle, from 1500 to the end.
    const middle = judgeReadout(
      snapshots([100, 100.5, 101, 101, 101, 101, 101, 101, 101, 101.5, 102])
    )
    assert.deepEqual(middle.freezes, [
      { tile: '1st', fromMs: 1000, toMs: 4000 }
    ])
    const end = judgeReadout(
      snapshots([
        100, 100.5, 101, 101.5, 101.5, 101.5, 101.5, 101.5, 101.5, 101.5
      ])
    )
    assert.deepEqual(end.freezes, [{ tile: '1st', fromMs: 1500, toMs: 4500 }])
    assert.equal(end.pass, false)
  })

  it('does not call one late redraw of the readout a freeze', function () {
    // The readout redraws once a second; two reads either side of one late
    // redraw show the same position over a picture that kept moving.
    const late = judgeReadout(
      snapshots([100, 100.5, 101.5, 101.5, 101.5, 102.5, 103])
    )
    assert.deepEqual(late.freezes, [])
  })

  it('allows a rate a second short over a window, the readout being up to a second old', function () {
    // 7 s of reads, 6.1 s of position: 0.87×, within a second of stale.
    const reads = [100, 101, 102, 103, 104.2, 105.2, 106.1].map(
      (atSec, index) =>
        parseReadout(
          [`1st  buf 3.2s  ready 4  at ${atSec}  to ${atSec}  playing  ok`],
          index * 1167
        )
    )
    assert.equal(judgeReadout(reads).pass, true)
  })

  it('leaves out a landing the readout had not caught up with in its first second', function () {
    // A scrub back from 313 s to 59 s: two stale held reads, then playing.
    const landing = judgeReadout(
      snapshots(
        [313.2, 313.2, 59.4, 59.9, 60.4, 60.9, 61.4],
        [true, true, false, false, false, false, false]
      )
    )
    assert.equal(landing.pass, true, landing.reasons.join())
    // Held past the first second is a hold, and still fails.
    const long = judgeReadout(
      snapshots(
        [313.2, 313.2, 313.2, 313.2, 59.4, 59.9, 60.4],
        [true, true, true, true, false, false, false]
      )
    )
    assert.equal(long.pass, false)
    assert.match(long.reasons.join(), /held for/)
  })

  it('fails slow playback and a grid held across two reads', function () {
    const slow = judgeReadout(snapshots([100, 100.2, 100.4, 100.6, 100.8]))
    assert.match(slow.reasons.join(), /0\.40× real time/)
    const held = judgeReadout(
      snapshots([100, 100.5, 101, 101.5], [false, true, true, false])
    )
    assert.equal(held.heldMs, 500)
    assert.match(held.reasons.join(), /held for 500 ms/)
    const once = judgeReadout(
      snapshots([100, 100.5, 101, 101.5], [false, true, false, false])
    )
    assert.equal(once.heldMs, 0)
  })

  it('fails when there was no readout to read', function () {
    const verdict = judgeReadout([parseReadout(['nothing here'], 0)])
    assert.equal(verdict.pass, false)
    assert.deepEqual(verdict.reasons, ['no readout lines'])
    assert.equal(judgeReadout(snapshots([100])).rates['1st'], null)
  })
})
