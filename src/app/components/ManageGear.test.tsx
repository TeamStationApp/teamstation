import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act, useState } from 'react'

import { TeamStationClient } from '../../common/api'
import { find, mount, press, unmount } from '../../test/gameFormDom'
import { Button } from './Button'
import { ManageGear } from './ManageGear'

describe('scope-bound hero settings permission', () => {
  afterEach(unmount)
  it('hides unknown, denied and stale permissions when changing scopes', async () => {
    const client = new TeamStationClient({ baseUrl: '/api/v1' })
    const replies: Array<
      (value: Awaited<ReturnType<TeamStationClient['invites']>>) => void
    > = []
    client.invites = async () =>
      await new Promise(resolve => {
        replies.push(resolve)
      })
    function Harness(): React.ReactElement {
      const [scope, setScope] = useState('first')
      return (
        <>
          <ManageGear
            client={client}
            scopeType="team"
            scopeId={scope}
            onPress={() => {}}
          />
          <Button
            label="Next scope"
            onPress={() => {
              setScope('second')
            }}
          />
        </>
      )
    }
    await mount(<Harness />)
    expect(find('Manage')).equals(undefined)
    await act(async () => {
      replies[0]({ canInvite: true, invites: [] })
    })
    expect(find('Manage')).not.equals(undefined)
    await press('Next scope')
    expect(find('Manage')).equals(undefined)
    await act(async () => {
      replies[1]({ canInvite: false, invites: [] })
    })
    expect(find('Manage')).equals(undefined)
  })
  it('does not publish a permission response after unmount and fails closed offline', async () => {
    const client = new TeamStationClient({ baseUrl: '/api/v1' })
    let reply!: (
      value: Awaited<ReturnType<TeamStationClient['invites']>>
    ) => void
    client.invites = async () =>
      await new Promise(resolve => {
        reply = resolve
      })
    await mount(
      <ManageGear
        client={client}
        scopeType="league"
        scopeId="first"
        onPress={() => {}}
      />
    )
    await unmount()
    await act(async () => {
      reply({ canInvite: true, invites: [] })
    })
    client.invites = async () => {
      throw new Error('Offline')
    }
    await mount(
      <ManageGear
        client={client}
        scopeType="season"
        scopeId="second"
        onPress={() => {}}
      />
    )
    expect(find('Manage')).equals(undefined)
  })
})
