import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import {
  asRosterEntry,
  type GamesPageQuery,
  type RosterEntry,
  TeamStationClient
} from '../../common/api'
import { HttpError } from '../../common/errors'
import {
  asGroupDetail,
  asPublicGroup,
  type GroupDetail
} from '../../common/publicGroups'
import { userIdOfGumbo } from '../../common/userId'
import { pageOfGames } from '../../test/pageOf'
import { AddPeopleScreen } from '../screens/AddPeopleScreen'
import { LevelPeopleTab } from '../screens/LevelPeopleTab'
import { TeamPage } from '../screens/TeamPage'
import { TeamScreen } from '../screens/TeamScreen'
import { rosterKey } from '../sync/documentKeys'
import { ThemeProvider } from '../theme/ThemeContext'
import { type PeopleAdd, PeopleList } from './PeopleList'

/**
 * The adds on a people list: Add Staff and Add Spectator for whoever
 * administers the group, Add Player for whoever manages a team's roster,
 * each left of its section's count, or under an empty section as a blue
 * button. Admins, Staff and Spectators (and a team's Players) keep their
 * header and count when empty.
 */
let root: Root | undefined

const delay = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}
const text = (): string => document.body.textContent ?? ''

async function mount(element: React.ReactElement): Promise<void> {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<ThemeProvider>{element}</ThemeProvider>)
    await delay(20)
  })
}

function button(label: string): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('[role="button"]')].find(
    node => (node.getAttribute('aria-label') ?? node.textContent) === label
  )
}

async function press(label: string): Promise<void> {
  const node = button(label)
  expect(node, label).not.equals(undefined)
  await act(async () => {
    node!.click()
    await delay(10)
  })
}

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

const admin = entry(101, 'Babe R', { section: 'admin' })
const coach = entry(106, 'Tim R', {
  section: 'staff',
  staffRoles: ['coach']
})
const spectator = entry(102, 'Aaron J', { section: 'spectator' })
const player = entry(400, 'Mookie B', { section: 'player', isPlayer: true })

/** The header of a section: the row holding its title. */
function header(title: string): HTMLElement {
  const leaf = [...document.querySelectorAll<HTMLElement>('div')].find(
    node => node.children.length === 0 && node.textContent === title
  )
  expect(leaf, title).not.equals(undefined)
  return leaf!.parentElement!
}

/** The header's pills and count, in the order they are drawn. */
function headerParts(title: string): string[] {
  const right = header(title).children[1] as HTMLElement
  return [...right.children].map(node => node.textContent ?? '')
}

describe('the adds on people lists', function () {
  afterEach(async () => {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    document.body.replaceChildren()
  })

  describe('a people list’s adds', function () {
    it('puts each add left of its section’s count, Admins’ included', async function () {
      const pressed: string[] = []
      const add = (section: string): PeopleAdd => ({
        label: `Add ${section}`,
        accessibilityLabel: `Add ${section} to Demo League A`,
        onPress: () => {
          pressed.push(section)
        }
      })
      await mount(
        <PeopleList
          people={[admin, coach, spectator]}
          kept={['admin', 'staff', 'spectator']}
          adds={{
            admin: add('Admin'),
            staff: add('Staff'),
            spectator: add('Spectator')
          }}
        />
      )
      expect(headerParts('ADMINS')).deep.equals(['Add Admin', '1'])
      expect(headerParts('STAFF')).deep.equals(['Add Staff', '1'])
      expect(headerParts('SPECTATORS')).deep.equals(['Add Spectator', '1'])
      expect(
        document.querySelector('[data-testid="people-add-staff"]')
      ).not.equals(null)
      // A count's pills are their own, apart from a header's end actions.
      expect(
        document.querySelectorAll('[data-testid="settings-pill-note-action"]')
      ).length(3)
      expect(
        document.querySelector('[data-testid="settings-pill-header-action"]')
      ).equals(null)
      await press('Add Admin to Demo League A')
      await press('Add Staff to Demo League A')
      await press('Add Spectator to Demo League A')
      expect(pressed).deep.equals(['Admin', 'Staff', 'Spectator'])
    })

    it('keeps an empty section’s header and 0, with a blue add below it and no card', async function () {
      let pressed = 0
      await mount(
        <PeopleList
          people={[admin]}
          kept={['admin', 'staff', 'spectator']}
          adds={{
            staff: {
              label: 'Add Staff',
              accessibilityLabel: 'Add Staff to Demo Playoffs',
              onPress: () => {
                pressed += 1
              }
            }
          }}
        />
      )
      expect(text()).includes('STAFF0Add StaffSPECTATORS0')
      // The count alone in the header; the add is under it.
      expect(headerParts('STAFF')).deep.equals(['0'])
      const pill = document.querySelector<HTMLElement>(
        '[data-testid="people-add-staff"]'
      )
      expect(pill?.textContent).equals('Add Staff')
      await press('Add Staff to Demo Playoffs')
      expect(pressed).equals(1)
    })

    it('leaves out an empty section nobody keeps', async function () {
      await mount(<PeopleList people={[admin]} />)
      expect(text()).not.includes('STAFF')
      expect(text()).not.includes('SPECTATORS')
    })
  })

  describe('a season’s and a league’s People tab', function () {
    const tab = async (
      answer: { people: RosterEntry[]; admin: boolean },
      onAddPeople?: (role?: 'admin') => void
    ): Promise<void> => {
      const client = {
        levelPeople: async () => ({ ...answer, manages: answer.admin })
      } as unknown as TeamStationClient
      await mount(
        <LevelPeopleTab
          client={client}
          kind="season"
          id="sea_regular"
          name="Demo Regular"
          onAddPeople={onAddPeople}
        />
      )
    }

    it('offers Add Admin, Add Staff and Add Spectator to an administrator, each opening Add People, Admin’s with Admin checked', async function () {
      const opened: Array<string | undefined> = []
      await tab({ people: [admin, coach], admin: true }, role => {
        opened.push(role)
      })
      expect(text()).not.includes('PLAYERS')
      expect(text()).not.includes('Nobody here yet.')
      expect(headerParts('ADMINS')).deep.equals(['Add Admin', '1'])
      expect(headerParts('STAFF')).deep.equals(['Add Staff', '1'])
      expect(headerParts('SPECTATORS')).deep.equals(['0'])
      await press('Add Admin to Demo Regular')
      await press('Add Staff to Demo Regular')
      await press('Add Spectator to Demo Regular')
      expect(opened).deep.equals(['admin', undefined, undefined])
    })

    it('offers no add to anybody else, or with nowhere to add', async function () {
      await tab({ people: [admin], admin: false }, () => undefined)
      expect(text()).includes('Babe RSTAFF0SPECTATORS0')
      expect(button('Add Staff to Demo Regular')).equals(undefined)
      await act(async () => {
        root?.unmount()
      })
      await tab({ people: [admin], admin: true })
      expect(button('Add Staff to Demo Regular')).equals(undefined)
    })
  })

  describe('a team’s Team tab', function () {
    const hawks = {
      id: 'tem_hawks',
      name: 'Demo Hawks',
      shortName: null,
      logoPath: null,
      logoUrl: null,
      record: null,
      seasonCategory: 'unscheduled' as const,
      canViewPrivate: true,
      kind: 'full' as const
    }
    const client = (
      roster: RosterEntry[] | (() => Promise<RosterEntry[]>),
      /** The roster the phone stored, read before the network answers. */
      stored?: RosterEntry[]
    ): TeamStationClient =>
      ({
        teamGamesPage: async (_id: string, query?: GamesPageQuery) =>
          pageOfGames([], query),
        cached: async (key: string) =>
          stored != null && key === rosterKey(hawks.id) ? stored : undefined,
        // The stored schedule the tab shows with it, the phone's own copy.
        scheduleGames: async () => {
          if (stored == null) throw new Error('Nothing stored')
          return { items: [], nextCursor: null, counts: { total: 0 } }
        },
        roster: typeof roster === 'function' ? roster : async () => roster,
        teamStats: async () => [],
        teamPitchingStats: async () => [],
        standings: async () => []
      }) as unknown as TeamStationClient

    it('keeps Players, and Add Player asks whether to add an existing player or create one', async function () {
      const chosen: string[] = []
      await mount(
        <TeamScreen
          client={client([admin, player])}
          team={hawks}
          initialTab="team"
          onOpenGame={() => undefined}
          onAddPeople={() => {
            chosen.push('people')
          }}
          onAddPlayer={{
            existing: () => {
              chosen.push('existing')
            },
            create: () => {
              chosen.push('create')
            }
          }}
        />
      )
      expect(headerParts('PLAYERS')).deep.equals(['Add Player', '1'])
      expect(headerParts('STAFF')).deep.equals(['0'])
      expect(text()).includes('Add Staff')
      await press('Add Player to Demo Hawks')
      expect(text()).includes('Add existing player')
      expect(text()).includes('Search players already on TeamStation')
      await press('Cancel')
      expect(text()).not.includes('Add existing player')
      expect(chosen).deep.equals([])
      await press('Add Player to Demo Hawks')
      await press('Create new player')
      await press('Add Player to Demo Hawks')
      await press('Add existing player')
      await press('Add Staff to Demo Hawks')
      expect(chosen).deep.equals(['create', 'existing', 'people'])
    })

    it('keeps no empty section and offers no add before the roster is read, or when it is refused', async function () {
      const add = { existing: () => undefined, create: () => undefined }
      const pending = client(
        async () => await new Promise<RosterEntry[]>(() => undefined)
      )
      await mount(
        <TeamScreen
          client={pending}
          team={hawks}
          initialTab="team"
          onOpenGame={() => undefined}
          onAddPeople={() => undefined}
          onAddPlayer={add}
        />
      )
      expect(text()).not.includes('ADMINS')
      expect(button('Add Staff to Demo Hawks')).equals(undefined)
      await act(async () => {
        root?.unmount()
      })
      const refused = client(async () => {
        throw new HttpError('forbidden', 'Members only')
      })
      await mount(
        <TeamScreen
          client={refused}
          team={hawks}
          initialTab="team"
          onOpenGame={() => undefined}
          onAddPeople={() => undefined}
          onAddPlayer={add}
        />
      )
      expect(text()).not.includes('PLAYERS0')
      expect(button('Add Player to Demo Hawks')).equals(undefined)
    })

    it('keeps the sections and offers the adds over the roster the phone stored, before it is read again', async function () {
      const stored = client(
        async () => await new Promise<RosterEntry[]>(() => undefined),
        [admin, player]
      )
      // No signal: the reads never answer.
      stored.teamGamesPage = async () => await new Promise(() => undefined)
      await mount(
        <TeamScreen
          client={stored}
          team={hawks}
          initialTab="team"
          onOpenGame={() => undefined}
          onAddPlayer={{ existing: () => undefined, create: () => undefined }}
        />
      )
      expect(headerParts('PLAYERS')).deep.equals(['Add Player', '1'])
      expect(headerParts('STAFF')).deep.equals(['0'])
    })

    it('draws Add Player under an empty Players section', async function () {
      await mount(
        <TeamScreen
          client={client([admin])}
          team={hawks}
          initialTab="team"
          onOpenGame={() => undefined}
          onAddPlayer={{ existing: () => undefined, create: () => undefined }}
        />
      )
      expect(headerParts('PLAYERS')).deep.equals(['0'])
      expect(
        document.querySelector('[data-testid="people-add-player"]')?.textContent
      ).equals('Add Player')
      expect(button('Add Staff to Demo Hawks')).equals(undefined)
    })
  })

  describe('Add People’s roles', function () {
    const open = async (
      kind: 'team' | 'season',
      admin?: boolean
    ): Promise<void> => {
      await mount(
        <AddPeopleScreen
          client={{} as unknown as TeamStationClient}
          group={{ kind, id: 'grp_one' }}
          scopeName="Demo Hawks"
          admin={admin}
          onDone={() => undefined}
          onCancel={() => undefined}
        />
      )
    }
    const switchOf = (label: string): HTMLElement | null =>
      document.querySelector<HTMLElement>(
        `[role="switch"][aria-label="${label}"]`
      )
    const on = (label: string): boolean => {
      const node = switchOf(label)
      expect(node, label).not.equals(null)
      return (node as HTMLInputElement).checked
    }

    it('ends with Spectator, on and locked, and says nothing of what they are added as', async function () {
      await open('team')
      expect(on('Spectator')).equals(true)
      expect((switchOf('Spectator') as HTMLInputElement).disabled).equals(true)
      expect(text()).includes(
        'SpectatorView all team members, see stats, and watch videos.'
      )
      expect(text()).not.includes('Adds them as')
      expect(on('Coach')).equals(false)
      await act(async () => {
        root?.unmount()
      })
      await open('season')
      expect(text()).includes(
        'SpectatorView all members, see stats, and watch videos.'
      )
    })

    it('opens with Admin checked for Add Admin, every staff role with it', async function () {
      await open('team', true)
      const admin = [
        ...document.querySelectorAll<HTMLInputElement>('[role="switch"]')
      ][0]
      expect(admin.checked).equals(true)
      expect(on('Coach')).equals(true)
      expect(on('Spectator')).equals(true)
    })
  })

  describe('a team page’s adds', function () {
    const detail = (patch: Partial<GroupDetail>): GroupDetail =>
      asGroupDetail({
        group: {
          kind: 'team',
          id: 'tem_hawks',
          name: 'Demo Hawks',
          imageUrl: null,
          locality: null
        },
        parents: [],
        children: [],
        participatingSeasons: [],
        competingTeams: [],
        games: [],
        staff: [],
        canViewPrivate: true,
        nonMemberView: false,
        canManage: false,
        ...patch
      })
    const page = async (found: GroupDetail): Promise<string[]> => {
      const opened: string[] = []
      const api = new TeamStationClient({ baseUrl: '/api/v1' })
      api.group = async () => found
      api.teamGamesPage = async (_id, query) => pageOfGames([], query)
      api.roster = async () => [admin, player]
      api.teamStats = async () => []
      api.teamPitchingStats = async () => []
      api.standings = async () => []
      api.follows = async () => []
      await mount(
        <TeamPage
          client={api}
          id="tem_hawks"
          initialTab="team"
          onOpenGame={() => undefined}
          onAddPeople={(id, role) => {
            opened.push(role == null ? `people:${id}` : `${role}:${id}`)
          }}
          onAddExistingPlayer={id => {
            opened.push(`existing:${id}`)
          }}
          onCreatePlayer={id => {
            opened.push(`create:${id}`)
          }}
        />
      )
      return opened
    }

    it('offers the adds as settings does: people to its administrators, players to its roster managers', async function () {
      const opened = await page(
        detail({ canManage: true, canManageRoster: true })
      )
      await press('Add Admin to Demo Hawks')
      await press('Add Staff to Demo Hawks')
      await press('Add Player to Demo Hawks')
      await press('Add existing player')
      await press('Add Player to Demo Hawks')
      await press('Create new player')
      expect(opened).deep.equals([
        'admin:tem_hawks',
        'people:tem_hawks',
        'existing:tem_hawks',
        'create:tem_hawks'
      ])
    })

    it('offers only Add Player to a roster manager, and no add to anybody else or on an external team', async function () {
      await page(detail({ canManageRoster: true }))
      expect(button('Add Player to Demo Hawks')).not.equals(undefined)
      expect(button('Add Staff to Demo Hawks')).equals(undefined)
      expect(button('Add Admin to Demo Hawks')).equals(undefined)
      await act(async () => {
        root?.unmount()
      })
      await page(detail({}))
      expect(button('Add Player to Demo Hawks')).equals(undefined)
      expect(button('Add Spectator to Demo Hawks')).equals(undefined)
      await act(async () => {
        root?.unmount()
      })
      await page(
        detail({
          canManage: true,
          canManageRoster: true,
          group: asPublicGroup({
            kind: 'team',
            id: 'tem_hawks',
            name: 'Demo Hawks',
            imageUrl: null,
            locality: null,
            external: true
          })
        })
      )
      expect(button('Add Player to Demo Hawks')).equals(undefined)
      expect(button('Add Staff to Demo Hawks')).equals(undefined)
    })
  })
})
