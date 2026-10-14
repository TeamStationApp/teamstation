import { expect } from 'chai'
import { describe, it } from 'mocha'

import { asChatConversation, asChatDmPerson } from '../../common/api'
import { teamTint } from '../components/teamTile'
import { lstrings } from '../locales/strings'
import { conversationIdentity, memberIdentity } from './chatIdentityModel'
import { chat, member } from './chatViews.test.helpers'

describe('chat identities', function () {
  it('shares the exact team tile across audiences and preserves the existing team tint and initials', function () {
    const team = chat({
      scope: { type: 'team', id: 'tem_harbor' },
      scopeName: 'Harbor',
      avatarName: 'Harbor',
      avatarUrl: 'https://media.example.test/team.png'
    })
    const expected = {
      label: 'Harbor',
      tiles: [
        {
          key: 'team:tem_harbor',
          name: 'Harbor',
          initials: 'HA',
          tint: teamTint('tem_harbor'),
          uri: 'https://media.example.test/team.png'
        }
      ]
    }
    for (const kind of ['teamStaff', 'teamMembers', 'teamFans'] as const)
      expect(conversationIdentity({ ...team, kind })).deep.equals(expected)
  })

  it('uses a season or league own name and keeps older response fallbacks readable', function () {
    const season = chat({
      kind: 'seasonStaff',
      scope: { type: 'season', id: 'sea_harbor' },
      scopeName: 'Harbor League Autumn',
      avatarName: 'Autumn',
      avatarUrl: null
    })
    expect(conversationIdentity(season).tiles[0]).includes({
      initials: 'A',
      name: 'Autumn',
      uri: null
    })
    expect(
      conversationIdentity(
        chat({
          kind: 'leagueOrg',
          scope: { type: 'league', id: 'lea_harbor' },
          scopeName: 'Harbor League'
        })
      ).tiles[0]
    ).includes({ initials: 'HL', name: 'Harbor League' })
    expect(
      conversationIdentity(chat({ scopeName: null, title: 'Harbor' })).label
    ).equals('Harbor')
    expect(
      conversationIdentity(chat({ scopeName: 'Harbor' })).tiles[0].uri
    ).equals(null)
  })

  it('uses current DM participants in stable ID order, independently of display-name ties and departed profiles', function () {
    const people = [
      asChatDmPerson({
        userId: 9,
        shortName: 'Aaron Judge',
        left: false,
        avatarUrl: 'https://media.example.test/nine.png'
      }),
      asChatDmPerson({ userId: 2, shortName: 'Aaron Judge', left: false }),
      asChatDmPerson({
        userId: 1,
        shortName: 'Mookie Betts',
        left: true,
        avatarUrl: 'https://media.example.test/former.png'
      }),
      asChatDmPerson({ userId: 2, shortName: 'Aaron Judge', left: false })
    ]
    const before = [...people]
    const identity = conversationIdentity(
      chat({ kind: 'dm', scope: null, people })
    )
    expect(identity.tiles.map(tile => tile.key)).deep.equals(['2', '9'])
    expect(identity.tiles.map(tile => tile.uri)).deep.equals([
      null,
      'https://media.example.test/nine.png'
    ])
    expect(identity.tiles[0]).deep.equals(
      memberIdentity(member(2, 'Aaron Judge')).tiles[0]
    )
    expect(people).deep.equals(before)
    expect(
      conversationIdentity(
        chat({
          kind: 'dm',
          scope: null,
          people: people.filter(person => person.left)
        })
      )
    ).deep.equals(memberIdentity(undefined))
    expect(memberIdentity(undefined).label).equals(lstrings.chat_former_member)
    expect(memberIdentity(undefined).tiles[0].uri).equals(null)
  })

  it('keeps a single DM person, legacy images, just-you and missing-scope identities distinct', function () {
    const person = asChatDmPerson({
      userId: 2,
      shortName: 'Mookie Betts',
      left: false
    })
    expect(
      conversationIdentity(chat({ kind: 'dm', scope: null, people: [person] }))
    ).deep.equals(memberIdentity(member(2, 'Mookie Betts')))
    const legacy = chat({
      kind: 'dm',
      scope: null,
      title: 'Mookie Betts',
      avatarUrl: 'https://media.example.test/legacy.png'
    })
    expect(conversationIdentity(legacy).tiles[0].uri).equals(legacy.avatarUrl)
    expect(conversationIdentity({ ...legacy, people: [] }).tiles[0].uri).equals(
      null
    )
    expect(
      conversationIdentity(chat({ scope: null, title: 'Conversation' })).label
    ).equals('Conversation')
    expect(
      memberIdentity(
        member(7, 'Aaron Judge', {
          avatarUrl: 'https://media.example.test/current.png'
        })
      ).tiles[0].uri
    ).equals('https://media.example.test/current.png')
  })

  it('accepts old API payloads and preserves additive authorized avatar fields', function () {
    const older = asChatConversation(chat())
    expect(older.avatarName).equals(null)
    expect(older.avatarUrl).equals(null)
    expect(older.people).deep.equals([])
    const next = asChatConversation({
      ...chat(),
      avatarName: 'Harbor',
      avatarUrl: 'https://media.example.test/harbor.png'
    })
    expect(next.avatarName).equals('Harbor')
    expect(next.avatarUrl).equals('https://media.example.test/harbor.png')
    expect(
      asChatDmPerson({ userId: 2, shortName: 'Aaron Judge', left: false })
        .avatarUrl
    ).equals(null)
  })
})
