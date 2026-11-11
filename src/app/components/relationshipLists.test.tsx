import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Text } from 'react-native'

import { asRosterEntry, TeamStationClient } from '../../common/api'
import { asPublicGroup, type PublicGroup } from '../../common/publicGroups'
import { userIdOfGumbo } from '../../common/userId'
import {
  find,
  press,
  rowLeaf,
  rowTextColor,
  settle,
  text
} from '../../test/gameFormDom'
import {
  GroupRelationshipRow,
  relationshipDetails
} from '../screens/GroupRelationshipRow'
import { ParticipationList } from '../screens/ParticipationList'
import { ScopedThemeProvider, ThemeProvider } from '../theme/ThemeContext'
import { tsBallpark } from '../theme/tsBallpark'
import { tsDark } from '../theme/tsDark'
import { ActionList, ActionRow } from './ActionRow'
import { Button } from './Button'
import { DangerText } from './DangerText'
import { PeopleList, peopleSubtitle, PersonRow } from './PeopleList'
import { useConfirmedAction } from './useConfirmedAction'

let root: Root | undefined
async function render(element: React.ReactElement): Promise<void> {
  if (root == null) {
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  }
  await act(async () => {
    root!.render(<ThemeProvider>{element}</ThemeProvider>)
  })
  await settle(0)
}
const group = (kind: 'team' | 'season' | 'league', id = 'one'): PublicGroup =>
  asPublicGroup({
    kind,
    id,
    name: `Demo ${id}`,
    imageUrl: null,
    locality: null
  })
const api = new TeamStationClient({ baseUrl: '/api/v1' })
describe('relationship list presentation and confirmation', () => {
  afterEach(async () => {
    await act(async () => root?.unmount())
    root = undefined
    document.body.replaceChildren()
  })
  const leaveRow = (
    <GroupRelationshipRow
      group={group('league')}
      label="Leave Demo one"
      onLeave={() => undefined}
    />
  )
  it('keeps a bounded list readable where the card matches the canvas text', async () => {
    await render(
      <ScopedThemeProvider theme={tsDark}>
        <ActionList bounded>{leaveRow}</ActionList>
      </ScopedThemeProvider>
    )
    expect(rowTextColor('Demo one')).equals('rgb(31, 36, 24)')
    // The detail keeps a quieter tone than the title.
    expect(rowTextColor('League')).equals('rgb(87, 93, 84)')
    expect(rowTextColor('Leave')).equals('rgb(186, 26, 26)')
  })
  it('keeps season links, and the detail beside them, on one second line', async () => {
    const name = '2027 Spring Regular Season Majors Division'
    await render(
      <ActionList bounded>
        <GroupRelationshipRow
          group={group('team')}
          detail="Placeholder team"
          links={[
            { label: name, onPress: () => undefined },
            { label: 'Demo Fall', onPress: () => undefined }
          ]}
        />
      </ActionList>
    )
    const label = rowLeaf(name)
    // One line each: a long name ends in an ellipsis rather than wrapping.
    expect(getComputedStyle(label).whiteSpace).equals('nowrap')
    expect(getComputedStyle(label).flexShrink).equals('1')
    // The second line is not bold, and matches the detail's size.
    expect(['400', 'normal']).includes(getComputedStyle(label).fontWeight)
    expect(getComputedStyle(label).fontSize).equals(
      getComputedStyle(rowLeaf('Placeholder team')).fontSize
    )
    expect(find(`Open ${name}`)).not.equals(undefined)
    expect(find('Open Demo Fall')).not.equals(undefined)
    // The detail moves onto the links' line, once, so the title stands alone.
    const detail = rowLeaf('Placeholder team')
    expect(detail.parentElement).equals(
      label.closest('[role="button"]')!.parentElement
    )
    expect(
      [...document.querySelectorAll('*')].filter(
        node =>
          node.children.length === 0 && node.textContent === 'Placeholder team'
      )
    ).length(1)
  })
  it('leaves an unbounded list and an ordinary theme alone', async () => {
    await render(
      <ScopedThemeProvider theme={tsDark}>
        <ActionList>{leaveRow}</ActionList>
      </ScopedThemeProvider>
    )
    expect(rowTextColor('Demo one')).equals('rgb(232, 228, 216)')
    await render(
      <ScopedThemeProvider theme={tsBallpark}>
        <ActionList bounded>{leaveRow}</ActionList>
      </ScopedThemeProvider>
    )
    const plain = rowTextColor('Demo one')
    await render(
      <ScopedThemeProvider theme={tsBallpark}>
        <ActionList>{leaveRow}</ActionList>
      </ScopedThemeProvider>
    )
    expect(rowTextColor('Demo one')).equals(plain)
  })
  it('separates navigation and short actions, wraps identities and renders only meaningful detail', async () => {
    const opened: string[] = []
    await render(
      <ActionList>
        <GroupRelationshipRow
          group={{
            ...group('team'),
            name: 'Willow Woods Westward Wanderers',
            imageUrl: '/fixture-logo.png'
          }}
          detail="Placeholder team · Demo City"
          onOpen={() => opened.push('open')}
          onLeave={() => opened.push('leave')}
          label="Leave selected team"
        />
        <GroupRelationshipRow group={group('team', 'two')} />
      </ActionList>
    )
    expect(text()).includes('Placeholder team · Demo City')
    const name = [...document.querySelectorAll('div')].find(
      n =>
        n.textContent === 'Willow Woods Westward Wanderers' &&
        n.children.length === 0
    )!
    expect(getComputedStyle(name).whiteSpace).not.equals('nowrap')
    expect(document.querySelector('[role="button"] [role="button"]')).equals(
      null
    )
    await press('Open Willow Woods Westward Wanderers')
    await press('Leave selected team')
    expect(opened).deep.equals(['open', 'leave'])
    const action = find('Leave selected team')!
    expect(getComputedStyle(action).minWidth).equals('48px')
    expect(getComputedStyle(action).minHeight).equals('48px')
    await render(
      <ActionList bounded testID="bounded">
        <ActionRow
          title="Babe Ruth"
          leading={<Text>BR</Text>}
          detail="operator@example.com"
          end={<DangerText label="Revoke" onPress={() => {}} />}
        />
        <ActionRow title="Ichiro" />
      </ActionList>
    )
    expect(text()).includes('operator@example.com')
    expect(document.querySelector('[data-testid="bounded"]')).not.equals(null)
  })
  it('keeps large-text names flexible and cancels without mutation', async () => {
    let writes = 0
    api.endParticipation = async () => {
      writes++
    }
    await render(
      <ScopedThemeProvider theme={{ ...tsBallpark, rem: value => value * 24 }}>
        <ParticipationList
          client={api}
          owner={{ kind: 'season', id: 'season', name: 'Demo Season' }}
          groups={[
            { ...group('team'), name: 'Willow Woods Westward Wanderers' }
          ]}
          onLeft={() => {}}
        />
      </ScopedThemeProvider>
    )
    const name = [...document.querySelectorAll<HTMLElement>('div')].find(
      n =>
        n.children.length === 0 &&
        n.textContent === 'Willow Woods Westward Wanderers'
    )!
    expect(parseFloat(getComputedStyle(name).fontSize)).greaterThan(24)
    // The season's participating teams share one card, as the team's seasons do.
    const card = document.querySelector<HTMLElement>(
      '[data-testid="participating-teams-list"]'
    )!
    const surface = document.createElement('div')
    surface.style.color = tsBallpark.cardBackgroundColor
    expect(getComputedStyle(card).backgroundColor).equals(surface.style.color)
    expect(card.contains(name)).equals(true)
    await press('End participation for Willow Woods Westward Wanderers')
    await press('Cancel')
    expect(find('Confirm end participation')).equals(undefined)
    expect(writes).equals(0)
  })
  it('uses the existing team tint and facts, without inventing absent details', async () => {
    expect(relationshipDetails(group('team'))).equals(undefined)
    expect(
      relationshipDetails({
        ...group('team'),
        external: true,
        parentNames: ['Demo League'],
        locality: {
          city: 'Demo City',
          region: 'Demo Region',
          country: 'US',
          placeId: null,
          timezone: 'UTC'
        }
      })
    ).equals('Placeholder team · Demo League · Demo City, Demo Region, US')
    await render(
      <GroupRelationshipRow
        group={group('team')}
        onLeave={() => {}}
        label="End Demo one"
        action="End"
      />
    )
    expect(text()).includes('DO')
    expect(find('End Demo one')?.textContent).equals('End')
  })
  it('confirms only the selected season-side team, with retry and one success refresh', async () => {
    const calls: unknown[] = []
    let changed = 0
    let fail = true
    api.endParticipation = async (...args) => {
      calls.push(args)
      if (fail) throw new Error('Try this again')
    }
    await render(
      <ParticipationList
        client={api}
        owner={{ kind: 'season', id: 'season', name: 'Demo Season' }}
        groups={[group('team'), group('team', 'two')]}
        onLeft={() => changed++}
      />
    )
    await press('End participation for Demo two')
    expect(text()).includes('End participation for Demo two in Demo Season?')
    expect(calls).length(0)
    await press('Cancel participation end')
    expect(calls).length(0)
    await press('End participation for Demo two')
    await press('Confirm end participation')
    expect(text()).includes('Try this again')
    expect(changed).equals(0)
    fail = false
    await press('Confirm end participation')
    expect(calls).deep.equals([
      ['season', 'two'],
      ['season', 'two']
    ])
    expect(changed).equals(1)
  })
  it('invalidates pending confirmation when an item disappears or permissions change', async () => {
    let writes = 0
    api.endParticipation = async () => {
      writes++
    }
    const draw = (
      disabled: boolean,
      groups = [group('team')]
    ): React.ReactElement => (
      <ParticipationList
        client={api}
        owner={{ kind: 'season', id: 'season', name: 'Demo Season' }}
        groups={groups}
        disabled={disabled}
        onLeft={() => {}}
      />
    )
    await render(draw(false))
    await press('End participation for Demo one')
    await render(draw(true))
    expect(find('Confirm end participation')).equals(undefined)
    await render(draw(false))
    await press('End participation for Demo one')
    await render(draw(false, []))
    expect(find('Confirm end participation')).equals(undefined)
    expect(writes).equals(0)
  })
  it('ignores old writes across a new group or client and permits the new visit', async () => {
    let finish!: () => void
    let refreshed = 0
    api.endParticipation = async () => {
      await new Promise<void>(resolve => {
        finish = resolve
      })
    }
    const draw = (
      client: TeamStationClient,
      id: string
    ): React.ReactElement => (
      <ParticipationList
        client={client}
        owner={{ kind: 'season', id, name: 'Demo Season' }}
        groups={[group('team')]}
        onLeft={() => refreshed++}
      />
    )
    await render(draw(api, 'first'))
    await press('End participation for Demo one')
    await press('Confirm end participation')
    const newer = new TeamStationClient({ baseUrl: '/new' })
    newer.endParticipation = async () => {}
    await render(draw(newer, 'second'))
    await act(async () => {
      finish()
    })
    expect(refreshed).equals(0)
    await press('End participation for Demo one')
    await press('Confirm end participation')
    expect(refreshed).equals(1)
  })
  it('guards duplicate writes, all busy dismissal, and renders unknown failures retryably', async () => {
    let finish!: () => void
    let writes = 0
    let fail = false
    function Fixture(): React.ReactElement {
      const c = useConfirmedAction(api, 'fixture')
      return (
        <>
          <Button
            label="Open"
            onPress={() => {
              c.open({
                title: 'Remove Demo?',
                detail: 'Only this connection changes.',
                label: 'Remove',
                run: async () => {
                  writes++
                  if (fail) {
                    await Promise.reject(new Error('Retry removal'))
                    return
                  }
                  await new Promise<void>(resolve => {
                    finish = resolve
                  })
                }
              })
            }}
          />
          {c.sheet}
        </>
      )
    }
    await render(<Fixture />)
    await press('Open')
    await act(async () => {
      find('Remove')!.click()
      find('Remove')!.click()
    })
    expect(writes).equals(1)
    await press('Cancel')
    await press('Cancel confirmation')
    expect(find('Cancel')?.getAttribute('aria-disabled')).equals('true')
    await act(async () => {
      finish()
    })
    expect(find('Remove')).equals(undefined)
    fail = true
    await press('Open')
    await press('Remove')
    expect(text()).includes('Retry removal')
    await press('Cancel')
    expect(find('Remove')).equals(undefined)
  })
})

describe('people list rows and their affiliation lines', () => {
  afterEach(async () => {
    await act(async () => root?.unmount())
    root = undefined
    document.body.replaceChildren()
  })
  const person = (
    gumbo: number,
    shortName: string,
    over: Record<string, unknown>
  ): ReturnType<typeof asRosterEntry> =>
    asRosterEntry({
      userId: userIdOfGumbo(gumbo),
      gumboId: gumbo,
      shortName,
      jersey: null,
      positions: [],
      isPlayer: false,
      role: 'member',
      section: 'spectator',
      staffRoles: [],
      inheritedFrom: null,
      ...over
    })
  const people = [
    person(1, 'Cal Ripken', {
      section: 'admin',
      staffRoles: ['coach', 'scorekeeper'],
      affiliations: 'Demo Hawks'
    }),
    person(2, 'Josh S', {
      section: 'player',
      isPlayer: true,
      positions: ['SS', '2B'],
      teamNames: ['Demo Hawks'],
      affiliations: 'Guardians: Ken G · Demo Hawks'
    }),
    person(3, 'Josh S', {
      section: 'player',
      isPlayer: true,
      teamNames: ['Demo Owls'],
      affiliations: 'Guardians: Tony G · Demo Owls'
    }),
    person(4, 'Ken G', {
      section: 'family',
      guardianOf: ['Josh S'],
      affiliations: 'Guardian of Josh S · Demo Hawks'
    }),
    person(5, 'Barry L', { section: 'spectator' })
  ]
  const rowOf = (gumbo: number): HTMLElement => {
    const { shortName, affiliations } = people.find(p => p.gumboId === gumbo)!
    const row = [
      ...document.querySelectorAll<HTMLElement>('[role="button"]')
    ].find(node => {
      const label = node.getAttribute('aria-label') ?? ''
      return label.startsWith(shortName) && label.includes(affiliations)
    })
    expect(row, String(gumbo)).not.equals(undefined)
    return row!
  }

  it('draws the line under the name, after role words and positions, and tells twins apart by it', async () => {
    await render(<PeopleList people={people} onOpen={() => () => {}} />)
    // The admin's roles stay on their own line, before the affiliation line.
    expect(rowOf(1).textContent).equals(
      'CRCal RipkenCoach · ScorekeeperDemo Hawkschevron_right'
    )
    // A player's positions stay before the line; the line holds the teams,
    // which no longer come from `teamNames`.
    expect(rowOf(2).textContent).equals(
      'JSJosh SSS · 2BGuardians: Ken G · Demo Hawkschevron_right'
    )
    // Twins read the same name and are told apart by their lines.
    expect(rowOf(3).textContent).equals(
      'JSJosh SGuardians: Tony G · Demo Owlschevron_right'
    )
    // A family member has only the line, not `Parent/guardian of …`.
    expect(rowOf(4).textContent).equals(
      'KGKen GGuardian of Josh S · Demo Hawkschevron_right'
    )
    expect(text()).not.contains('Parent/guardian')
    // The accessible label reads the name, the roles and the line.
    expect(rowOf(1).getAttribute('aria-label')).equals(
      'Cal Ripken, Coach · Scorekeeper, Demo Hawks'
    )
    expect(rowOf(2).getAttribute('aria-label')).equals(
      'Josh S, SS · 2B, Guardians: Ken G · Demo Hawks'
    )
  })

  it('draws no line for an empty one, nor for a public row that has none', async () => {
    await render(
      <>
        <PeopleList people={[people[4]]} onOpen={() => () => {}} />
        <PersonRow
          person={{
            shortName: 'Tony G',
            section: 'staff',
            staffRoles: ['coach'],
            avatarUrl: null,
            inheritedFrom: null,
            jersey: null,
            positions: []
          }}
        />
      </>
    )
    expect(text()).contains('BLBarry L').and.contains('TGTony GCoach')
    expect(
      document.querySelector('[role="button"]')!.getAttribute('aria-label')
    ).equals('Barry L')
    expect(document.querySelectorAll('[data-testid$="-viewport"]')).length(0)
  })

  it('keeps role words and positions in the subtitle, and nothing for family', () => {
    expect(peopleSubtitle(people[0])).equals('Coach · Scorekeeper')
    expect(peopleSubtitle(people[1])).equals('SS · 2B')
    expect(peopleSubtitle(people[2])).equals(undefined)
    expect(peopleSubtitle({ ...people[3], positions: ['C'] })).equals(undefined)
    expect(peopleSubtitle(people[4])).equals(undefined)
  })
})
