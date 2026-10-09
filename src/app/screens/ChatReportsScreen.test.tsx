import { expect } from 'chai'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { ChatReport } from '../../common/api'
import { HttpError } from '../../common/errors'
import { App } from '../App'
import { currentRoute, showRoute } from '../navigation/useAddressBar'
import { ThemeProvider } from '../theme/ThemeContext'
import { ChatReportsScreen, disclosed } from './ChatReportsScreen'

/** U14: the site administrators' view of reported chat messages. */
let root: Root | undefined

const delay = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

const text = (): string => document.body.textContent ?? ''

async function render(element: React.ReactElement): Promise<void> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<ThemeProvider>{element}</ThemeProvider>)
    await delay(20)
  })
}

async function until(what: string, check: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (check()) return
    await act(async () => {
      await delay(20)
    })
  }
  throw new Error(`Timed out waiting for ${what}`)
}

function button(label: string): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('[role="button"]')].find(
    node =>
      (node.getAttribute('aria-label') ?? '') === label ||
      (node.getAttribute('aria-label') == null &&
        (node.textContent ?? '').endsWith(label))
  )
}

async function press(label: string, nth = 0): Promise<void> {
  const found = [
    ...document.querySelectorAll<HTMLElement>('[role="button"], [role="tab"]')
  ].filter(
    node =>
      (node.getAttribute('aria-label') ?? '') === label ||
      (node.textContent ?? '').endsWith(label)
  )[nth]
  expect(found, label).not.equals(undefined)
  await act(async () => {
    found.click()
    await delay(20)
  })
}

afterEach(async function () {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  document.body.innerHTML = ''
})

const report = (over: Partial<ChatReport> = {}): ChatReport => ({
  id: 'crp_1',
  conversation: { id: 'cnv_1', kind: 'teamMembers', title: 'Hawks Members' },
  messageId: 'msg_1',
  reporter: { userId: 2, shortName: 'Blair B' },
  sender: { userId: 3, shortName: 'Casey C' },
  kind: 'post',
  sentAt: '2027-04-10T12:00:00.000Z',
  plaintext: JSON.stringify({
    type: 'text',
    body: 'second from C',
    mentions: [],
    attachments: []
  }),
  verified: true,
  createdAt: '2027-04-10T12:05:00.000Z',
  resolvedAt: null,
  ...over
})

/** 32 zero bytes, base64url, as an attachment's key and digest. */
const KEY32 = 'A'.repeat(43)

/** A client holding `reports`, resolving them in place. */
class FakeReports {
  calls: string[] = []
  failLoad: Error | undefined = undefined
  failResolve = false
  constructor(public reports: ChatReport[]) {}

  async chatReports(open = false): Promise<ChatReport[]> {
    this.calls.push(`list ${open}`)
    if (this.failLoad != null) throw this.failLoad
    return this.reports.filter(item => !open || item.resolvedAt == null)
  }

  async resolveChatReport(reportId: string): Promise<ChatReport> {
    this.calls.push(`resolve ${reportId}`)
    if (this.failResolve) throw new HttpError('conflict', 'no')
    const resolved = this.reports.find(item => item.id === reportId)!
    resolved.resolvedAt = '2027-04-10T13:00:00.000Z'
    return { ...resolved }
  }
}

describe('reported chat messages (site administrators)', function () {
  this.timeout(10000)

  it('shows verified and unverified reports, and resolves one', async function () {
    const client = new FakeReports([
      report(),
      report({
        id: 'crp_2',
        conversation: { id: 'cnv_2', kind: 'dm', title: null },
        sender: { userId: 4, shortName: 'Dana D' },
        plaintext: 'made-up words',
        verified: false
      }),
      report({
        id: 'crp_3',
        resolvedAt: '2027-04-10T12:30:00.000Z',
        plaintext: JSON.stringify({
          type: 'text',
          body: 'already handled',
          mentions: [],
          attachments: []
        })
      })
    ])
    await render(<ChatReportsScreen client={client} isAdmin />)
    await until('the reports', () => text().includes('second from C'))
    expect(client.calls).deep.equals(['list true'])
    expect(text()).contains('From Casey C in Hawks Members')
    expect(text()).contains('verified')
    expect(text()).contains('The sender’s signature and the disclosed key')
    expect(text()).contains('From Dana D in a direct message')
    expect(text()).contains('made-up words')
    expect(text()).contains('not verified')
    expect(text()).contains('treat it as unproven')
    expect(text()).contains('Reported by Blair B')
    expect(text()).not.contains('already handled')

    await press('Resolve')
    await until('the resolve', () => !text().includes('second from C'))
    expect(client.calls).includes('resolve crp_1')
    expect(text()).contains('made-up words')

    await press('All')
    await until('every report', () => text().includes('already handled'))
    expect(client.calls).includes('list false')
    expect(text()).contains('second from C')
    expect(text()).contains('Resolved')

    client.failResolve = true
    await press('Resolve')
    await until('the failure', () =>
      text().includes('That report could not be resolved')
    )
    expect(text()).contains('made-up words')

    // Resolving in All keeps the report, marked resolved.
    client.failResolve = false
    await press('Resolve')
    await until('the report kept and resolved', () => button('Resolve') == null)
    expect(text()).contains('made-up words')
  })

  it('says when there is nothing, or the list will not load', async function () {
    const client = new FakeReports([])
    await render(<ChatReportsScreen client={client} isAdmin />)
    await until('nothing open', () => text().includes('No open reports.'))
    await press('All')
    await until('nothing at all', () =>
      text().includes('Nothing has been reported.')
    )
    await act(async () => {
      root?.unmount()
    })

    client.failLoad = new Error('offline')
    await render(<ChatReportsScreen client={client} isAdmin />)
    await until('the failure', () =>
      text().includes('The reports could not be loaded.')
    )
  })

  it('is not found for anyone but a site administrator', async function () {
    const client = new FakeReports([report()])
    await render(<ChatReportsScreen client={client} isAdmin={false} />)
    expect(text()).contains('There is nothing here.')
    expect(client.calls).deep.equals([])
    await act(async () => {
      root?.unmount()
    })

    // The server's own refusal reads the same.
    client.failLoad = new HttpError('forbidden', 'Administrators only')
    await render(<ChatReportsScreen client={client} isAdmin />)
    await until('not found', () => text().includes('There is nothing here.'))
    expect(text()).not.contains('second from C')
  })

  it('shows a post’s words and its attachments, and anything else as sent', function () {
    expect(disclosed(report())).equals('second from C')
    expect(
      disclosed({
        plaintext: JSON.stringify({
          type: 'text',
          body: 'look',
          mentions: [],
          attachments: [
            {
              id: 'cat_1',
              key: KEY32,
              digest: KEY32,
              size: 3,
              contentType: 'image/jpeg',
              fileName: 'a.jpg'
            }
          ]
        })
      })
    ).equals('look\n1 attachment')
    expect(
      disclosed({
        plaintext: JSON.stringify({
          type: 'text',
          body: '',
          mentions: [],
          attachments: ['cat_1', 'cat_2'].map(id => ({
            id,
            key: KEY32,
            digest: KEY32,
            size: 3,
            contentType: 'image/jpeg',
            fileName: 'a.jpg'
          }))
        })
      })
    ).equals('2 attachments')
    const reaction = JSON.stringify({
      type: 'reaction',
      targetId: 'msg_1',
      emoji: '👍',
      remove: false
    })
    expect(disclosed({ plaintext: reaction })).equals(reaction)
    expect(disclosed({ plaintext: '{not json' })).equals('{not json')
  })
})

describe('reported chat messages in the app', function () {
  this.timeout(15000)
  const originalFetch = globalThis.fetch
  const heldIndexedDB = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB')

  afterEach(function () {
    globalThis.fetch = originalFetch
    if (heldIndexedDB == null) {
      delete (globalThis as { indexedDB?: unknown }).indexedDB
    } else Object.defineProperty(globalThis, 'indexedDB', heldIndexedDB)
  })

  /** The API as a signed-in user, a site administrator or not. */
  function fakeApi(isAdmin: boolean): string[] {
    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true,
      value: new IDBFactory()
    })
    const asked: string[] = []
    globalThis.fetch = async (input, init) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url
      const path = url.split('?')[0].replace(/^.*\/api\/v1/, '')
      asked.push(`${init?.method ?? 'GET'} ${path}`)
      if (path === '/auth/me') {
        return Response.json({ id: 9, displayName: 'Zed Z', isAdmin })
      }
      if (path === '/me/roles') return Response.json({ teams: {} })
      if (path === '/admin/chat/reports') {
        return isAdmin
          ? Response.json([report()])
          : Response.json(
              new HttpError('forbidden', 'Administrators only').toApiError(),
              { status: 403 }
            )
      }
      return Response.json([])
    }
    return asked
  }

  it('opens at /admin/chat/reports for a site administrator, and from the account screen', async function () {
    fakeApi(true)
    showRoute({ name: 'chatReports' }, true)
    await render(<App />)
    await until('the report', () => text().includes('second from C'))
    expect(currentRoute()).deep.equals({ name: 'chatReports' })
    expect(text()).contains('Reported messages')
    await act(async () => {
      root?.unmount()
    })

    showRoute({ name: 'account' }, true)
    await render(<App />)
    await until('the account', () => text().includes('Sign out'))
    await press(
      'Reported messages, Chat messages people reported, for site administrators'
    )
    await until('the report', () => text().includes('second from C'))
    expect(currentRoute()).deep.equals({ name: 'chatReports' })
  })

  it('is not found for anyone else, who has no row for it either', async function () {
    const asked = fakeApi(false)
    showRoute({ name: 'chatReports' }, true)
    await render(<App />)
    await until('not found', () => text().includes('There is nothing here.'))
    expect(asked).not.includes('GET /admin/chat/reports')
    await act(async () => {
      root?.unmount()
    })

    showRoute({ name: 'account' }, true)
    await render(<App />)
    await until('the account', () => text().includes('Sign out'))
    expect(text()).not.contains('Reported messages')
  })
})
