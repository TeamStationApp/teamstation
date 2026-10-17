import { expect } from 'chai'
import { describe, it } from 'mocha'

import { TeamStationClient } from '../../../common/api'
import { boardStep, OVERLAY_T0 } from '../../../test/overlayFixtures'
import { keptBoard } from './keptBoard'

const client = (): TeamStationClient =>
  new TeamStationClient({ baseUrl: '/api/v1', fetch })

describe('the board a game keeps once shown', function () {
  const first = boardStep(OVERLAY_T0 + 1000, 1)
  const later = boardStep(OVERLAY_T0 + 5000, 2)
  const steps = [first, later]

  it('is forgotten, and nothing drawn, once the server says the game shows none', function () {
    const one = client()
    const base = { client: one, gameId: 'g1', steps, wallMs: OVERLAY_T0 }
    expect(keptBoard({ ...base, framed: first, step: first })).equals(first)
    expect(
      keptBoard({ ...base, hidden: true, framed: null, step: null })
    ).equals(null)
    // Shown again later only if a frame calls for it.
    expect(keptBoard({ ...base, framed: null, step: later })).equals(null)
  })

  it('is nothing until the game has shown one', function () {
    expect(
      keptBoard({
        client: client(),
        gameId: 'g1',
        framed: null,
        step: later,
        steps,
        wallMs: OVERLAY_T0 + 6000
      })
    ).equals(null)
  })

  it('is the framed board, and needs a game to keep one', function () {
    const one = client()
    expect(
      keptBoard({
        client: one,
        gameId: null,
        framed: first,
        step: first,
        steps,
        wallMs: OVERLAY_T0
      })
    ).equals(first)
    expect(
      keptBoard({
        client: one,
        gameId: 'g1',
        framed: null,
        step: null,
        steps: null,
        wallMs: null
      })
    ).equals(null)
  })

  it('once shown, is the board at the frame, zeroed before the first event, or the last one while unknown', function () {
    const one = client()
    const base = { client: one, gameId: 'g1', steps }
    expect(
      keptBoard({ ...base, framed: first, step: first, wallMs: OVERLAY_T0 })
    ).equals(first)
    // A video with none of the game's events: the board at its frame.
    expect(
      keptBoard({ ...base, framed: null, step: later, wallMs: OVERLAY_T0 })
    ).equals(later)
    // Before the game's first event: team names and nothing else.
    const zeroed = keptBoard({
      ...base,
      framed: null,
      step: null,
      wallMs: OVERLAY_T0 - 60_000
    })!
    expect(zeroed.at).equals(OVERLAY_T0 - 60_000)
    expect(zeroed.state.inning).equals(0)
    expect(zeroed.state.awayTeam).equals(first.state.awayTeam)
    // The frame's wall time, or the steps, still loading: the last board.
    expect(
      keptBoard({ ...base, framed: null, step: null, wallMs: null })
    ).equals(first)
    expect(
      keptBoard({
        ...base,
        steps: null,
        framed: null,
        step: null,
        wallMs: OVERLAY_T0
      })
    ).equals(first)
    expect(
      keptBoard({
        ...base,
        steps: [],
        framed: null,
        step: null,
        wallMs: OVERLAY_T0
      })
    ).equals(first)
    // Another game starts afresh.
    expect(
      keptBoard({
        ...base,
        gameId: 'g2',
        framed: null,
        step: later,
        wallMs: OVERLAY_T0
      })
    ).equals(null)
  })
})
