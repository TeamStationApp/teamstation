import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'

import { TeamStationClient } from '../../common/api'
import type { PlayerNamePrivacy } from '../../common/playerNamePrivacy'
import { asGroupDetail, type GroupDetail } from '../../common/publicGroups'
import { mount, press, settle, text, unmount } from '../../test/gameFormDom'
import { GroupSettingsScreen } from './GroupSettingsScreen'
import { privacyRowText } from './PlayerNamePrivacyRow'

const detailOf = (
  fields: Partial<
    Pick<
      GroupDetail,
      | 'playerNamePrivacy'
      | 'playerNamePrivacyFormat'
      | 'playerNamePrivacyInheritedFrom'
      | 'canManage'
    >
  > = {}
): GroupDetail =>
  asGroupDetail({
    group: {
      kind: 'team',
      id: 'canonical',
      name: 'Bluebirds',
      imageUrl: null,
      locality: {
        city: 'Toronto',
        region: 'Ontario',
        country: 'Canada',
        placeId: null,
        timezone: 'America/Toronto'
      },
      startsOn: null,
      endsOn: null
    },
    parents: [],
    children: [],
    competingTeams: [],
    participatingSeasons: [],
    games: [],
    staff: [],
    canManage: true,
    nonMemberView: false,
    canViewPrivate: true,
    ...fields
  })

const season = (
  id: string,
  name: string
): GroupDetail['playerNamePrivacyInheritedFrom'][number] => ({
  kind: 'season',
  id,
  name
})

describe('the Player Name Privacy row', function () {
  afterEach(unmount)

  it('reads Default and the built-in format with nothing above', function () {
    expect(privacyRowText(detailOf())).deep.equals({
      subtitle: 'Default',
      detail: 'First name, last initial'
    })
  })

  it('names where an inherited format came from', function () {
    expect(
      privacyRowText(
        detailOf({
          playerNamePrivacyFormat: 'full',
          playerNamePrivacyInheritedFrom: [
            { kind: 'league', id: 'l', name: 'Lakeshore' }
          ]
        })
      )
    ).deep.equals({
      subtitle: 'Default',
      detail: 'Full name, inherited from Lakeshore'
    })
  })

  it('names both of two tied seasons', function () {
    expect(
      privacyRowText(
        detailOf({
          playerNamePrivacyFormat: 'initials',
          playerNamePrivacyInheritedFrom: [
            season('a', 'Fall'),
            season('b', 'Spring')
          ]
        })
      ).detail
    ).equals('First initial, last initial, inherited from Fall and Spring')
  })

  it('reads a stored value with no second line', function () {
    expect(
      privacyRowText(
        detailOf({
          playerNamePrivacy: 'full',
          playerNamePrivacyFormat: 'full'
        })
      )
    ).deep.equals({ subtitle: 'Full name' })
  })

  const stop = async (index: number): Promise<void> => {
    const row = document.querySelector<HTMLElement>(
      `[data-testid="player-name-privacy-${index}"]`
    )
    await act(async () => {
      row?.click()
      await Promise.resolve()
    })
  }

  const screen = async (
    detail: GroupDetail
  ): Promise<{ calls: Array<PlayerNamePrivacy | null | undefined> }> => {
    const client = new TeamStationClient({ baseUrl: '/api/v1' })
    const calls: Array<PlayerNamePrivacy | null | undefined> = []
    client.group = async () => detail
    client.roster = async () => []
    client.gameProposals = async () => []
    client.updateGroup = async (_ref, body) => {
      calls.push(body.playerNamePrivacy)
      return detail.group
    }
    await mount(
      <GroupSettingsScreen
        client={client}
        groupRef={{ kind: 'team', id: 'canonical' }}
      />
    )
    await settle()
    return { calls }
  }

  it('stores the chosen stop on Use', async function () {
    const { calls } = await screen(detailOf())
    expect(text()).include('Player Name Privacy')
    await press('Player Name Privacy, Default, First name, last initial')
    await settle()
    await stop(3)
    await press('Use')
    await settle()
    expect(calls).deep.equals(['initials'])
  })

  it('goes back to Default as null', async function () {
    const { calls } = await screen(
      detailOf({ playerNamePrivacy: 'full', playerNamePrivacyFormat: 'full' })
    )
    await press('Player Name Privacy, Full name')
    await settle()
    await stop(0)
    await press('Use')
    await settle()
    expect(calls).deep.equals([null])
  })

  it('stores nothing on Cancel', async function () {
    const { calls } = await screen(detailOf())
    await press('Player Name Privacy, Default, First name, last initial')
    await settle()
    await press('Cancel')
    await settle()
    expect(calls).deep.equals([])
    expect(text()).not.include('Show players as')
  })

  it('is not offered to anybody but an administrator', async function () {
    await screen(detailOf({ canManage: false }))
    expect(text()).not.include('Player Name Privacy')
  })
})
