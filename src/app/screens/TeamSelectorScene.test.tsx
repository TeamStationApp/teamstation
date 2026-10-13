import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React from 'react'

import { TeamStationClient } from '../../common/api'
import {
  asGroupDetail,
  asPublicGroup,
  asSearchRow,
  type PublicGroup,
  type SearchRow
} from '../../common/publicGroups'
import {
  fill,
  find,
  mount,
  press,
  settle,
  text,
  unmount
} from '../../test/gameFormDom'
import { Button } from '../components'
import { orderCustodians, type TeamChoice } from './PlaceholderTeamForm'
import { teamRowContext, TeamSelectorScene } from './TeamSelectorScene'

const row = (fields: Record<string, unknown>): SearchRow =>
  asSearchRow({
    kind: 'team',
    imageUrl: null,
    locality: null,
    ...fields
  })
const owls = row({
  id: 'tem_owls',
  name: 'Demo Owls',
  parentNames: ['Demo League A'],
  seasonNames: ['Demo Regular', 'Demo Fall'],
  staffNames: ['Ichiro', 'Mike T.']
})
const herons = row({
  id: 'tem_herons',
  name: 'Demo Herons',
  locality: {
    city: 'Demo City',
    region: 'Demo Region',
    country: 'US',
    placeId: null,
    timezone: 'UTC'
  }
})
const hawks = row({ id: 'tem_hawks', name: 'Demo Hawks' })
const visitors = row({
  id: 'tem_visitors',
  name: 'Demo Visitors',
  external: true
})
const custodian = asPublicGroup({
  id: 'tem_hawks',
  kind: 'team',
  name: 'Demo Hawks',
  imageUrl: null,
  locality: null
})

interface Asked {
  related: Array<{ teamId?: string; seasonId?: string }>
  searched: string[]
}

function api(
  overrides: Partial<{
    related: () => Promise<SearchRow[]>
    search: (query: string) => Promise<SearchRow[]>
    group: (id: string) => Promise<PublicGroup>
  }> = {}
): { client: TeamStationClient; asked: Asked } {
  const asked: Asked = { related: [], searched: [] }
  const client = new TeamStationClient({ baseUrl: '/api/v1' })
  client.relatedTeams = async anchor => {
    asked.related.push(anchor)
    return await (overrides.related?.() ?? [owls, hawks, owls, herons])
  }
  client.discoverGroups = async (_kind, query = '') => {
    asked.searched.push(query)
    return await (overrides.search?.(query) ?? [visitors])
  }
  client.group = async ref =>
    asGroupDetail({
      nonMemberView: false,
      group: await (overrides.group?.(ref.id) ??
        asPublicGroup({ ...owls, id: ref.id })),
      parents: [],
      children: [],
      competingTeams: [],
      participatingSeasons: [],
      staff: [],
      games: [],
      canManage: ref.id !== 'tem_herons'
    })
  client.citySuggestions = async () => ({
    provider: 'geonames',
    attribution: 'GeoNames',
    suggestions: [
      { id: 'place-1', primary: 'Springfield', secondary: 'Demo Region, US' }
    ]
  })
  client.location = async () => ({
    city: 'Springfield',
    region: 'Demo Region',
    country: 'US',
    placeId: 'place-1',
    timezone: 'America/Chicago'
  })
  return { client, asked }
}

async function open(
  client: TeamStationClient,
  props: Partial<React.ComponentProps<typeof TeamSelectorScene>> = {}
): Promise<{ chosen: TeamChoice[]; closed: number[] }> {
  const chosen: TeamChoice[] = []
  const closed: number[] = []
  await mount(
    <TeamSelectorScene
      client={client}
      title="Choose Away Team"
      anchor={{ teamId: 'tem_hawks' }}
      excludeIds={['tem_hawks']}
      custodians={[custodian]}
      onChoose={choice => chosen.push(choice)}
      onClose={() => closed.push(1)}
      {...props}
    />
  )
  return { chosen, closed }
}

describe('team selector scene', () => {
  afterEach(unmount)

  it('suggests teams before a search, without the excluded or repeated ones', async () => {
    const { client, asked } = api()
    await open(client, { anchor: { teamId: 'tem_hawks', seasonId: 'sea_a' } })
    expect(asked.related).deep.equals([
      { teamId: 'tem_hawks', seasonId: 'sea_a' }
    ])
    expect(text()).includes('Choose Away Team')
    expect(text()).includes('Suggested')
    expect(find('Choose Demo Hawks')).equals(undefined)
    expect(
      document.querySelectorAll('[data-testid="team-result-tem_owls"]')
    ).length(1)
    // Seasons then leagues on the second line, staff on the third.
    expect(text()).includes('Demo Regular · Demo Fall · Demo League A')
    expect(
      document.querySelector('[data-testid="team-staff-tem_owls"]')?.textContent
    ).equals('Ichiro, Mike T.')
    expect(text()).includes('Demo City, Demo Region, US')
    const labels = [
      ...document.querySelectorAll<HTMLElement>('[role="button"]')
    ].map(node => node.getAttribute('aria-label') ?? node.textContent)
    expect(labels.at(-1)).match(/^Create Placeholder Team, /)
  })

  it('marks the team this side holds now', async () => {
    const { client } = api()
    await open(client, { currentId: 'tem_owls' })
    const row = (id: string): HTMLElement =>
      document.querySelector<HTMLElement>(`[data-testid="team-result-${id}"]`)!
    expect(row('tem_owls').getAttribute('aria-selected')).equals('true')
    const others = [
      ...document.querySelectorAll<HTMLElement>('[data-testid^="team-result-"]')
    ].filter(node => node !== row('tem_owls'))
    expect(others.length).greaterThan(0)
    for (const other of others)
      expect(other.getAttribute('aria-selected')).not.equals('true')
  })

  it('searches every team after a pause, and says when nothing matches', async () => {
    const { client, asked } = api({
      search: async query => (query === 'zz' ? [] : [visitors])
    })
    await open(client)
    await fill('Search all teams', 'Vis')
    expect(asked.searched).deep.equals([])
    await settle()
    expect(asked.searched).deep.equals(['Vis'])
    expect(text()).not.includes('Suggested')
    expect(text()).includes('Placeholder')
    await fill('Search all teams', 'zz')
    await settle()
    expect(text()).includes('No teams match “zz”.')
    const labels = [
      ...document.querySelectorAll<HTMLElement>('[role="button"]')
    ].map(node => node.getAttribute('aria-label') ?? node.textContent)
    expect(labels.at(-1)).match(/^Create Placeholder Team, /)
  })

  it('offers no suggestions without an anchor', async () => {
    const { client, asked } = api()
    await open(client, { anchor: {} })
    expect(asked.related).deep.equals([])
    expect(text()).not.includes('Suggested')
    expect(text()).not.includes('Loading teams')
  })

  it('chooses a team with whether it can be managed, and closes without one', async () => {
    const { client } = api()
    const { chosen, closed } = await open(client)
    await press('Choose Demo Herons')
    await settle(20)
    expect(
      chosen.map(choice => [choice.group.id, choice.canManage])
    ).deep.equals([['tem_herons', false]])
    await press('Cancel team selector')
    expect(closed).length(1)
    expect(chosen).length(1)
  })

  it('says when a chosen team cannot load', async () => {
    const { client } = api({
      group: async () => {
        throw new Error('Team gone')
      }
    })
    const { chosen } = await open(client)
    await press('Choose Demo Owls')
    await settle(20)
    expect(chosen).length(0)
    expect(text()).includes('Team gone')
  })

  it('retains staff scheduling authority when choosing another managed team', async () => {
    const { client } = api()
    const group = client.group.bind(client)
    client.group = async ref =>
      asGroupDetail({
        ...(await group(ref)),
        canManage: false,
        canManagePeople: true
      })
    const { chosen } = await open(client)
    await press('Choose Demo Herons')
    await settle(20)
    expect(chosen.map(choice => choice.canManage)).deep.equals([true])
  })

  it('reports a failed load and retries it', async () => {
    let fail = true
    const { client, asked } = api({
      related: async () => {
        if (fail) throw new Error('down')
        return [owls]
      }
    })
    await open(client)
    expect(text()).includes('Teams could not load. Try searching again.')
    fail = false
    await press('Retry')
    await settle()
    expect(asked.related).length(2)
    expect(find('Choose Demo Owls')).not.equals(undefined)
  })

  it('makes a placeholder with only a name, kept by the first custodian', async () => {
    const { client } = api()
    const { chosen } = await open(client)
    await press('Create Placeholder Team')
    expect(text()).includes('Kept by Demo Hawks')
    expect(find('Continue')?.getAttribute('aria-disabled')).equals('true')
    await fill('Team name', '  Riverside Owls  ')
    await press('Continue')
    await press('Skip')
    await press('Skip')
    expect(chosen).length(1)
    const [choice] = chosen
    expect(choice.group.name).equals('Riverside Owls')
    expect(choice.group.id).match(/^draft-placeholder-/)
    expect(choice.group.external).equals(true)
    expect(choice.placeholder).deep.include({
      kind: 'team',
      name: 'Riverside Owls',
      external: true,
      custodian: { kind: 'team', id: 'tem_hawks' },
      picture: { initials: true }
    })
    expect(choice.placeholder).not.have.property('locality')
  })

  it('fills a placeholder location from the city search and keeps a logo choice', async () => {
    const { client } = api()
    const { chosen } = await open(client)
    await press('Create Placeholder Team')
    await fill('Team name', 'Riverside Owls')
    await press('Continue')
    await press('Location not set')
    await fill('City', 'Spring')
    await settle()
    await press('Choose Springfield, Demo Region, US')
    await press('Save')
    await press('Continue')
    await press('Use initials')
    await press('Previous step')
    await press('Continue')
    await press('Use Placeholder Team')
    expect(chosen[0].placeholder?.locality).deep.equals({
      city: 'Springfield',
      region: 'Demo Region',
      country: 'US',
      placeId: 'place-1',
      timezone: 'America/Chicago'
    })
    expect(chosen[0].group.timezone).equals('America/Chicago')
    expect(chosen[0].placeholder?.picture).deep.equals({ initials: true })
  })

  it('backs out of the placeholder form step by step', async () => {
    const { client } = api()
    const { chosen } = await open(client)
    await press('Create Placeholder Team')
    await fill('Team name', 'Riverside Owls')
    await press('Continue')
    await press('Previous step')
    await press('Cancel')
    expect(find('Search all teams')).equals(undefined)
    expect(
      document.querySelector('[aria-label="Search all teams"]')
    ).not.equals(null)
    expect(chosen).length(0)
  })

  it('says why the placeholder row waits while its keepers load or fail', async () => {
    const { client } = api()
    await open(client, { custodianNote: 'Finding who may keep a placeholder…' })
    expect(text()).includes('Finding who may keep a placeholder…')
    expect(find('Create Placeholder Team')).equals(undefined)
  })

  it('offers no placeholder without a custodian', async () => {
    const { client } = api()
    await open(client, { custodians: [] })
    expect(text()).includes(
      'You need to manage a team or season to create a placeholder.'
    )
    // The row is there to explain itself, and opens nothing.
    expect(find('Create Placeholder Team')).equals(undefined)
    expect(text()).not.includes('Kept by')
  })

  it('orders custodians: the source team, a team in the game, its season, then any', () => {
    const group = (
      id: string,
      kind: 'team' | 'season',
      external = false
    ): PublicGroup =>
      asPublicGroup({
        id,
        kind,
        name: id,
        imageUrl: null,
        locality: null,
        external
      })
    const any = group('tem_any', 'team')
    const placeholder = group('tem_placeholder', 'team', true)
    const season = group('sea_game', 'season')
    const participant = group('tem_eagles', 'team')
    const source = group('tem_hawks', 'team')
    expect(
      orderCustodians([any, placeholder, season, participant, source], {
        sourceTeamId: 'tem_hawks',
        participantIds: ['tem_eagles'],
        seasonIds: ['sea_game']
      }).map(found => found.id)
    ).deep.equals(['tem_hawks', 'tem_eagles', 'sea_game', 'tem_any'])
    expect(
      orderCustodians([any, season], { participantIds: [], seasonIds: [] }).map(
        found => found.id
      )
    ).deep.equals(['tem_any', 'sea_game'])
  })

  it('names a row by where it plays when it has no seasons', () => {
    expect(teamRowContext(herons)).equals('Demo City, Demo Region, US')
    expect(teamRowContext(visitors)).equals('Placeholder')
    expect(teamRowContext(hawks)).equals('')
  })

  it('draws a small button label at the full height', async () => {
    await mount(
      <Button
        label="Withdraw Demo Hawks"
        kind="text"
        small
        onPress={() => undefined}
      />
    )
    const label = [
      ...find('Withdraw Demo Hawks')!.querySelectorAll('div')
    ].find(node => node.textContent === 'Withdraw Demo Hawks')!
    expect(getComputedStyle(label).fontSize).equals('14px')
    expect(getComputedStyle(find('Withdraw Demo Hawks')!).minHeight).equals(
      '48px'
    )
  })
})
