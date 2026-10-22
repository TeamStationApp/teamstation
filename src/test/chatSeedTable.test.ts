import { expect } from 'chai'
import { describe, it } from 'mocha'

import { userIdOfGumbo, userIdOfValue } from '../common/userId'
import { type ChatSeed, describeSeed } from '../server/dev/chatSeed'
import { readSeedTable } from './chatSeedTable'

describe('the chat seed table, read back by the end-to-end runs', function () {
  const coach = userIdOfValue((1n << 127n) + 5n)
  const parent = userIdOfGumbo(123456)
  const seed: ChatSeed = {
    leagueId: 'lea_synthetic',
    seasonId: 'sea_synthetic',
    teams: { hawks: 'tem_hawks', eagles: 'tem_eagles', owls: 'tem_owls' },
    games: {
      hawksOwlsFinal: 'gam_final',
      hawksOwlsNext: 'gam_next',
      eaglesHawksNext: 'gam_eagles'
    },
    videoId: 'vid_synthetic',
    people: {
      Hc: {
        key: 'Hc',
        userId: coach,
        name: 'Hank Coach',
        email: 'hc@chat.example.com',
        password: 'same for all'
      },
      B: {
        key: 'B',
        userId: parent,
        name: 'Blair Brooks',
        email: 'b@chat.example.com',
        password: 'x7-Synthetic'
      },
      Q: {
        key: 'Q',
        userId: userIdOfGumbo(7),
        name: 'Quilvio Veras',
        email: null,
        password: null
      }
    }
  }

  it('gives each person who can sign in their canonical id, name and password', function () {
    expect(readSeedTable(describeSeed(seed))).deep.equals({
      Hc: {
        userId: coach,
        name: 'Hank Coach',
        email: 'hc@chat.example.com',
        password: 'same for all'
      },
      B: {
        userId: parent,
        name: 'Blair Brooks',
        email: 'b@chat.example.com',
        password: 'x7-Synthetic'
      }
    })
  })

  it('reads no person from a table of numeric ids, and refuses a malformed one', function () {
    expect(
      readSeedTable(
        'Hc  Hank Coach       123456            hc@chat.example.com      pw'
      )
    ).deep.equals({})
    expect(() =>
      readSeedTable(
        'Hc  Hank Coach       usr_0             hc@chat.example.com      pw'
      )
    ).throws('Expected a canonical user id')
  })
})
