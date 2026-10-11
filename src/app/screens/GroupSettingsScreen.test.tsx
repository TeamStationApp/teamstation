import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { TeamStationClient } from '../../common/api'
import { asGameScheduleProposal } from '../../common/gameApprovals'
import { asGroupDetail } from '../../common/publicGroups'
import { ThemeProvider } from '../theme/ThemeContext'
import { GroupSettingsScreen } from './GroupSettingsScreen'

let root: Root | undefined
const detail = asGroupDetail({
  nonMemberView: false,
  group: {
    kind: 'team',
    id: 'canonical',
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
  canManage: true,
  canViewPrivate: false
})
const proposal = asGameScheduleProposal({
  requestId: 'declined-request',
  gameId: null,
  previous: null,
  status: 'declined',
  sentAt: '2026-10-10T18:00:00Z',
  canDelete: true,
  version: null,
  game: {
    homeTeamId: 'canonical',
    awayTeamId: 'visitor',
    seasonId: null,
    startAt: '2026-10-12T18:00:00Z',
    venue: null,
    outsideTournament: null,
    status: 'scheduled'
  }
})
function api(): TeamStationClient {
  const client = new TeamStationClient({ baseUrl: '/api/v1' })
  client.group = async () => detail
  client.gameProposals = async () => []
  return client
}
async function mount(element: React.ReactElement): Promise<void> {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<ThemeProvider>{element}</ThemeProvider>)
  })
}
function button(label: string): HTMLElement {
  const found = [
    ...document.querySelectorAll<HTMLElement>('[role="button"]')
  ].find(
    node => (node.getAttribute('aria-label') ?? node.textContent) === label
  )
  expect(found, label).not.equals(undefined)
  return found!
}
async function press(label: string): Promise<void> {
  await act(async () => {
    button(label).click()
  })
}
afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  document.body.replaceChildren()
})
describe('team settings management and pending saves', () => {
  it('retains canonical declined proposals and request navigation/deletion behind settings', async () => {
    const client = api()
    let removed = false
    let opened = ''
    client.gameProposals = async scope => {
      expect(scope).deep.equals({ kind: 'team', id: 'canonical' })
      return removed ? [] : [proposal]
    }
    client.deleteDeclinedGame = async (id, scope) => {
      expect(id).equals('declined-request')
      expect(scope).deep.equals({ kind: 'team', id: 'canonical' })
      removed = true
    }
    await mount(
      <GroupSettingsScreen
        client={client}
        groupRef={{ kind: 'team', id: 'alias' }}
        onLink={() => undefined}
        onSaved={() => undefined}
        onRequest={id => {
          opened = id
        }}
      />
    )
    expect(document.body.textContent).includes('Declined')
    await press('Open game proposal')
    expect(opened).equals('declined-request')
    await press('Delete declined entry')
    expect(removed).equals(true)
    expect(document.body.textContent).not.includes('Delete declined entry')
  })
  it('does not load administrative proposal lists for a viewer', async () => {
    const client = api()
    let requests = 0
    client.group = async () => ({ ...detail, canManage: false })
    client.gameProposals = async () => {
      requests++
      return [proposal]
    }
    await mount(
      <GroupSettingsScreen
        client={client}
        groupRef={{ kind: 'team', id: 'canonical' }}
        onLink={() => undefined}
        onSaved={() => undefined}
        onRequest={() => undefined}
      />
    )
    expect(requests).equals(0)
    expect(document.body.textContent).not.includes('Game proposals')
  })
  for (const leaves of [false, true])
    it(`locks Cancel and management during a save and ${leaves ? 'ignores completion after leaving' : 'completes exactly once'}`, async () => {
      const client = api()
      client.gameProposals = async () => [proposal]
      let finish!: () => void
      client.updateGroup = async () => {
        await new Promise<void>(resolve => {
          finish = resolve
        })
        return detail.group
      }
      let saved = 0
      let navigated = 0
      client.deleteDeclinedGame = async () => {
        navigated++
      }
      await mount(
        <GroupSettingsScreen
          client={client}
          groupRef={{ kind: 'team', id: 'canonical' }}
          onSaved={() => {
            saved++
          }}
          onCancel={() => {
            navigated++
          }}
          onLink={() => {
            navigated++
          }}
          onCreateGame={() => {
            navigated++
          }}
          onRequest={() => {
            navigated++
          }}
        />
      )
      await press('Save settings')
      for (const label of [
        'Cancel',
        'Join a Season',
        'Create Game',
        'Open game proposal',
        'Delete declined entry'
      ]) {
        expect(button(label).getAttribute('aria-disabled'), label).equals(
          'true'
        )
        await press(label)
      }
      expect(navigated).equals(0)
      if (leaves) {
        await act(async () => {
          root!.unmount()
        })
        root = undefined
      }
      await act(async () => {
        finish()
      })
      expect(saved).equals(leaves ? 0 : 1)
      expect(navigated).equals(0)
    })
})
