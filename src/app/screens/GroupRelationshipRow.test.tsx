import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React from 'react'

import { asPublicGroup } from '../../common/publicGroups'
import { mount, press, text, unmount } from '../../test/gameFormDom'
import { GroupRelationshipRow } from './GroupRelationshipRow'

describe('shared relationship Leave row', () => {
  afterEach(unmount)
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
