import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  applyOverrides,
  asDashboardCommand,
  asScoreboardState,
  asScoreboardUpdate,
  carriesContested,
  composeScoreboard,
  type DashboardOverrides,
  mergeScoreboard,
  NO_OVERRIDES,
  SAMPLE_SCOREBOARD,
  SCOREBOARD_CLOSE,
  scoreboardExpiry,
  scoreboardOpen,
  type ScoreboardState,
  withoutTeamNames
} from './scoreboard'

const baseline = {
  homeTeam: 'Hawks',
  awayTeam: 'Gulls',
  homeScore: 4,
  awayScore: null
}

const HOUR = 3_600_000
const DAY = 24 * HOUR
const S = Date.parse('2026-09-28T18:00:00Z')

describe('a scoreboard', function () {
  describe('composeScoreboard', function () {
    it('shows the game record over the defaults with nothing else', function () {
      const { automated, final } = composeScoreboard({ baseline })
      expect(automated).deep.equals({
        inGame: false,
        pitcherName: '',
        batterName: '',
        batterNumber: 0,
        batterNumHits: 0,
        batterAtBats: 0,
        numPitches: 0,
        balls: 0,
        strikes: 0,
        outs: 0,
        base1: false,
        base2: false,
        base3: false,
        inning: 1,
        half: 'top',
        homeTeam: 'Hawks',
        awayTeam: 'Gulls',
        homeScore: 4,
        awayScore: 0,
        pitchSpeed: 0,
        exitVelocity: 0
      })
      expect(final).deep.equals(automated)
      expect(asScoreboardState(final)).deep.equals(final)
    })

    it('lets the game source win over the record', function () {
      const { final } = composeScoreboard({
        baseline,
        game: {
          state: { inGame: true, homeScore: 6, awayScore: 2, inning: 3 },
          receivedAt: 10
        }
      })
      expect(final).includes({
        inGame: true,
        homeScore: 6,
        awayScore: 2,
        inning: 3,
        homeTeam: 'Hawks'
      })
    })

    it('lets the newer source win the fields it sent, and keeps the rest', function () {
      const watcher = {
        state: { balls: 3, pitchSpeed: 71 },
        receivedAt: 20
      }
      const newerWatcher = composeScoreboard({
        baseline,
        game: { state: { balls: 1, strikes: 2 }, receivedAt: 10 },
        watcher
      })
      expect(newerWatcher.final).includes({
        balls: 3,
        strikes: 2,
        pitchSpeed: 71
      })
      const newerGame = composeScoreboard({
        baseline,
        game: { state: { balls: 1, strikes: 2 }, receivedAt: 30 },
        watcher
      })
      expect(newerGame.final).includes({
        balls: 1,
        strikes: 2,
        pitchSpeed: 71
      })
    })

    it('gives a tie to the game', function () {
      const { final } = composeScoreboard({
        baseline,
        watcher: { state: { outs: 1 }, receivedAt: 50 },
        game: { state: { outs: 2 }, receivedAt: 50 }
      })
      expect(final.outs).equals(2)
    })

    it('never lets an automated source name the teams', function () {
      const { final } = composeScoreboard({
        baseline,
        watcher: {
          state: { homeTeam: 'WRONG', awayTeam: 'ALSO WRONG' },
          receivedAt: 99
        }
      })
      expect(final).includes({ homeTeam: 'Hawks', awayTeam: 'Gulls' })
    })

    it('applies each override group, and only when it is on', function () {
      const game = {
        state: {
          balls: 1,
          strikes: 1,
          outs: 1,
          base1: true,
          base2: false,
          base3: false,
          inning: 4,
          half: 'bottom' as const,
          homeScore: 5,
          awayScore: 3
        },
        receivedAt: 1
      }
      const { automated } = composeScoreboard({ baseline, game })
      const groups: Array<{
        on: Partial<DashboardOverrides>
        changes: Partial<ScoreboardState>
      }> = [
        {
          on: {
            overrideCountEnabled: true,
            overrideCount: { balls: 3, strikes: 2, outs: 2 }
          },
          changes: { balls: 3, strikes: 2, outs: 2 }
        },
        {
          on: {
            overrideBasesEnabled: true,
            overrideBases: { base1: false, base2: true, base3: true }
          },
          changes: { base1: false, base2: true, base3: true }
        },
        {
          on: {
            overrideTeamEnabled: true,
            overrideTeam: { homeTeam: 'H', awayTeam: 'A' }
          },
          changes: { homeTeam: 'H', awayTeam: 'A' }
        },
        {
          on: {
            overrideScoreEnabled: true,
            overrideScore: { homeScore: 9, awayScore: 8 }
          },
          changes: { homeScore: 9, awayScore: 8 }
        },
        {
          on: {
            overrideInningEnabled: true,
            overrideInning: { inning: 7, half: 'mid' }
          },
          changes: { inning: 7, half: 'mid' }
        }
      ]
      for (const group of groups) {
        const on = { ...NO_OVERRIDES, ...group.on }
        expect(
          composeScoreboard({ baseline, game, overrides: on }).final
        ).deep.equals({ ...automated, ...group.changes })
        // The same values with the flag off change nothing.
        const off = Object.fromEntries(
          Object.entries(on).map(([key, value]) => [
            key,
            typeof value === 'boolean' ? false : value
          ])
        ) as unknown as DashboardOverrides
        expect(applyOverrides(automated, off)).deep.equals(automated)
      }
      expect(
        composeScoreboard({ baseline, game, overrides: NO_OVERRIDES }).final
      ).deep.equals(automated)
    })
  })

  it('merges only the fields an update defines', function () {
    const state = { ...SAMPLE_SCOREBOARD }
    const merged = mergeScoreboard(
      state,
      asScoreboardUpdate({ balls: 0, strikes: undefined, pitchSpeed: 71 })
    )
    expect(merged).deep.equals({
      ...SAMPLE_SCOREBOARD,
      balls: 0,
      pitchSpeed: 71
    })
    expect(state).deep.equals(SAMPLE_SCOREBOARD)
  })

  it('tells a contested packet from one only Watcher can send', function () {
    expect(carriesContested({ pitchSpeed: 71 })).equals(false)
    expect(
      carriesContested({ batterNumber: 3, batterNumHits: 1, exitVelocity: 80 })
    ).equals(false)
    expect(carriesContested({ balls: 1, pitchSpeed: 71 })).equals(true)
    expect(
      withoutTeamNames({ homeTeam: 'x', awayTeam: 'y', outs: 1 })
    ).deep.equals({ outs: 1 })
  })

  it('reads the dashboard’s two commands and nothing else', function () {
    expect(asDashboardCommand({ type: 'reset' })).deep.equals({ type: 'reset' })
    expect(
      asDashboardCommand({ type: 'overrides', data: NO_OVERRIDES })
    ).deep.includes({ type: 'overrides' })
    expect(() => asDashboardCommand({ type: 'other' })).throws(TypeError)
    expect(() =>
      asDashboardCommand({ type: 'overrides', data: { balls: 1 } })
    ).throws(TypeError)
  })

  it('has a sample that sets every field, and the close codes', function () {
    expect(asScoreboardState(SAMPLE_SCOREBOARD)).deep.equals(SAMPLE_SCOREBOARD)
    expect(SCOREBOARD_CLOSE).deep.equals({
      unreadable: 4400,
      notSignedIn: 4401,
      notAllowed: 4403,
      closed: 4404
    })
  })

  describe('opening and closing', function () {
    it('expires two hours after the later of the write and the start, within three days', function () {
      expect(scoreboardExpiry(S, S - DAY)).equals(S + 2 * HOUR)
      expect(scoreboardExpiry(S, S + HOUR)).equals(S + 3 * HOUR)
      expect(scoreboardExpiry(S, S + 2 * DAY + 23 * HOUR)).equals(S + 3 * DAY)
    })

    it('is open from creation to start + 2 h with no key, and while a key exists', function () {
      const game = { startAt: S, status: 'scheduled' }
      expect(scoreboardOpen(game, false, S - 5 * DAY)).equals(true)
      expect(scoreboardOpen(game, false, S + HOUR + 59 * 60_000)).equals(true)
      expect(scoreboardOpen(game, false, S + 2 * HOUR)).equals(false)
      expect(scoreboardOpen(game, true, S + 2 * DAY)).equals(true)
      expect(
        scoreboardOpen({ startAt: S, status: 'cancelled' }, true, S)
      ).equals(false)
      expect(scoreboardOpen(undefined, true, S)).equals(false)
    })
  })
})
