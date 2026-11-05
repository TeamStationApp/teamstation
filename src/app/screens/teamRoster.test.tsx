import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import {
  asRosterEntry,
  type GamesPageQuery,
  type RosterEntry,
  type TeamStationClient
} from '../../common/api'
import { userIdOfGumbo } from '../../common/userId'
import { pageOfGames } from '../../test/pageOf'
import { ThemeProvider } from '../theme/ThemeContext'
import { LevelPeopleTab } from './LevelPeopleTab'
import { inheritedPill, TeamScreen } from './TeamScreen'

/**
 * The roster in sections: Admins, Staff, Players, Family members, Spectators
 * and Followers, in that order and only those with somebody in them. Staff
 * read as their roles, and anybody given their place above the team carries
 * a pill naming the level and role: a member of the season or league is a
 * `Season spectator` or a `League spectator`.
 */
let root: Root | undefined

const delay = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

const text = (): string => document.body.textContent ?? ''

function entry(
  userId: number,
  shortName: string,
  fields: Partial<RosterEntry>
): RosterEntry {
  return asRosterEntry({
    userId: userIdOfGumbo(userId),
    gumboId: userId,
    shortName,
    jersey: null,
    positions: [],
    isPlayer: false,
    role: 'member',
    section: 'spectator',
    staffRoles: [],
    inheritedFrom: null,
    ...fields
  })
}

/** In the server's order: by section, the team's own first, then by name. */
const everybody: RosterEntry[] = [
  entry(101, 'Babe R', {
    section: 'admin',
    inheritedFrom: { level: 'league', role: 'admin' }
  }),
  entry(104, 'Ichiro', { section: 'staff', staffRoles: ['coach'] }),
  entry(209, 'Nick P', { section: 'staff', staffRoles: ['scorekeeper'] }),
  entry(210, 'Owen M', { section: 'staff', staffRoles: ['assistant'] }),
  entry(103, 'Mike T', {
    section: 'staff',
    staffRoles: ['coach'],
    inheritedFrom: { level: 'season', role: 'coach' }
  }),
  entry(201, 'Alfonso S', {
    section: 'player',
    isPlayer: true,
    jersey: '7',
    positions: ['SS', '2B']
  }),
  entry(106, 'Tim R', { section: 'family', guardianOf: ['Alfonso S'] }),
  entry(208, 'Hank M', { section: 'spectator' }),
  entry(250, 'Lou L', {
    section: 'spectator',
    inheritedFrom: { level: 'league', role: 'member' }
  }),
  entry(251, 'Sid F', {
    section: 'spectator',
    inheritedFrom: { level: 'season', role: 'member' }
  }),
  entry(207, 'Grant H', { section: 'follower' })
]

async function render(
  roster: RosterEntry[],
  manager?: { people: string[] }
): Promise<string[]> {
  const opened: string[] = []
  const client = {
    teamGamesPage: async (_id: string, query?: GamesPageQuery) =>
      pageOfGames([], query),
    roster: async () => roster,
    teamStats: async () => [],
    teamPitchingStats: async () => [],
    standings: async () => []
  } as unknown as TeamStationClient
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <ThemeProvider>
        <TeamScreen
          client={client}
          team={{
            id: 'tem_hawks',
            name: 'Demo Hawks',
            shortName: null,
            logoPath: null,
            logoUrl: null,
            record: null,
            seasonCategory: 'unscheduled',
            canViewPrivate: true,
            kind: 'full'
          }}
          initialTab="roster"
          onOpenGame={() => undefined}
          onOpenPlayer={userId => {
            opened.push(userId)
          }}
          managesPeople={manager != null}
          onOpenPerson={(userId, _name, teamId) => {
            expect(teamId).equals('tem_hawks')
            manager?.people.push(userId)
          }}
        />
      </ThemeProvider>
    )
    await delay(10)
  })
  return opened
}

/** Where each heading starts in the page's text, -1 when it is not there. */
function headings(): number[] {
  const page = text()
  return [
    'ADMINS',
    'STAFF',
    'PLAYERS',
    'FAMILY MEMBERS',
    'SPECTATORS',
    'FOLLOWERS'
  ].map(heading => page.indexOf(heading))
}

/**
 * The roster row titled `name`: the row around the name's own text, which is
 * a button only when it opens something.
 */
function rowNode(name: string): HTMLElement {
  const title = [...document.querySelectorAll<HTMLElement>('div, span')].find(
    node => node.children.length === 0 && node.textContent === name
  )
  expect(title, name).not.equals(undefined)
  return title!.parentElement!.parentElement!
}

/** The text of the roster row titled `name`. */
function row(name: string): string {
  return rowNode(name).textContent ?? ''
}

describe('a team’s roster in sections', function () {
  afterEach(async function () {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
  })

  it('draws Admins, Staff, Players, Family members, Spectators and Followers in order', async function () {
    await render(everybody)
    const at = headings()
    for (const index of at.keys()) expect(at[index], String(index)).gte(0)
    expect([...at].sort((a, b) => a - b)).deep.equals(at)
    // Each heading counts its people.
    expect(text()).includes('STAFF4')
    expect(text()).includes('SPECTATORS3')
    expect(text()).includes('FOLLOWERS1')
    // Within a section, in the order the server sent.
    expect(text().indexOf('Owen M')).lessThan(text().indexOf('Mike T'))
    expect(text().indexOf('Hank M')).lessThan(text().indexOf('Lou L'))
    expect(text().indexOf('Lou L')).lessThan(text().indexOf('Sid F'))
    expect(text().indexOf('FOLLOWERS')).lessThan(text().indexOf('Grant H'))
    // The old headings are gone.
    expect(text()).not.includes('COACHES')
    expect(text()).not.includes('OTHER MEMBERS')
  })

  it('leaves out a section with nobody in it', async function () {
    await render(
      everybody.filter(
        person => person.section !== 'family' && person.section !== 'admin'
      )
    )
    const [admins, staff, players, family, spectators, followers] = headings()
    expect(admins).equals(-1)
    expect(family).equals(-1)
    expect(staff).lessThan(players)
    expect(players).lessThan(spectators)
    expect(spectators).lessThan(followers)
    await act(async () => {
      root?.unmount()
    })
    await render(everybody.filter(person => person.section !== 'follower'))
    expect(headings()[5]).equals(-1)
  })

  it('reads staff by their roles and players by their positions', async function () {
    const opened = await render(everybody)
    expect(row('Owen M')).includes('Assistant')
    expect(row('Nick P')).includes('Scorekeeper')
    expect(row('Ichiro')).includes('Coach')
    expect(row('Alfonso S')).includes('SS · 2B')
    expect(row('Alfonso S')).includes('#7')
    // A plain admin has nothing under the name: initials, name, and the pill
    // if any. A family member has the players here they guard.
    expect(row('Babe R')).equals('BRBabe RLeague admin')
    expect(row('Tim R')).equals('TRTim RParent/guardian of Alfonso S')
    // A player's row opens the player.
    await act(async () => {
      rowNode('Alfonso S').click()
      await delay(10)
    })
    expect(opened).deep.equals([userIdOfGumbo(201)])
  })

  it('opens only a player’s row, which alone has a page', async function () {
    const opened = await render(everybody)
    // Pressable, with a chevron: the players, and only them.
    const pressable = everybody.filter(
      person => rowNode(person.shortName).getAttribute('role') === 'button'
    )
    expect(pressable.map(person => person.shortName)).deep.equals(['Alfonso S'])
    expect(row('Alfonso S')).includes('chevron_right')
    expect(text().split('chevron_right').length - 1).equals(1)
    // Family, inherited staff, the team's own staff who do not play,
    // spectators and followers open nothing when tapped.
    for (const name of [
      'Tim R',
      'Mike T',
      'Babe R',
      'Ichiro',
      'Hank M',
      'Lou L',
      'Grant H'
    ]) {
      await act(async () => {
        rowNode(name).click()
        await delay(10)
      })
    }
    expect(opened).deep.equals([])
  })

  it('pills somebody given their place above the team, and nobody else', async function () {
    await render(everybody)
    expect(row('Mike T')).includes('Season coach')
    expect(row('Babe R')).includes('League admin')
    expect(row('Ichiro')).not.includes('Season')
    expect(text().split('Season coach').length - 1).equals(1)
    expect(text().split('League admin').length - 1).equals(1)
    // A member of the season or the league; the team's own and a follower
    // carry no pill.
    expect(row('Sid F')).equals('SFSid FSeason spectator')
    expect(row('Lou L')).equals('LLLou LLeague spectator')
    expect(row('Hank M')).equals('HMHank M')
    expect(row('Grant H')).equals('GHGrant H')
  })

  it('names the level and the role in the pill', function () {
    const pill = (inheritedFrom: RosterEntry['inheritedFrom']): unknown =>
      inheritedPill(entry(1, 'A B', { section: 'staff', inheritedFrom }))
    expect(pill(null)).equals(undefined)
    expect(pill({ level: 'season', role: 'assistant' })).equals(
      'Season assistant'
    )
    expect(pill({ level: 'league', role: 'scorekeeper' })).equals(
      'League scorekeeper'
    )
    expect(pill({ level: 'league', role: 'songkeeper' })).equals(
      'League songkeeper'
    )
    expect(pill({ level: 'season', role: 'videographer' })).equals(
      'Season videographer'
    )
    expect(pill({ level: 'season', role: 'member' })).equals('Season spectator')
    expect(pill({ level: 'league', role: 'member' })).equals('League spectator')
  })

  it('opens every row for the team’s administrators, coaches and assistants: a player’s page, anybody else’s profile', async function () {
    const people: string[] = []
    const opened = await render(everybody, { people })
    const pressable = everybody.filter(
      person => rowNode(person.shortName).getAttribute('role') === 'button'
    )
    expect(pressable).length(everybody.length)
    for (const name of ['Alfonso S', 'Tim R', 'Babe R', 'Lou L', 'Grant H'])
      await act(async () => {
        rowNode(name).click()
        await delay(10)
      })
    expect(opened).deep.equals([userIdOfGumbo(201)])
    expect(people).deep.equals([
      userIdOfGumbo(106),
      userIdOfGumbo(101),
      userIdOfGumbo(250),
      userIdOfGumbo(207)
    ])
  })
})

describe('a season’s and a league’s People tab', function () {
  afterEach(async function () {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
  })

  async function tab(
    kind: 'season' | 'league',
    manages: boolean,
    answer?: RosterEntry[]
  ): Promise<{ players: unknown[]; people: string[] }> {
    const players: unknown[] = []
    const people: string[] = []
    const client = {
      levelPeople: async (asked: string, id: string) => {
        if (answer == null) throw new Error('People could not load here')
        expect([asked, id]).deep.equals([kind, 'lvl_one'])
        return { people: answer, manages, admin: false }
      }
    } as unknown as TeamStationClient
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <LevelPeopleTab
            client={client}
            kind={kind}
            id="lvl_one"
            onOpenPlayer={(userId, name, from) => {
              players.push([userId, name, from])
            }}
            onOpenPerson={userId => {
              people.push(userId)
            }}
          />
        </ThemeProvider>
      )
      await delay(10)
    })
    return { players, people }
  }

  const levelPeople = [
    entry(101, 'Babe R', { section: 'admin' }),
    entry(201, 'Alfonso S', {
      section: 'player',
      isPlayer: true,
      teamNames: ['Demo Hawks', 'Demo Owls']
    }),
    entry(106, 'Tim R', { section: 'family' }),
    entry(250, 'Lou L', {
      section: 'spectator',
      inheritedFrom: { level: 'league', role: 'member' }
    })
  ]

  it('lists the season’s people in sections, a player with their teams, and opens them for a manager', async function () {
    const { players, people } = await tab('season', true, levelPeople)
    expect(headings().filter(at => at >= 0)).length(4)
    expect(row('Alfonso S')).includes('Demo Hawks · Demo Owls')
    expect(row('Lou L')).includes('League spectator')
    for (const name of ['Alfonso S', 'Tim R', 'Babe R'])
      await act(async () => {
        rowNode(name).click()
        await delay(10)
      })
    expect(players).deep.equals([
      [userIdOfGumbo(201), 'Alfonso S', { seasonId: 'lvl_one' }]
    ])
    expect(people).deep.equals([userIdOfGumbo(106), userIdOfGumbo(101)])
  })

  it('opens only players for anybody else, and says so when nobody or nothing is there', async function () {
    const { players, people } = await tab('league', false, levelPeople)
    expect(rowNode('Tim R').getAttribute('role')).not.equals('button')
    await act(async () => {
      rowNode('Alfonso S').click()
      await delay(10)
    })
    expect(players).deep.equals([[userIdOfGumbo(201), 'Alfonso S', undefined]])
    expect(people).deep.equals([])
    await act(async () => {
      root?.unmount()
    })
    await tab('league', false, [])
    expect(text()).includes('Nobody here yet.')
    await act(async () => {
      root?.unmount()
    })
    await tab('season', false)
    expect(text()).includes('People could not load here')
  })
})
