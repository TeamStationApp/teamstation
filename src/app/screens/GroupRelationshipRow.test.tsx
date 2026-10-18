import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React from 'react'

import { asPublicGroup } from '../../common/publicGroups'
import { mount, press, text, unmount } from '../../test/gameFormDom'
import { GroupRelationshipRow } from './GroupRelationshipRow'

describe('shared relationship Leave row', () => {
  afterEach(unmount)
  it('separates navigation from Leave without a chevron', async () => {
    let opened = 0
    let left = 0
    await mount(
      <GroupRelationshipRow
        group={{ id: 'team', kind: 'team', name: 'Owls', imageUrl: null }}
        onOpen={() => {
          opened++
        }}
        onLeave={() => {
          left++
        }}
        label="Leave Owls"
      />
    )
    expect(text()).not.includes('chevron_right')
    expect(
      document.querySelector('[data-testid="relationship-action-divider"]')
    ).not.equals(null)
    await press('Leave Owls')
    expect([opened, left]).deep.equals([0, 1])
    await press('Open Owls')
    expect([opened, left]).deep.equals([1, 1])
  })
  for (const kind of ['league', 'season'] as const)
    it(`identifies the ${kind} and opens only its Leave action`, async () => {
      let calls = 0
      await mount(
        <GroupRelationshipRow
          group={asPublicGroup({
            kind,
            id: 'group',
            name: 'Willow Woods',
            imageUrl: null,
            locality: null
          })}
          label={`Leave ${kind}`}
          onLeave={() => {
            calls++
          }}
        />
      )
      expect(text()).includes(kind === 'league' ? 'League' : 'Season')
      await press(`Leave ${kind}`)
      expect(calls).equals(1)
    })
})
