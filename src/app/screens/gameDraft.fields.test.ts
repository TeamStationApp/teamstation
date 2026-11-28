import { expect } from 'chai'
import { describe, it } from 'mocha'

import { asPublicGroup } from '../../common/publicGroups'
import {
  gameProposalFields,
  type LoadedGame,
  loadedGameDraft,
  TBD
} from './gameDraft'

const choice = (id: string): any => ({
  group: asPublicGroup({
    id,
    kind: 'team',
    name: id,
    locality: null,
    imageUrl: null
  })
})
const field = {
  venueId: 'ven_demo',
  venueName: 'Example Park',
  fieldId: 'fld_one',
  fieldName: 'Field 1',
  size: '50/70',
  address: '1 Example Way'
}
const loaded = (withField: boolean): LoadedGame => ({
  game: {
    homeTeamId: 'home',
    awayTeamId: 'away',
    seasonId: null,
    startAt: '2027-04-10T14:00:00.000Z',
    venue: 'Example Park',
    outsideTournament: null,
    status: 'scheduled',
    ...(withField ? { fieldId: 'fld_one', fieldSize: '50/70' } : {})
  },
  version: 'v',
  withdrawTeamIds: ['home'],
  canPropose: true,
  field: withField ? field : null
})

describe('the game draft’s field', () => {
  it('loads a game’s field and keeps, changes or clears it in a change', () => {
    const mode = { kind: 'edit' as const, gameId: 'gam_one' }
    const withField = loaded(true)
    const draft = loadedGameDraft(withField, choice('home'), choice('away'))
    expect(draft.field).deep.equals(field)
    const kept = gameProposalFields(
      draft,
      mode,
      choice('home'),
      choice('away'),
      withField
    )
    expect(kept.game).include({ fieldId: 'fld_one', fieldSize: '50/70' })
    const cleared = gameProposalFields(
      { ...draft, field: null },
      mode,
      choice('home'),
      choice('away'),
      withField
    )
    expect(cleared.game).include({ fieldId: null, fieldSize: null })
    const without = loaded(false)
    const plain = gameProposalFields(
      loadedGameDraft(without, choice('home'), choice('away')),
      mode,
      choice('home'),
      choice('away'),
      without
    )
    expect(Object.keys(plain.game)).not.includes('fieldId')
    expect(
      loadedGameDraft(without, choice('home'), choice('away')).field
    ).equals(null)
  })

  it('keeps a game’s field when its open side loads as TBD and is sent as null', () => {
    const mode = { kind: 'edit' as const, gameId: 'gam_one' }
    const open: LoadedGame = {
      ...loaded(true),
      game: { ...loaded(true).game, awayTeamId: null }
    }
    const draft = loadedGameDraft(open, choice('home'), TBD)
    expect(draft.away).equals(TBD)
    expect(draft.field).deep.equals(field)
    const sent = gameProposalFields(draft, mode, choice('home'), TBD, open)
    expect(sent.game).include({
      homeTeamId: 'home',
      awayTeamId: null,
      fieldId: 'fld_one',
      fieldSize: '50/70'
    })
  })
})
