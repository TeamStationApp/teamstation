import { expect } from 'chai'
import { describe, it } from 'mocha'

import { type Role, ROLES } from '../../common/roles'
import type { RoleScopes } from '../access'
import { mayScoreOpenSide } from './openSides'

/** Roles holding nothing, but `held` on the teams and seasons named. */
const holding = (
  held: Partial<Record<Role, { teamIds?: string[]; seasonIds?: string[] }>>,
  isAdmin = false
): RoleScopes => {
  const roles: Partial<RoleScopes> = { isAdmin }
  for (const role of ROLES)
    roles[role] = {
      leagueIds: new Set<string>(),
      seasonIds: new Set(held[role]?.seasonIds ?? []),
      teamIds: new Set(held[role]?.teamIds ?? [])
    }
  return roles as RoleScopes
}

describe('who may start scoring a game with an open side', () => {
  const awayOpen = {
    home_team_id: 'tem_ravens',
    away_team_id: null,
    season_id: 'ssn_valley'
  }
  const bothOpen = {
    home_team_id: null,
    away_team_id: null,
    season_id: 'ssn_valley'
  }

  it('lets a scorekeeper of a named side', () => {
    const scorer = holding({ scorekeeper: { teamIds: ['tem_ravens'] } })
    expect(mayScoreOpenSide(scorer, awayOpen)).equals(true)
    expect(mayScoreOpenSide(scorer, bothOpen)).equals(false)
  })

  it('lets a scorekeeper of the game’s season, whatever its sides', () => {
    const season = holding({ scorekeeper: { seasonIds: ['ssn_valley'] } })
    expect(mayScoreOpenSide(season, awayOpen)).equals(true)
    expect(mayScoreOpenSide(season, bothOpen)).equals(true)
    expect(
      mayScoreOpenSide(season, { ...awayOpen, season_id: 'ssn_other' })
    ).equals(false)
    expect(mayScoreOpenSide(season, { ...awayOpen, season_id: null })).equals(
      false
    )
  })

  it('lets a site administrator', () => {
    expect(mayScoreOpenSide(holding({}, true), bothOpen)).equals(true)
  })

  it('refuses a stranger, and a coach who does not score', () => {
    expect(mayScoreOpenSide(holding({}), awayOpen)).equals(false)
    expect(
      mayScoreOpenSide(
        holding({ coach: { teamIds: ['tem_ravens'] } }),
        awayOpen
      )
    ).equals(false)
  })
})
