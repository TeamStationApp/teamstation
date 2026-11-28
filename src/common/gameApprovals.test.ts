import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  asGameIntent,
  asGameProposal,
  asGameScheduleProposal,
  asGameScheduling
} from './gameApprovals'

const game = (
  homeTeamId: unknown,
  awayTeamId: unknown
): Record<string, unknown> => ({
  homeTeamId,
  awayTeamId,
  seasonId: 'season-1',
  startAt: '2027-04-03T14:00:00.000Z',
  venue: null,
  outsideTournament: null,
  status: 'scheduled'
})

const proposal = (
  sender: { kind: string; id: string },
  homeTeamId: unknown,
  awayTeamId: unknown
): unknown => ({
  sender,
  game: game(homeTeamId, awayTeamId),
  idempotencyKey: 'key-00000001'
})

const team = { kind: 'team', id: 'team-ravens' }
const season = { kind: 'season', id: 'season-1' }

describe('game proposals with an open side', () => {
  it('takes null for a side, leaving it open', () => {
    const away = asGameProposal(proposal(team, 'team-ravens', null))
    expect(away.game.homeTeamId).equals('team-ravens')
    expect(away.game.awayTeamId).equals(null)
    const home = asGameProposal(proposal(season, null, 'team-ravens'))
    expect(home.game.homeTeamId).equals(null)
    expect(home.game.awayTeamId).equals('team-ravens')
  })

  it('still refuses an empty or missing side', () => {
    expect(() => asGameProposal(proposal(team, '', 'team-herons'))).throws(
      'Choose a valid team or season'
    )
    expect(() =>
      asGameProposal(proposal(team, 'team-ravens', undefined))
    ).throws('Choose a valid team or season')
  })

  it('refuses two equal named teams, but not two open sides', () => {
    expect(() =>
      asGameProposal(proposal(team, 'team-ravens', 'team-ravens'))
    ).throws('Choose two different teams')
    const both = asGameProposal(proposal(season, null, null))
    expect([both.game.homeTeamId, both.game.awayTeamId]).deep.equals([
      null,
      null
    ])
  })

  it('refuses both sides open unless a season sends it', () => {
    expect(() => asGameProposal(proposal(team, null, null))).throws(
      'Choose at least one team, or send the game from its season'
    )
  })
})

describe('game answers with an open side', () => {
  it("reads an open side's '' (or null) as null, and keeps a named id", () => {
    const open = asGameIntent(game('', 'team-ravens'))
    expect(open.homeTeamId).equals(null)
    expect(open.awayTeamId).equals('team-ravens')
    expect(asGameIntent(game(null, '')).homeTeamId).equals(null)
    expect(() => asGameIntent(game(3, 'team-ravens'))).throws(TypeError)
  })

  it('reads the scheduling answer and a proposal row with an open side', () => {
    const scheduling = asGameScheduling({
      game: game('team-ravens', ''),
      version: 'v',
      canPropose: true,
      withdrawTeamIds: []
    })
    expect(scheduling.game.awayTeamId).equals(null)
    const row = asGameScheduleProposal({
      requestId: 'invite-1',
      gameId: 'game-1',
      game: game('team-ravens', 'team-herons'),
      previous: game('team-ravens', ''),
      status: 'pending',
      sentAt: '2027-01-01T00:00:00.000Z',
      canDelete: false,
      version: null
    })
    expect(row.previous?.awayTeamId).equals(null)
    expect(row.game.awayTeamId).equals('team-herons')
  })
})
