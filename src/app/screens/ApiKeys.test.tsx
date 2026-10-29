import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { TeamStationClient } from '../../common/api'
import type { ApiKey } from '../../common/apiKeys'
import { ThemeProvider } from '../theme/ThemeContext'
import { ApiKeysSection } from './ApiKeysSection'
import { NewApiKeyScreen, togglePermission } from './NewApiKeyScreen'

/**
 * Account's API keys section and the Create API key screen, against a fake
 * server holding the account's keys.
 */
let root: Root | undefined
const delay = async (): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, 15))
}
const text = (): string => document.body.textContent ?? ''
const byLabel = (label: string): HTMLElement | undefined =>
  [...document.querySelectorAll<HTMLElement>('[aria-label]')].find(
    node => node.getAttribute('aria-label') === label
  )
const button = (label: string): HTMLElement | undefined =>
  [...document.querySelectorAll<HTMLElement>('[role="button"]')].find(
    node => (node.getAttribute('aria-label') ?? node.textContent) === label
  ) ?? byLabel(label)
async function press(label: string): Promise<void> {
  const node = button(label)
  expect(node, label).not.equals(undefined)
  await act(async () => {
    node!.click()
    await delay()
  })
}
async function change(label: string, value: string): Promise<void> {
  const input = document.querySelector<HTMLInputElement>(
    `input[aria-label="${label}"]`
  )
  expect(input, label).not.equals(null)
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )!.set!.call(input, value)
    input!.dispatchEvent(new window.Event('input', { bubbles: true }))
    await delay()
  })
}
const checked = (label: string): boolean =>
  byLabel(label)?.getAttribute('aria-checked') === 'true'
const disabled = (label: string): boolean =>
  button(label)?.getAttribute('aria-disabled') === 'true'

async function render(element: React.ReactElement): Promise<void> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<ThemeProvider>{element}</ThemeProvider>)
    await delay()
  })
}

function server(initial: ApiKey[] = []): {
  client: TeamStationClient
  keys: ApiKey[]
  calls: Array<{ method: string; route: string; body?: unknown }>
  controls: { fail: string; hold?: Promise<void> }
} {
  const keys = [...initial]
  const calls: Array<{ method: string; route: string; body?: unknown }> = []
  const controls: { fail: string; hold?: Promise<void> } = { fail: '' }
  const fetcher: typeof fetch = async (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url
    const route = url.replace('/api/v1', '')
    const method = init?.method ?? 'GET'
    const body =
      typeof init?.body === 'string'
        ? (JSON.parse(init.body) as unknown)
        : undefined
    calls.push({ method, route, body })
    await controls.hold
    if (controls.fail === `${method} ${route}`)
      return new Response(
        JSON.stringify({
          code: 'conflict',
          message: 'An account may hold 20 API keys'
        }),
        { status: 409 }
      )
    if (method === 'GET' && route === '/me/api-keys')
      return new Response(JSON.stringify({ keys }))
    if (method === 'POST' && route === '/me/api-keys') {
      const made: ApiKey = {
        id: `uak_${keys.length + 1}`,
        name: (body as { name: string }).name,
        secret: `tsk_secret${keys.length + 1}xyz`,
        createdAt: '2026-10-28T00:00:00.000Z',
        permissions: (body as { permissions: ApiKey['permissions'] })
          .permissions
      }
      keys.push(made)
      return new Response(JSON.stringify(made), { status: 201 })
    }
    if (method === 'DELETE' && route.startsWith('/me/api-keys/')) {
      const at = keys.findIndex(key => route.endsWith(key.id))
      keys.splice(at, 1)
      return new Response(null, { status: 204 })
    }
    return new Response('{}', { status: 404 })
  }
  return {
    client: new TeamStationClient({ baseUrl: '/api/v1', fetch: fetcher }),
    keys,
    calls,
    controls
  }
}

const agentKey: ApiKey = {
  id: 'uak_agent',
  name: 'Agent',
  secret: 'tsk_AbCdEfGhIjKlMnOp',
  createdAt: '2026-10-27T00:00:00.000Z',
  permissions: ['schedule:read']
}

afterEach(async () => {
  await act(async () => {
    root?.unmount()
    root = undefined
  })
  document.body.replaceChildren()
})

describe('API key permissions on Create API key', () => {
  it('checks read with write, clears both with read, and leaves read when write goes', () => {
    expect(togglePermission([], 'schedule', 'write')).deep.equals([
      'schedule:read',
      'schedule:write'
    ])
    expect(
      togglePermission(['schedule:read', 'schedule:write'], 'schedule', 'read')
    ).deep.equals([])
    expect(
      togglePermission(['schedule:read', 'schedule:write'], 'schedule', 'write')
    ).deep.equals(['schedule:read'])
    expect(togglePermission([], 'team', 'read')).deep.equals(['team:read'])
    expect(togglePermission(['account:read'], 'team', 'write')).deep.equals([
      'account:read',
      'team:read',
      'team:write'
    ])
  })
})

describe('Account’s API keys', () => {
  it('shows only Create API key, with its chevron, when there are none', async () => {
    const { client } = server()
    let created = 0
    await render(
      <ApiKeysSection
        client={client}
        onCreate={() => {
          created++
        }}
      />
    )
    expect(text()).includes('API KEYS')
    expect(text()).includes('Create API key')
    expect(text()).includes('key')
    expect(text()).includes('chevron_right')
    expect(text()).not.includes('Delete')
    await press('Create API key')
    expect(created).equals(1)
  })

  it('lists a key by name and its first eight characters, copies it, and keeps Create below', async () => {
    const { client } = server([agentKey])
    const copied: string[] = []
    await render(
      <ApiKeysSection
        client={client}
        onCreate={() => undefined}
        copy={value => {
          copied.push(value)
        }}
      />
    )
    expect(text()).includes('Agent')
    expect(text()).includes('tsk_AbCd…')
    expect(text()).not.includes('tsk_AbCdE')
    expect(text().indexOf('Agent')).lessThan(text().indexOf('Create API key'))
    expect(button('Delete Agent')).not.equals(undefined)
    await press('Copy Agent')
    expect(copied).deep.equals(['tsk_AbCdEfGhIjKlMnOp'])
    expect(text()).includes('Copied the secret of Agent')
  })

  it('deletes a key only once the sheet is confirmed', async () => {
    const { client, keys, calls } = server([agentKey])
    await render(<ApiKeysSection client={client} copy={() => undefined} />)
    await press('Copy Agent')
    await press('Delete Agent')
    expect(text()).includes('Delete Agent?')
    expect(text()).includes('Anything using this key stops working.')
    await press('Cancel')
    expect(text()).not.includes('Delete Agent?')
    expect(keys).has.length(1)
    expect(calls.filter(call => call.method === 'DELETE')).deep.equals([])
    await press('Delete Agent')
    const sheetDelete = [
      ...document.querySelectorAll<HTMLElement>('[role="button"]')
    ].filter(node => node.textContent === 'Delete')
    await act(async () => {
      sheetDelete[sheetDelete.length - 1].click()
      await delay()
    })
    expect(keys).deep.equals([])
    expect(text()).not.includes('Agent')
    expect(text()).not.includes('Copied')
    expect(calls.filter(call => call.method === 'DELETE')).deep.equals([
      { method: 'DELETE', route: '/me/api-keys/uak_agent', body: undefined }
    ])
  })

  it('says when the keys cannot be read, and cannot copy a key the server cannot open', async () => {
    const failing = server()
    failing.controls.fail = 'GET /me/api-keys'
    await render(<ApiKeysSection client={failing.client} />)
    expect(text()).includes('An account may hold 20 API keys')
    await act(async () => {
      root?.unmount()
      root = undefined
    })
    const { client } = server([{ ...agentKey, secret: null }])
    const copied: string[] = []
    await render(
      <ApiKeysSection
        client={client}
        copy={value => {
          copied.push(value)
        }}
      />
    )
    expect(text()).includes('Cannot be shown')
    await press('Copy Agent')
    expect(copied).deep.equals([])
  })
})

describe('Create API key', () => {
  it('shows the name, R and W, and seven rows, three with subtext, and starts disabled', async () => {
    const { client } = server()
    await render(
      <NewApiKeyScreen client={client} onCreated={() => undefined} />
    )
    expect(document.querySelector('input[aria-label="Name"]')).not.equals(null)
    for (const title of [
      'Account settings',
      'Game events',
      'Schedule',
      'League details',
      'Season details',
      'Team details',
      'Umpire management'
    ]) {
      expect(byLabel(`${title} read`), title).not.equals(undefined)
      expect(byLabel(`${title} write`), title).not.equals(undefined)
    }
    for (const subtext of [
      'Name, email, photo, and memberships',
      'Scoring, roster, stats, and RSVPs',
      'View and create games and events'
    ])
      expect(text()).includes(subtext)
    expect(text()).includes('R')
    expect(text()).includes('W')
    expect(disabled('Create API key')).equals(true)
  })

  it('toggles the circles by the rules, and enables the pill only with a name and a circle', async () => {
    const { client } = server()
    await render(
      <NewApiKeyScreen client={client} onCreated={() => undefined} />
    )
    await press('Schedule write')
    expect(checked('Schedule write')).equals(true)
    expect(checked('Schedule read')).equals(true)
    expect(disabled('Create API key')).equals(true)
    await change('Name', '   ')
    expect(disabled('Create API key')).equals(true)
    await change('Name', 'Agent')
    expect(disabled('Create API key')).equals(false)
    await press('Schedule write')
    expect(checked('Schedule write')).equals(false)
    expect(checked('Schedule read')).equals(true)
    await press('Schedule write')
    await press('Schedule read')
    expect(checked('Schedule write')).equals(false)
    expect(checked('Schedule read')).equals(false)
    expect(disabled('Create API key')).equals(true)
  })

  it('makes the key from the pill, and returns to Account', async () => {
    const { client, calls, keys, controls } = server()
    let returned = 0
    await render(
      <NewApiKeyScreen
        client={client}
        onCreated={() => {
          returned++
        }}
      />
    )
    await change('Name', '  Agent  ')
    await press('Game events write')
    let release = (): void => undefined
    controls.hold = new Promise<void>(resolve => {
      release = resolve
    })
    await press('Create API key')
    // In flight: the pill waits.
    expect(
      document
        .querySelector('[data-testid="create-api-key"]')
        ?.getAttribute('aria-disabled')
    ).equals('true')
    await act(async () => {
      release()
      await delay()
    })
    expect(returned).equals(1)
    expect(keys.map(key => key.name)).deep.equals(['Agent'])
    expect(calls.filter(call => call.method === 'POST')).deep.equals([
      {
        method: 'POST',
        route: '/me/api-keys',
        body: {
          name: 'Agent',
          permissions: ['gameEvents:read', 'gameEvents:write']
        }
      }
    ])
  })

  it('stays, and says why, when the key cannot be made', async () => {
    const { client, controls } = server()
    controls.fail = 'POST /me/api-keys'
    let returned = 0
    await render(
      <NewApiKeyScreen
        client={client}
        onCreated={() => {
          returned++
        }}
      />
    )
    await change('Name', 'Agent')
    await press('Team details read')
    await press('Create API key')
    expect(returned).equals(0)
    expect(text()).includes('An account may hold 20 API keys')
    expect(disabled('Create API key')).equals(false)
  })
})
