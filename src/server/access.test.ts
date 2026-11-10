import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  type AdminScopes,
  canManageTeam,
  canSeeGame,
  canSeeTeam,
  type VisibleScopes
} from './access'

const scopes = (
  teamIds: string[],
  seasonIds: string[],
  isAdmin = false
): VisibleScopes => ({
  teamIds: new Set(teamIds),
  seasonIds: new Set(seasonIds),
  isAdmin
})

describe('access', function () {
  const game = {
    homeTeamId: 'tem_home',
    awayTeamId: 'tem_away',
    seasonId: 'sea_spring'
  }

  it("shows a team's own people that team's games", function () {
    expect(canSeeGame(scopes(['tem_home'], []), game)).equals(true)
    expect(canSeeGame(scopes(['tem_away'], []), game)).equals(true)
  })

  it('hides a game from someone in neither team', function () {
    expect(canSeeGame(scopes(['tem_other'], []), game)).equals(false)
  })

  it('shows a game when its season has been opened up', function () {
    expect(canSeeGame(scopes(['tem_other'], ['sea_spring']), game)).equals(true)
  })

  it('does not let an opened season cover a game outside it', function () {
    const other = { ...game, seasonId: 'sea_fall' }
    expect(canSeeGame(scopes(['tem_other'], ['sea_spring']), other)).equals(
      false
    )
  })

  it('never lets a seasonless game be opened up by a season', function () {
    const friendly = { ...game, seasonId: null }
    expect(canSeeGame(scopes(['tem_other'], ['sea_spring']), friendly)).equals(
      false
    )
  })

  it('shows a site administrator everything', function () {
    expect(canSeeGame(scopes([], [], true), game)).equals(true)
    expect(canSeeTeam(scopes([], [], true), 'tem_any')).equals(true)
  })

  it('keeps team visibility to actual members', function () {
    expect(canSeeTeam(scopes(['tem_home'], ['sea_spring']), 'tem_home')).equals(
      true
    )
    // Being able to watch a season's games does not make you a team member.
    expect(canSeeTeam(scopes([], ['sea_spring']), 'tem_home')).equals(false)
  })

  it('separates managing from watching', function () {
    const admin: AdminScopes = {
      leagueIds: new Set(),
      seasonIds: new Set(),
      teamIds: new Set(['tem_home']),
      isAdmin: false
    }
    expect(canManageTeam(admin, 'tem_home')).equals(true)
    expect(canManageTeam(admin, 'tem_away')).equals(false)
  })
})
