import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Text } from 'react-native'

import { TeamStationClient } from '../../common/api'
import { asPublicGroup, type PublicGroup } from '../../common/publicGroups'
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
    expect(rowTextColor('Leave')).equals('rgb(186, 26, 26)')
  })
  it('lets a long season link wrap inside the identity column', async () => {
    const name = '2027 Spring Regular Season Majors Division'
    await render(
      <ActionList bounded>
        <GroupRelationshipRow
          group={group('team')}
          links={[{ label: name, onPress: () => undefined }]}
        />
      </ActionList>
    )
    const label = rowLeaf(name)
    expect(getComputedStyle(label).whiteSpace).not.equals('nowrap')
    expect(getComputedStyle(label).flexShrink).equals('1')
    expect(getComputedStyle(find(`Open ${name}`)!).height).equals('auto')
    expect(find(`Open ${name}`)).not.equals(undefined)
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
