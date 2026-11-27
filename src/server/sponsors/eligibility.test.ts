import { createHash } from 'node:crypto'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  associatedSides,
  pickSide,
  type SponsorGame,
  sponsorLeagueOf,
  sponsorSideFor,
  type ViewerAssociation
} from './eligibility'

const GAME: SponsorGame = {
  id: 'gam_A',
  homeTeamId: 'tem_yankees',
  awayTeamId: 'tem_dodgers',
  seasonId: 'sea_al',
  seasonLeagueId: 'lea_al',
  homeLeagueId: 'lea_al',
  awayLeagueId: 'lea_nl'
}

const viewer = (
  values: Partial<Record<keyof ViewerAssociation, string[]>> = {}
): ViewerAssociation => ({
  teamIds: new Set(values.teamIds ?? []),
  seasonIds: new Set(values.seasonIds ?? []),
  leagueIds: new Set(values.leagueIds ?? [])
})

/** U28: the neutral viewer's stable pick, and which sides a viewer is on. */
describe('U28 sponsor eligibility', function () {
  describe('pickSide', function () {
    it('is stable for the same pair and covers both sides over 64 pairs', function () {
      const sides = new Set<string>()
      for (let i = 0; i < 64; i++) {
        const side = pickSide(`gam_${i}`, `usr_${i}`)
        expect(pickSide(`gam_${i}`, `usr_${i}`)).equals(side)
        sides.add(side)
      }
      expect([...sides].sort()).deep.equals(['away', 'home'])
    })

    it('gives the lowest bit of the last byte of sha256(gameId:viewerId), 0 home and 1 away', function () {
      // sha256('gam_A:usr_B') ends in 0x71: odd, so away.
      const digest = createHash('sha256').update('gam_A:usr_B').digest('hex')
      expect(digest.slice(-2)).equals('71')
      expect(pickSide('gam_A', 'usr_B')).equals('away')
      for (let i = 0; i < 64; i++) {
        const last = createHash('sha256').update(`g${i}:u${i}`).digest()[31]
        expect(pickSide(`g${i}`, `u${i}`)).equals(
          last % 2 === 0 ? 'home' : 'away'
        )
      }
    })
  })

  describe('associatedSides and sponsorSideFor', function () {
    it('gives the one team a viewer belongs to, whatever the hash says', function () {
      expect(
        associatedSides(viewer({ teamIds: ['tem_yankees'] }), GAME)
      ).deep.equals(['home'])
      for (let i = 0; i < 16; i++) {
        const game = { ...GAME, id: `gam_${i}` }
        expect(
          sponsorSideFor(viewer({ teamIds: ['tem_dodgers'] }), game, 'usr_B')
        ).equals('away')
      }
    })

    it('associates both sides for the game’s season, and so picks by the hash', function () {
      const member = viewer({ seasonIds: ['sea_al'] })
      expect(associatedSides(member, GAME)).deep.equals(['home', 'away'])
      expect(sponsorSideFor(member, GAME, 'usr_B')).equals(
        pickSide('gam_A', 'usr_B')
      )
      const both = viewer({ teamIds: ['tem_yankees', 'tem_dodgers'] })
      expect(sponsorSideFor(both, GAME, 'usr_B')).equals('away')
    })

    it('associates a league of the game’s season with that league’s own teams only', function () {
      expect(
        associatedSides(viewer({ leagueIds: ['lea_al'] }), GAME)
      ).deep.equals(['home'])
      // The NL is a team's league here, not the season's.
      expect(
        associatedSides(viewer({ leagueIds: ['lea_nl'] }), GAME)
      ).deep.equals([])
      expect(
        associatedSides(viewer({ leagueIds: ['lea_al'] }), {
          ...GAME,
          seasonId: null,
          seasonLeagueId: null
        })
      ).deep.equals([])
      expect(
        associatedSides(viewer({ seasonIds: ['sea_al'] }), {
          ...GAME,
          seasonId: null
        })
      ).deep.equals([])
    })

    it('answers the side’s own team league, null for a team in none', function () {
      expect(sponsorLeagueOf(GAME, 'home')).equals('lea_al')
      expect(sponsorLeagueOf(GAME, 'away')).equals('lea_nl')
      expect(sponsorLeagueOf({ ...GAME, awayLeagueId: null }, 'away')).equals(
        null
      )
    })
  })
})
