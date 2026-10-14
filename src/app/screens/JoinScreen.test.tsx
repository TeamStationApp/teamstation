import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React from 'react'

import type { TeamStationClient } from '../../common/api'
import { mount, text, unmount } from '../../test/gameFormDom'
import { JoinScreen } from './JoinScreen'

describe('invalid invitation language', () => {
  afterEach(unmount)
  for (const missing of [true, false])
    it(`uses Invalid invite link for ${missing ? 'unknown' : 'expired'} invitations`, async () => {
      const client = {
        inviteInfo: async () => {
          if (missing) throw new Error('Not found')
          return {
            valid: false,
            alreadyIn: false,
            scope: { kind: 'team', id: 'tem_demo', name: 'Demo Owls' },
            needsName: false
          }
        }
      } as unknown as TeamStationClient
      await mount(
        <JoinScreen
          client={client}
          code="placeholder-invite"
          signedIn
          onSignedIn={() => {}}
          onOpen={() => {}}
        />
      )
      expect(text()).includes('Invalid invite link')
      expect(text()).not.includes('not good').and.not.includes('no longer good')
      if (missing) expect(text()).includes('expired or been revoked')
    })
})
