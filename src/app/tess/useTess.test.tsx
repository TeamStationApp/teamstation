import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'

import {
  byLabel,
  byTestId,
  click,
  type ManualClock,
  manualClock,
  render,
  settle,
  unmount
} from '../../test/tessTestKit'
import { TessChat } from './TessChat'
import type {
  TessApi,
  TessChange,
  TessConversation,
  TessMessage,
  TessScreen
} from './tessTypes'
import { type TessChatState, useTess } from './useTess'

let clock: ManualClock | undefined

/** A promise the test settles when it chooses. */
interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}
function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined
  let reject: (error: unknown) => void = () => undefined
  const promise = new Promise<T>((_resolve, _reject) => {
    resolve = _resolve
    reject = _reject
  })
  return { promise, resolve, reject }
}

const CHANGE: TessChange = {
  id: 'c1',
  summary: 'Add a game against Demo Eagles on Saturday at 10',
  method: 'POST',
  path: '/teams/t1/games',
  body: { opponent: 'Demo Eagles' },
  status: 'pending'
}

function message(
  id: string,
  role: 'user' | 'assistant',
  text: string,
  extra: Partial<TessMessage> = {}
): TessMessage {
  return {
    id,
    role,
    text,
    attachments: [],
    changes: [],
    createdAt: '2026-05-02T10:00:00.000Z',
    ...extra
  }
}

const HISTORY: TessMessage[] = [
  message('1', 'user', 'Chart these', {
    attachments: [
      { id: 'a1', name: 'runs.csv', kind: 'csv', described: false },
      { id: 'a2', name: 'photo.png', kind: 'image', described: true }
    ]
  }),
  message('2', 'assistant', 'See [Comets](/teams/t1).', { changes: [CHANGE] })
]

class FakeTess implements TessApi {
  loads: Array<Deferred<TessConversation>> = []
  sends: Array<{
    request: { text: string } & Parameters<TessApi['sendTessMessage']>[1]
    answer: Deferred<TessMessage[]>
  }> = []

  confirms: Array<{
    id: string
    answer: Deferred<{ change: TessChange; messages: TessMessage[] }>
  }> = []

  uploads: Array<Deferred<{ id: string; name: string; kind: 'csv' }>> = []

  async tess(): Promise<TessConversation> {
    const answer = deferred<TessConversation>()
    this.loads.push(answer)
    return await answer.promise
  }

  async sendTessMessage(
    text: string,
    options: Parameters<TessApi['sendTessMessage']>[1] = {}
  ): Promise<TessMessage[]> {
    const answer = deferred<TessMessage[]>()
    this.sends.push({ request: { text, ...options }, answer })
    return await answer.promise
  }

  async uploadTessAttachment(): Promise<{
    id: string
    name: string
    kind: 'csv'
  }> {
    const answer = deferred<{ id: string; name: string; kind: 'csv' }>()
    this.uploads.push(answer)
    return await answer.promise
  }

  async confirmTessChange(
    id: string
  ): Promise<{ change: TessChange; messages: TessMessage[] }> {
    const answer = deferred<{ change: TessChange; messages: TessMessage[] }>()
    this.confirms.push({ id, answer })
    return await answer.promise
  }

  async tessUsage(): Promise<[]> {
    return []
  }
}

let latest: TessChatState | undefined
function Harness({
  api,
  screen,
  onNavigate = () => undefined,
  onClose = () => undefined
}: {
  api: TessApi
  screen?: () => TessScreen | undefined
  onNavigate?: (path: string) => void
  onClose?: () => void
}): React.ReactElement {
  const tess = useTess(api, { screen })
  latest = tess
  return <TessChat tess={tess} onClose={onClose} onNavigate={onNavigate} />
}

async function loaded(
  api: FakeTess,
  messages: TessMessage[] = HISTORY
): Promise<void> {
  await act(async () => {
    api.loads[0].resolve({ available: true, messages, contextTokens: 10 })
  })
  await settle()
}

async function type(value: string): Promise<void> {
  const field = byLabel('Ask Tess') as HTMLTextAreaElement
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      'value'
    )!.set!.call(field, value)
    field.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
  await act(async () => {
    field.dispatchEvent(
      new window.KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true
      })
    )
  })
  await settle()
}

function texts(id: string): string[] {
  return [...document.body.querySelectorAll(`[data-testid="${id}"]`)].map(
    node => node.textContent ?? ''
  )
}

async function hold(): Promise<void> {
  await act(async () => {
    byLabel('Hold to confirm').dispatchEvent(
      new window.MouseEvent('mousedown', { bubbles: true })
    )
    await new Promise(resolve => setTimeout(resolve, 80))
  })
  await clock!.advance(3000)
  await act(async () => {
    byLabel('Confirming…').dispatchEvent(
      new window.MouseEvent('mouseup', { bubbles: true })
    )
  })
}

describe('useTess and the chat', function () {
  afterEach(async () => {
    await unmount()
    clock?.restore()
    clock = undefined
  })

  it('loads the conversation: bubbles, attachments, the reply and its card', async function () {
    const api = new FakeTess()
    const navigated: string[] = []
    let closed = 0
    await render(
      <Harness
        api={api}
        onNavigate={path => navigated.push(path)}
        onClose={() => closed++}
      />
    )
    expect(document.body.querySelector('[role="progressbar"]')).not.equals(null)
    await loaded(api)
    expect(document.body.querySelector('[role="progressbar"]')).equals(null)
    expect(texts('Tess user message')).deep.equals([
      'attach_fileruns.csvattach_filephoto.png (described)Chart these'
    ])
    expect(texts('Tess reply')[0]).includes('See Comets.')
    expect(texts('Tess change request')).deep.equals(['POST /teams/t1/games'])
    await click(
      [...document.body.querySelectorAll<HTMLElement>('[role="link"]')].find(
        node => node.textContent === 'Comets'
      )!
    )
    expect(navigated).deep.equals(['/teams/t1'])
    await click(byLabel('Close Tess'))
    expect(closed).equals(1)
  })

  it('invites a first question in an empty conversation', async function () {
    const api = new FakeTess()
    await render(<Harness api={api} />)
    await loaded(api, [])
    expect(document.body.textContent).includes(
      'Ask Tess where to find something in TeamStation'
    )
  })

  it('shows a failed load under the composer', async function () {
    const api = new FakeTess()
    await render(<Harness api={api} />)
    await act(async () => {
      api.loads[0].reject(new Error('Tess is not available.'))
    })
    await settle()
    expect(byTestId('Tess error')!.textContent).equals('Tess is not available.')
  })

  it('shows a sent message at once with a thinking row, then the answer', async function () {
    const api = new FakeTess()
    const screen: TessScreen = {
      path: '/teams/t1',
      title: 'Comets',
      stack: [{ path: '/', title: 'Home' }]
    }
    await render(<Harness api={api} screen={() => screen} />)
    await loaded(api)
    await type('Where are my team settings?')
    expect(texts('Tess user message').at(-1)).equals(
      'Where are my team settings?'
    )
    expect(byTestId('Tess thinking')!.textContent).equals('Tess is thinking…')
    expect(api.sends[0].request).deep.equals({
      text: 'Where are my team settings?',
      screen
    })
    await act(async () => {
      api.sends[0].answer.resolve([
        message('3', 'user', 'Where are my team settings?'),
        message(
          '4',
          'assistant',
          '[Home › Comets › Settings](/groups/team/t1/settings "path")'
        )
      ])
    })
    await settle()
    expect(byTestId('Tess thinking')).equals(null)
    expect(texts('Tess user message').length).equals(2)
    expect(texts('Tess way')).deep.equals([
      'Homechevron_rightCometschevron_rightSettingschevron_right'
    ])
  })

  it('takes a failed message back, says why, and returns the draft', async function () {
    const api = new FakeTess()
    await render(<Harness api={api} />)
    await loaded(api)
    await type('Add a game')
    expect(texts('Tess user message').length).equals(2)
    await act(async () => {
      api.sends[0].answer.reject('offline')
    })
    await settle()
    expect(texts('Tess user message').length).equals(1)
    expect(byTestId('Tess error')!.textContent).equals(
      'Tess could not answer. Please try again.'
    )
    expect((byLabel('Ask Tess') as HTMLTextAreaElement).value).equals(
      'Add a game'
    )
    expect(byTestId('Tess thinking')).equals(null)
  })

  it('sends one message at a time, with the attachment ids', async function () {
    const api = new FakeTess()
    await render(<Harness api={api} />)
    await loaded(api)
    const attachment = {
      id: 'a9',
      name: 'runs.csv',
      kind: 'csv' as const,
      described: false
    }
    let first: Promise<boolean> | undefined
    let second: boolean | undefined
    await act(async () => {
      first = latest!.send('Chart these', [attachment])
      second = await latest!.send('And these', [])
    })
    expect(second).equals(false)
    expect(api.sends.map(send => send.request)).deep.equals([
      { text: 'Chart these', attachmentIds: ['a9'] }
    ])
    await act(async () => {
      api.sends[0].answer.resolve([])
      expect(await first).equals(true)
    })
  })

  it('uploads a file, and shows why when it is refused', async function () {
    const api = new FakeTess()
    await render(<Harness api={api} />)
    await loaded(api)
    let stored: unknown
    await act(async () => {
      const upload = latest!.upload({
        name: 'runs.csv',
        mediaType: 'text/csv',
        data: 'YQ=='
      })
      api.uploads[0].resolve({ id: 'a1', name: 'runs.csv', kind: 'csv' })
      stored = await upload
    })
    expect(stored).deep.equals({
      id: 'a1',
      name: 'runs.csv',
      kind: 'csv',
      described: false
    })
    await act(async () => {
      const upload = latest!.upload({
        name: 'big.csv',
        mediaType: 'text/csv',
        data: 'YQ=='
      })
      api.uploads[1].reject(new Error('That attachment is too large.'))
      stored = await upload
    })
    expect(stored).equals(null)
    expect(byTestId('Tess error')!.textContent).equals(
      'That attachment is too large.'
    )
    await act(async () => {
      latest!.showError('That file could not be read.')
    })
    expect(byTestId('Tess error')!.textContent).equals(
      'That file could not be read.'
    )
  })

  it('confirms a held change: Confirming…, then Done and the follow-up', async function () {
    const api = new FakeTess()
    clock = manualClock()
    await render(<Harness api={api} />)
    await loaded(api)
    await hold()
    expect(api.confirms.map(confirm => confirm.id)).deep.equals(['c1'])
    expect(byLabel('Confirming…').getAttribute('aria-disabled')).equals('true')
    expect(byTestId('Tess thinking')).not.equals(null)
    await act(async () => {
      api.confirms[0].answer.resolve({
        change: { ...CHANGE, status: 'done' },
        messages: [message('5', 'assistant', 'The game is on the schedule.')]
      })
    })
    await settle()
    expect(texts('Tess change status')).deep.equals(['Done'])
    expect(texts('Tess reply').at(-1)).includes('The game is on the schedule.')
    expect(byTestId('Tess thinking')).equals(null)
  })

  it('after a failed confirm shows what the server says, or lets the user hold again', async function () {
    const api = new FakeTess()
    clock = manualClock()
    await render(<Harness api={api} />)
    await loaded(api)
    await hold()
    await act(async () => {
      api.confirms[0].answer.reject(new Error('That change has expired.'))
    })
    await act(async () => {
      api.loads[1].resolve({
        available: true,
        messages: [
          HISTORY[0],
          { ...HISTORY[1], changes: [{ ...CHANGE, status: 'expired' }] }
        ],
        contextTokens: 10
      })
    })
    await settle()
    expect(byTestId('Tess error')!.textContent).equals(
      'That change has expired.'
    )
    expect(texts('Tess change status')).deep.equals(['Expired'])

    await unmount()
    const offline = new FakeTess()
    await render(<Harness api={offline} />)
    await loaded(offline)
    await hold()
    await act(async () => {
      offline.confirms[0].answer.reject(new Error('Network down'))
    })
    await act(async () => {
      offline.loads[1].reject(new Error('Network down'))
    })
    await settle()
    expect(byLabel('Hold to confirm')).not.equals(null)
  })

  it('ignores answers that arrive after the chat has closed', async function () {
    const api = new FakeTess()
    clock = manualClock()
    await render(<Harness api={api} />)
    await loaded(api)
    await type('Add a game')
    await hold()
    let upload: Promise<unknown> | undefined
    await act(async () => {
      upload = latest!.upload({
        name: 'a.csv',
        mediaType: 'text/csv',
        data: ''
      })
    })
    await unmount()
    api.sends[0].answer.resolve([])
    api.confirms[0].answer.reject(new Error('gone'))
    api.uploads[0].reject(new Error('gone'))
    expect(await upload).equals(null)
    await settle()

    const failing = new FakeTess()
    await render(<Harness api={failing} />)
    await unmount()
    failing.loads[0].reject(new Error('gone'))
    const late = new FakeTess()
    await render(<Harness api={late} />)
    await unmount()
    late.loads[0].resolve({ available: true, messages: [], contextTokens: 0 })
    await settle()

    const rejecting = new FakeTess()
    await render(<Harness api={rejecting} />)
    await loaded(rejecting)
    await type('Add a game')
    await unmount()
    rejecting.sends[0].answer.reject(new Error('gone'))
    await settle()

    const confirming = new FakeTess()
    await render(<Harness api={confirming} />)
    await loaded(confirming)
    await hold()
    await unmount()
    confirming.confirms[0].answer.resolve({
      change: { ...CHANGE, status: 'done' },
      messages: []
    })
    await settle()

    const refetching = new FakeTess()
    await render(<Harness api={refetching} />)
    await loaded(refetching)
    await hold()
    await act(async () => {
      refetching.confirms[0].answer.reject(new Error('busy'))
    })
    await unmount()
    refetching.loads[1].resolve({
      available: true,
      messages: [],
      contextTokens: 0
    })
    await settle()
  })
})
