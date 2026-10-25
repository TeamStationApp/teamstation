import { expect } from 'chai'
import { describe, it } from 'mocha'

import { userIdOfGumbo } from '../../common/userId'
import type { StoredBlock, StoredMessage } from './conversation'
import { viewMessages } from './conversation'
import { linkPlayers, playerNamesOf } from './playerLinks'

const GWYNN = userIdOfGumbo(107)
const SMITH = userIdOfGumbo(108)
const RIPKEN = userIdOfGumbo(109)

/** A tool result carrying what the API answered; an error past 399. */
const answered = (body: unknown, status = 200): StoredBlock => ({
  type: 'tool_result',
  tool_use_id: 'toolu_1',
  content: `HTTP ${status}\n${JSON.stringify(body)}`,
  ...(status < 400 ? {} : { is_error: true })
})

const message = (
  id: number,
  role: 'user' | 'assistant',
  content: StoredBlock[]
): StoredMessage => ({
  id,
  role,
  content,
  createdAt: new Date('2027-04-03T12:00:00Z')
})

describe("Tess's player links", function () {
  describe('the names her API answers carry', function () {
    it('takes every listed player with a userId and a name, at any depth', function () {
      const names = playerNamesOf([
        message(1, 'user', [
          answered({
            team: { name: 'Demo Hawks' },
            players: [
              { userId: GWYNN, shortName: 'Tony G', jersey: '19' },
              { userId: SMITH, name: 'Ozzie S', displayName: 'Ozzie Smith' }
            ]
          })
        ])
      ])
      expect(Object.fromEntries(names)).deep.equals({
        'Tony G': GWYNN,
        'Ozzie S': SMITH,
        'Ozzie Smith': SMITH
      })
    })

    it('takes only names of two or more words, so a one-word name never links prose', function () {
      // A player stored with no last name is just "Will": linking it would
      // turn "Will you confirm the lineup?" into a link to that player.
      const names = playerNamesOf([
        message(1, 'user', [
          answered({
            players: [
              { userId: GWYNN, shortName: 'Will', displayName: 'Will Clark' },
              { userId: SMITH, shortName: 'Max' }
            ]
          })
        ])
      ])
      expect(Object.fromEntries(names)).deep.equals({ 'Will Clark': GWYNN })
      expect(
        linkPlayers('Will you confirm the lineup? Max is on.', names)
      ).equals('Will you confirm the lineup? Max is on.')
    })

    it('leaves out a name two people share, a failed or cut answer, and anything that is not one', function () {
      const names = playerNamesOf([
        message(1, 'user', [
          answered({
            players: [
              { userId: GWYNN, shortName: 'Cal R' },
              { userId: RIPKEN, shortName: 'Cal R' },
              { userId: RIPKEN, shortName: 'Cal Ripken' },
              { userId: RIPKEN, name: 'Cal Ripken' },
              { userId: 'not-a-user', shortName: 'Nobody' },
              { userId: SMITH, shortName: ' ' },
              { userId: SMITH, shortName: 7 }
            ]
          })
        ]),
        message(2, 'user', [
          answered({ players: [{ userId: SMITH, shortName: 'Ozzie S' }] }, 404),
          {
            type: 'tool_result',
            tool_use_id: 'toolu_2',
            content: `HTTP 200\n{"players":[{"userId":"${SMITH}","shortName":"Ozzie S"`
          },
          {
            type: 'tool_result',
            tool_use_id: 'toolu_3',
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  batting: [{ userId: SMITH, name: 'Ozzie Smith' }]
                })
              }
            ]
          },
          {
            type: 'text',
            text: JSON.stringify({ players: [{ userId: GWYNN, name: 'Tony' }] })
          }
        ])
      ])
      expect(Object.fromEntries(names)).deep.equals({
        'Cal Ripken': RIPKEN,
        'Ozzie Smith': SMITH
      })
    })

    it('takes only players: never a roster’s admins, staff, family, spectators or followers', function () {
      const entry = (
        userId: string,
        shortName: string,
        section: string,
        isPlayer = section === 'player'
      ): Record<string, unknown> => ({
        userId,
        shortName,
        bats: null,
        throws: null,
        isPlayer,
        role: 'member',
        section
      })
      const coach = userIdOfGumbo(110)
      const parent = userIdOfGumbo(111)
      const fan = userIdOfGumbo(112)
      const follower = userIdOfGumbo(113)
      const owner = userIdOfGumbo(114)
      const names = playerNamesOf([
        message(1, 'user', [
          // `GET /teams/:teamId/roster`: a coach and a player sharing
          // nothing, and every other section.
          answered([
            entry(owner, 'Tommy L', 'admin'),
            entry(coach, 'Coach', 'staff'),
            entry(GWYNN, 'Tony G', 'player'),
            entry(parent, 'Mom', 'family'),
            entry(fan, 'Sparky A', 'spectator'),
            entry(follower, 'Joe T', 'follower'),
            // A coach who also plays is listed as staff.
            entry(RIPKEN, 'Cal R', 'staff', true)
          ])
        ])
      ])
      expect(Object.fromEntries(names)).deep.equals({ 'Tony G': GWYNN })
      expect(
        linkPlayers(
          'Coach and Mom watched Tony G; Tommy L and Cal R ran it.',
          names
        )
      ).equals(
        `Coach and Mom watched [Tony G](/players/${GWYNN}); Tommy L and Cal R ran it.`
      )

      // A stat line, a player's own read and an `isPlayer` flag are
      // players; the playing coach links by his stat line. A coach whose
      // name a player shares links nobody, and an account read is nobody's.
      const more = playerNamesOf([
        message(1, 'user', [
          answered([
            entry(coach, 'Coach', 'staff'),
            entry(RIPKEN, 'Cal R', 'staff', true),
            entry(fan, 'Ozzie S', 'staff')
          ]),
          answered({
            batting: [{ userId: RIPKEN, shortName: 'Cal R', pa: 4 }]
          }),
          answered({ userId: SMITH, name: 'Ozzie Smith', bats: 'right' }),
          answered({
            people: [{ userId: SMITH, shortName: 'Ozzie S', isPlayer: true }]
          }),
          answered({ userId: coach, displayName: 'Sparky Anderson' }),
          answered({
            people: [{ userId: parent, shortName: 'Joe T', isPlayer: false }]
          })
        ])
      ])
      expect(Object.fromEntries(more)).deep.equals({
        'Cal R': RIPKEN,
        'Ozzie Smith': SMITH
      })
    })
  })

  describe('linking her text', function () {
    const names = new Map([
      ['Tony G', GWYNN],
      ['Tony', SMITH],
      ['José A', RIPKEN]
    ])

    it('links whole words only, the longest name first', function () {
      expect(
        linkPlayers(
          'Tony G hit; Tony ran. Tony Gwynn, Tonya and xTony did not.',
          names
        )
      ).equals(
        `[Tony G](/players/${GWYNN}) hit; [Tony](/players/${SMITH}) ran. [Tony](/players/${SMITH}) Gwynn, Tonya and xTony did not.`
      )
      expect(linkPlayers('**Tony G**’s double, José A.', names)).equals(
        `**[Tony G](/players/${GWYNN})**’s double, [José A](/players/${RIPKEN}).`
      )
      // Underscore emphasis, single and double, links inside it.
      expect(linkPlayers('_Tony G_ and __José A__ scored.', names)).equals(
        `_[Tony G](/players/${GWYNN})_ and __[José A](/players/${RIPKEN})__ scored.`
      )
    })

    it('leaves code, links, HTML and addresses as they are', function () {
      const untouched = [
        'A `Tony G` span',
        '```\nTony G\n```',
        '~~~js\nTony G',
        'Before.\n\n    Tony G in indented code',
        '[Tony G](/players/other) and ![Tony G](/x.png) and [Tony G][ref]',
        '[ref]: https://example.test Tony G',
        '<table><tr><td>Tony G</td></tr></table>',
        '<svg><text>Tony G</text></svg>',
        '<!-- Tony G -->',
        'https://example.test/Tony'
      ]
      for (const text of untouched)
        expect(linkPlayers(text, names), text).equals(text)
      expect(linkPlayers('<b>Tony G</b>', names)).equals(
        `<b>[Tony G](/players/${GWYNN})</b>`
      )
      // A nested list's item is not indented code.
      expect(linkPlayers('- Hitters:\n\n    - Tony G', names)).equals(
        `- Hitters:\n\n    - [Tony G](/players/${GWYNN})`
      )
      expect(linkPlayers('```\nTony G\n```\nThen Tony G.', names)).equals(
        `\`\`\`\nTony G\n\`\`\`\nThen [Tony G](/players/${GWYNN}).`
      )
    })

    it('escapes brackets in a name, and changes nothing without names', function () {
      expect(
        linkPlayers('Ask [Jr] Tony', new Map([['[Jr] Tony', GWYNN]]))
      ).equals('Ask [Jr] Tony')
      expect(
        linkPlayers('Ask Jr] Tony', new Map([['Jr] Tony', GWYNN]]))
      ).equals(`Ask [Jr\\] Tony](/players/${GWYNN})`)
      expect(linkPlayers('Tony G', new Map())).equals('Tony G')
    })
  })

  describe('the conversation as the app shows it', function () {
    const stored = (): StoredMessage[] => [
      message(1, 'user', [{ type: 'text', text: 'Who plays short?' }]),
      message(2, 'assistant', [
        { type: 'text', text: 'Let me check.' },
        {
          type: 'tool_use',
          id: 'toolu_1',
          name: 'api_get',
          input: { path: '/teams/tem_1/roster' }
        }
      ]),
      message(3, 'user', [
        answered([
          {
            userId: GWYNN,
            shortName: 'Tony G',
            positions: ['SS'],
            isPlayer: true,
            section: 'player'
          }
        ])
      ]),
      message(4, 'assistant', [
        { type: 'text', text: 'Tony G plays short; [Tony G](/players/x) too.' }
      ])
    ]

    it("links her reply's names and leaves what is stored as it was", function () {
      const messages = stored()
      const before = JSON.stringify(messages)
      const view = viewMessages(messages, new Map(), new Map())
      expect(view.map(each => each.text)).deep.equals([
        'Who plays short?',
        `Let me check.\n\n[Tony G](/players/${GWYNN}) plays short; [Tony G](/players/x) too.`
      ])
      expect(JSON.stringify(messages)).equals(before)
    })

    it('links by names read before the part shown, and never the person’s words', function () {
      const messages = [
        ...stored(),
        message(5, 'user', [{ type: 'text', text: 'And Tony G?' }]),
        message(6, 'assistant', [{ type: 'text', text: 'Tony G bats left.' }])
      ]
      const names = playerNamesOf(messages)
      const view = viewMessages(
        messages.filter(each => each.id >= 5),
        new Map(),
        new Map(),
        names
      )
      expect(view.map(each => each.text)).deep.equals([
        'And Tony G?',
        `[Tony G](/players/${GWYNN}) bats left.`
      ])
    })
  })
})
