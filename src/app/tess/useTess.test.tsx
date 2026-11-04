import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'

import { TessTurnError } from '../../common/api'
import { HttpError } from '../../common/errors'
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
import { STOP_GUARD_MS } from './Composer'
import { HOLD_MS } from './HoldToConfirm'
import { TessChat } from './TessChat'
import { forgetQueues } from './tessQueue'
import type {
  TessApi,
  TessChange,
  TessConversation,
  TessMessage,
  TessScreen,
  TessStreamEvent
} from './tessTypes'
import { ANSWERING_POLL_MS, type TessChatState, useTess } from './useTess'

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
    request: { text: string } & Parameters<TessApi['streamTessMessage']>[1]
    answer: Deferred<TessMessage[]>
    tell: (event: TessStreamEvent) => void
  }> = []

  confirms: Array<{
    ids: string[]
    clientId?: string
    answer: Deferred<{ changes: TessChange[]; messages: TessMessage[] }>
    tell: (event: TessStreamEvent) => void
  }> = []

  /** The client ids each stop named, in order. */
  stops: string[] = []
  stopFails = false

  uploads: Array<Deferred<{ id: string; name: string; kind: 'csv' }>> = []

  async tess(): Promise<TessConversation> {
    const answer = deferred<TessConversation>()
    this.loads.push(answer)
    return await answer.promise
  }

  async streamTessMessage(
    text: string,
    options: Parameters<TessApi['streamTessMessage']>[1],
    tell: (event: TessStreamEvent) => void
  ): Promise<TessMessage[]> {
    const answer = deferred<TessMessage[]>()
    this.sends.push({ request: { text, ...options }, answer, tell })
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

  async streamTessConfirmAll(
    ids: string[],
    tell: (event: TessStreamEvent) => void,
    options: { clientId?: string } = {}
  ): Promise<{ changes: TessChange[]; messages: TessMessage[] }> {
    const answer = deferred<{
      changes: TessChange[]
      messages: TessMessage[]
    }>()
    this.confirms.push({ ids, clientId: options.clientId, answer, tell })
    return await answer.promise
  }

  async stopTess(clientId: string): Promise<void> {
    this.stops.push(clientId)
    if (this.stopFails)
      throw new HttpError('offline', 'Cannot reach TeamStation.')
  }

  async tessUsage(): Promise<[]> {
    return []
  }
}

let latest: TessChatState | undefined
function Harness({
  api,
  screen,
  owner,
  onNavigate = () => undefined,
  onClose = () => undefined
}: {
  api: TessApi
  screen?: () => TessScreen | undefined
  owner?: string
  onNavigate?: (path: string) => void
  onClose?: () => void
}): React.ReactElement {
  const tess = useTess(api, { screen, owner })
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
  await clock!.advance(HOLD_MS)
  await act(async () => {
    byLabel('Confirming…').dispatchEvent(
      new window.MouseEvent('mouseup', { bubbles: true })
    )
  })
}

describe('useTess and the chat', function () {
  afterEach(async () => {
    await unmount()
    forgetQueues()
    clock?.restore()
    clock = undefined
  })

  it('loads the conversation: bubbles, attachments, the reply and its changes', async function () {
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
    expect(texts('Tess change')).deep.equals([CHANGE.summary])
    // The request is folded away.
    expect(texts('Tess change request')).deep.equals([])
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
    const { clientId } = api.sends[0].request
    expect(clientId).match(/^[A-Za-z0-9_-]{1,64}$/)
    expect(api.sends[0].request).deep.equals({
      text: 'Where are my team settings?',
      screen,
      clientId
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

  it('shows the changes before a message as expired once it is answered, and keeps the new one', async function () {
    const api = new FakeTess()
    await render(<Harness api={api} />)
    await loaded(api)
    const holds = (): number =>
      document.body.querySelectorAll('[aria-label="Hold to confirm"]').length
    expect(holds()).equals(1)
    await type('Yes, do it')
    // Still on hold while the message is out: it may fail.
    expect(holds()).equals(1)
    const next: TessChange = {
      ...CHANGE,
      id: 'c2',
      summary: 'Add a game against Demo Eagles on Sunday at 10'
    }
    await act(async () => {
      api.sends[0].answer.resolve([
        message('3', 'user', 'Yes, do it'),
        message('4', 'assistant', 'Hold Confirm for Sunday instead.', {
          changes: [next]
        })
      ])
    })
    await settle()
    const batches = [
      ...document.body.querySelectorAll<HTMLElement>(
        '[data-testid="Tess changes"]'
      )
    ]
    expect(batches.length).equals(2)
    expect(texts('Tess change status')).deep.equals(['Expired'])
    expect(batches[0].textContent).includes('Expired')
    expect(batches[0].querySelector('[aria-label="Hold to confirm"]')).equals(
      null
    )
    expect(
      batches[1].querySelector('[aria-label="Hold to confirm"]')
    ).not.equals(null)
    expect(holds()).equals(1)
  })

  it('leaves the changes on hold when a message fails', async function () {
    const api = new FakeTess()
    await render(<Harness api={api} />)
    await loaded(api)
    await type('Yes, do it')
    await act(async () => {
      api.sends[0].answer.reject(new Error('Tess could not answer.'))
    })
    await act(async () => {
      api.loads[1].resolve({
        available: true,
        messages: HISTORY,
        contextTokens: 10
      })
    })
    await settle()
    expect(
      document.body.querySelectorAll('[aria-label="Hold to confirm"]').length
    ).equals(1)
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
    // Read again, the server has not kept it either.
    expect(api.loads.length).equals(2)
    expect(byTestId('Tess thinking')).not.equals(null)
    await act(async () => {
      api.loads[1].resolve({
        available: true,
        messages: HISTORY,
        contextTokens: 10
      })
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

    // When the conversation cannot be read either, the draft comes back.
    await type('Add a game')
    await act(async () => {
      api.sends[1].answer.reject('offline')
    })
    await act(async () => {
      api.loads[2].reject(new Error('offline'))
    })
    await settle()
    expect(texts('Tess user message').length).equals(1)
    expect((byLabel('Ask Tess') as HTMLTextAreaElement).value).equals(
      'Add a game'
    )
  })

  it('shows a message the server kept when Tess failed after a tool round, with her card, and keeps the draft empty', async function () {
    const api = new FakeTess()
    await render(<Harness api={api} />)
    await loaded(api)
    await type('Add both games')
    await act(async () => {
      api.sends[0].answer.reject(
        new HttpError('unavailable', "Tess's model answered 529")
      )
    })
    const proposed: TessChange = { ...CHANGE, id: 'c2' }
    await act(async () => {
      api.loads[1].resolve({
        available: true,
        messages: [
          HISTORY[0],
          { ...HISTORY[1], changes: [{ ...CHANGE, status: 'expired' }] },
          message('3', 'user', 'Add both games', {
            clientId: api.sends[0].request.clientId
          }),
          message('4', 'assistant', 'Let me check.', { changes: [proposed] })
        ],
        contextTokens: 10
      })
    })
    await settle()
    expect(texts('Tess user message')).deep.equals([
      'attach_fileruns.csvattach_filephoto.png (described)Chart these',
      'Add both games'
    ])
    expect(texts('Tess reply').at(-1)).includes('Let me check.')
    expect(texts('Tess change status')).deep.equals(['Expired'])
    expect(byTestId('Tess error')!.textContent).equals(
      "Tess's model answered 529"
    )
    // Sent, so not given back to be sent twice.
    expect((byLabel('Ask Tess') as HTMLTextAreaElement).value).equals('')
    expect(byTestId('Tess thinking')).equals(null)
  })

  it('shows the answer to a send whose request gave up while Tess was still answering, without sending it again', async function () {
    const api = new FakeTess()
    clock = manualClock()
    await render(<Harness api={api} />)
    await loaded(api)
    await type('Add both games')
    const { clientId } = api.sends[0].request
    // A phone gives up on a long answer after a minute.
    await act(async () => {
      api.sends[0].answer.reject(
        new HttpError(
          'offline',
          'Cannot reach TeamStation. Check your connection and try again.'
        )
      )
    })
    const asked = message('3', 'user', 'Add both games', { clientId })
    await act(async () => {
      api.loads[1].resolve({
        available: true,
        messages: [...HISTORY, asked],
        contextTokens: 10,
        answering: true
      })
    })
    await settle()
    // Still answering: the message stays, thinking, and nothing went wrong.
    expect(texts('Tess user message').at(-1)).equals('Add both games')
    expect(byTestId('Tess thinking')).not.equals(null)
    expect(byTestId('Tess error')).equals(null)
    expect(api.loads.length).equals(2)
    expect(clock.pending()).deep.equals([ANSWERING_POLL_MS])
    await clock.advance(ANSWERING_POLL_MS)
    expect(api.loads.length).equals(3)
    await act(async () => {
      api.loads[2].resolve({
        available: true,
        messages: [...HISTORY, asked],
        contextTokens: 10,
        answering: true
      })
    })
    await settle()
    await clock.advance(ANSWERING_POLL_MS)
    await act(async () => {
      api.loads[3].resolve({
        available: true,
        messages: [
          ...HISTORY,
          asked,
          message('4', 'assistant', 'Both games are ready to confirm.')
        ],
        contextTokens: 10,
        answering: false
      })
    })
    await settle()
    expect(texts('Tess reply').at(-1)).includes(
      'Both games are ready to confirm.'
    )
    expect(texts('Tess user message').length).equals(2)
    expect(byTestId('Tess thinking')).equals(null)
    expect(byTestId('Tess error')).equals(null)
    // Kept, so the draft is not given back, and it was sent once.
    expect((byLabel('Ask Tess') as HTMLTextAreaElement).value).equals('')
    expect(api.sends.length).equals(1)
    expect(clock.pending()).deep.equals([])
  })

  it('gives the draft back when the server refused it unstored, or kept only another device’s message', async function () {
    const api = new FakeTess()
    await render(<Harness api={api} />)
    await loaded(api)
    // Another device's turn is running: 409, and nothing of this one kept.
    await type('Add a game')
    await act(async () => {
      api.sends[0].answer.reject(
        new HttpError(
          'conflict',
          'Tess is still answering. Wait for her reply, then try again.'
        )
      )
    })
    await settle()
    expect(api.loads.length).equals(1)
    expect((byLabel('Ask Tess') as HTMLTextAreaElement).value).equals(
      'Add a game'
    )
    expect(texts('Tess user message').length).equals(1)
    expect(byTestId('Tess error')!.textContent).equals(
      'Tess is still answering. Wait for her reply, then try again.'
    )

    // A failure after which the conversation holds a newer message, the
    // other device's, and not this one.
    await type('Add a game')
    await act(async () => {
      api.sends[1].answer.reject(
        new HttpError('unavailable', "Tess's model answered 529")
      )
    })
    await act(async () => {
      api.loads[1].resolve({
        available: true,
        messages: [
          ...HISTORY,
          message('3', 'user', 'Show the standings', { clientId: 'tablet1' }),
          message('4', 'assistant', 'Here they are.')
        ],
        contextTokens: 10,
        answering: false
      })
    })
    await settle()
    expect(texts('Tess user message').at(-1)).equals('Show the standings')
    expect((byLabel('Ask Tess') as HTMLTextAreaElement).value).equals(
      'Add a game'
    )
    expect(byTestId('Tess error')!.textContent).equals(
      "Tess's model answered 529"
    )
  })

  it('waits for an answer already under way when the chat opens', async function () {
    const api = new FakeTess()
    clock = manualClock()
    await render(<Harness api={api} />)
    const asked = message('3', 'user', 'Add both games', { clientId: 'web1' })
    await act(async () => {
      api.loads[0].resolve({
        available: true,
        messages: [...HISTORY, asked],
        contextTokens: 10,
        answering: true
      })
    })
    await settle()
    expect(byTestId('Tess thinking')).not.equals(null)
    // Nothing more is sent meanwhile, which the server would refuse: it
    // waits in the queue.
    let sent: boolean | undefined
    await act(async () => {
      sent = await latest!.send('And another', [])
    })
    expect(sent).equals(true)
    expect(texts('Tess queued text')).deep.equals(['And another'])
    await clock.advance(ANSWERING_POLL_MS)
    await act(async () => {
      api.loads[1].resolve({
        available: true,
        messages: [...HISTORY, asked, message('4', 'assistant', 'Done.')],
        contextTokens: 10,
        answering: false
      })
    })
    await settle()
    expect(texts('Tess reply').at(-1)).includes('Done.')
    // Once she is done it goes.
    expect(api.sends.map(send => send.request.text)).deep.equals([
      'And another'
    ])
    expect(texts('Tess queued text')).deep.equals([])

    // Closed while waiting, nothing more is read.
    await unmount()
    const closing = new FakeTess()
    await render(<Harness api={closing} />)
    await act(async () => {
      closing.loads[0].resolve({
        available: true,
        messages: HISTORY,
        contextTokens: 10,
        answering: true
      })
    })
    await settle()
    await unmount()
    await clock.advance(ANSWERING_POLL_MS)
    expect(closing.loads.length).equals(1)
  })

  it('stops the turn under way when the chat opens by the id the server names', async function () {
    const api = new FakeTess()
    clock = manualClock()
    await render(<Harness api={api} />)
    const asked = message('3', 'user', 'Plan the season', { clientId: 'web1' })
    await act(async () => {
      api.loads[0].resolve({
        available: true,
        messages: [...HISTORY, asked],
        contextTokens: 10,
        answering: true,
        turnClientId: 'web1'
      })
    })
    await settle()
    await click(byLabel('Stop Tess'))
    expect(api.stops).deep.equals(['web1'])
    // One sent now stops it too, and goes once it has ended.
    await act(async () => {
      await latest!.send('And another', [])
    })
    await act(async () => {
      await latest!.sendNow(latest!.queued[0].id)
    })
    expect(api.stops).deep.equals(['web1', 'web1'])
    expect(api.sends).length(0)
    await clock.advance(ANSWERING_POLL_MS)
    await act(async () => {
      api.loads[1].resolve({
        available: true,
        messages: [
          ...HISTORY,
          asked,
          message('4', 'assistant', '', { stopped: true })
        ],
        contextTokens: 10,
        answering: false
      })
    })
    await settle()
    expect(api.sends.map(send => send.request.text)).deep.equals([
      'And another'
    ])
    // Once that turn is over, its id names nothing.
    await act(async () => {
      api.sends[0].answer.resolve([message('5', 'user', 'And another')])
    })
    await settle()
    await act(async () => {
      await latest!.stop()
    })
    expect(api.stops).length(2)
  })

  it('sends one message at a time, with the attachment ids, the next once she is done', async function () {
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
      second = await latest!.send('And these', [attachment])
    })
    expect(second).equals(true)
    expect(api.sends.map(send => send.request)).deep.equals([
      {
        text: 'Chart these',
        attachmentIds: ['a9'],
        clientId: api.sends[0].request.clientId
      }
    ])
    await act(async () => {
      api.sends[0].answer.resolve([])
      expect(await first).equals(true)
    })
    await settle()
    expect(api.sends.map(send => send.request)).deep.equals([
      {
        text: 'Chart these',
        attachmentIds: ['a9'],
        clientId: api.sends[0].request.clientId
      },
      {
        text: 'And these',
        attachmentIds: ['a9'],
        clientId: api.sends[1].request.clientId
      }
    ])
    expect(api.sends[1].request.clientId).not.equals(
      api.sends[0].request.clientId
    )
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
    expect(api.confirms.map(confirm => confirm.ids)).deep.equals([['c1']])
    expect(byLabel('Confirming…').getAttribute('aria-disabled')).equals('true')
    expect(byTestId('Tess thinking')).not.equals(null)
    await act(async () => {
      api.confirms[0].answer.resolve({
        changes: [{ ...CHANGE, status: 'done' }],
        messages: [message('5', 'assistant', 'The game is on the schedule.')]
      })
    })
    await settle()
    expect(texts('Tess change status')).deep.equals(['Done'])
    expect(texts('Tess reply').at(-1)).includes('The game is on the schedule.')
    expect(byTestId('Tess thinking')).equals(null)
  })

  it('confirms a turn’s changes together: all running, each as told, then one report', async function () {
    const api = new FakeTess()
    clock = manualClock()
    await render(<Harness api={api} />)
    const more = [
      { ...CHANGE, id: 'c2' },
      { ...CHANGE, id: 'c3' }
    ]
    await loaded(api, [
      HISTORY[0],
      HISTORY[1],
      message('3', 'assistant', 'And two more.', { changes: more })
    ])
    expect(texts('Tess hold')).length(1)
    await hold()
    expect(api.confirms.map(confirm => confirm.ids)).deep.equals([
      ['c1', 'c2', 'c3']
    ])
    expect(
      latest!.messages.flatMap(m => m.changes.map(c => c.status))
    ).deep.equals(['running', 'running', 'running'])
    // Nothing else is held or sent meanwhile.
    await act(async () => {
      await latest!.confirmAll(['c2'])
      await latest!.confirmAll([])
    })
    expect(api.confirms).length(1)
    const ended: TessChange[] = [
      { ...CHANGE, status: 'done' },
      { ...more[0], status: 'failed' },
      { ...more[1], status: 'done' }
    ]
    await act(async () => {
      api.confirms[0].tell({ type: 'stored', messages: [], changes: ended })
    })
    expect(texts('Tess change status')).deep.equals(['Done', 'Failed', 'Done'])
    await act(async () => {
      api.confirms[0].answer.resolve({
        changes: ended,
        messages: [message('5', 'assistant', 'Two of three are scheduled.')]
      })
    })
    await settle()
    expect(byTestId('Tess thinking')).equals(null)
    // The batch moves under the report, its turn's last reply.
    const replies = [
      ...document.body.querySelectorAll('[data-testid="Tess reply"]')
    ]
    expect(replies.at(-1)!.textContent).includes('Two of three are scheduled.')
    expect(
      replies.at(-1)!.querySelectorAll('[data-testid="Tess change"]')
    ).length(3)
    expect(texts('Tess change status')).deep.equals(['Done', 'Failed', 'Done'])
  })

  it('holds no other change and sends nothing while Tess answers, until the last of it is answered', async function () {
    const api = new FakeTess()
    clock = manualClock()
    await render(<Harness api={api} />)
    const second: TessChange = {
      ...CHANGE,
      id: 'c2',
      summary: 'Add a game against Demo Eagles on Sunday at 10'
    }
    // Two turns: a batch under each.
    await loaded(api, [
      ...HISTORY,
      message('3', 'user', 'And on Sunday'),
      message('4', 'assistant', 'Hold Confirm.', { changes: [second] })
    ])
    const pills = (): HTMLElement[] => [
      ...document.body.querySelectorAll<HTMLElement>(
        '[aria-label="Hold to confirm"], [aria-label="Confirming…"]'
      )
    ]
    await hold()
    expect(api.confirms.map(confirm => confirm.ids)).deep.equals([['c1']])
    // The other batch keeps its label and takes no hold.
    const other = byLabel('Hold to confirm')
    expect(pills().length).equals(2)
    expect(other.getAttribute('aria-disabled')).equals('true')
    await act(async () => {
      other.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }))
      await new Promise(resolve => setTimeout(resolve, 80))
    })
    await clock.advance(HOLD_MS)
    expect(api.confirms.length).equals(1)
    let sent: boolean | undefined
    await act(async () => {
      sent = await latest!.send('And the other one', [])
      await latest!.confirmAll(['c2'])
    })
    // Queued, not sent; taken out again so this test goes on without it.
    expect(sent).equals(true)
    expect(api.sends.length).equals(0)
    expect(api.confirms.length).equals(1)
    await act(async () => {
      latest!.unqueue(latest!.queued[0].id)
    })

    await act(async () => {
      api.confirms[0].answer.resolve({
        changes: [{ ...CHANGE, status: 'done' }],
        messages: [message('5', 'assistant', 'The game is on the schedule.')]
      })
    })
    await settle()
    expect(byTestId('Tess thinking')).equals(null)
    const off = (pill: HTMLElement): boolean =>
      pill.getAttribute('aria-disabled') === 'true'
    expect(pills().map(off)).deep.equals([false])

    // A message out holds the batches too.
    await type('Is that all?')
    expect(pills().map(off)).deep.equals([true])
    await act(async () => {
      api.sends[0].answer.resolve([message('6', 'user', 'Is that all?')])
    })
    await settle()
    // Answered, the batch the message passed by has expired.
    expect(pills()).deep.equals([])
    expect(texts('Tess change status')).deep.equals(['Done', 'Expired'])
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
      changes: [{ ...CHANGE, status: 'done' }],
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

    // A failed send whose conversation is read again after the chat closed.
    for (const outcome of ['read', 'unread'] as const) {
      const rereading = new FakeTess()
      await render(<Harness api={rereading} />)
      await loaded(rereading)
      await type('Add a game')
      await act(async () => {
        rereading.sends[0].answer.reject(new Error('busy'))
      })
      await unmount()
      if (outcome === 'read')
        rereading.loads[1].resolve({
          available: true,
          messages: [],
          contextTokens: 0
        })
      else rereading.loads[1].reject(new Error('gone'))
      await settle()
    }
  })

  /** Lets a frame pass, so what was told is drawn. */
  async function frame(): Promise<void> {
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 40))
    })
  }
  function thought(): HTMLElement | null {
    const rows = [
      ...document.body.querySelectorAll<HTMLElement>(
        '[data-testid="Tess thought"] [role="button"]'
      )
    ]
    return rows.at(-1) ?? null
  }

  it('shows her thinking, steps and text as they come, then her stored reply under a closed "Thought for Ns"', async function () {
    const api = new FakeTess()
    await render(<Harness api={api} />)
    await loaded(api)
    await type('What are our games?')
    const { tell, request } = api.sends[0]
    expect(byTestId('Tess thinking')!.textContent).equals('Tess is thinking…')
    // Stored: the message the server keeps takes the place of the one shown.
    await act(async () => {
      tell({
        type: 'stored',
        messages: [
          message('3', 'user', 'What are our games?', {
            clientId: request.clientId
          })
        ]
      })
    })
    expect(texts('Tess user message')).length(2)
    expect(latest!.messages.at(-1)!.id).equals('3')
    await act(async () => {
      tell({ type: 'thinking', delta: 'They want ' })
      tell({ type: 'thinking', delta: 'their games.' })
    })
    await frame()
    expect(byTestId('Tess live reply')).not.equals(null)
    expect(thought()!.getAttribute('aria-label')).equals('Thinking')
    expect(thought()!.getAttribute('aria-expanded')).equals('true')
    expect(byTestId('Tess thought body')!.textContent).equals(
      'They want their games.'
    )
    await act(async () => {
      tell({
        type: 'step',
        id: 't1',
        label: 'Reading: A team’s games',
        status: 'running'
      })
    })
    await frame()
    const step = (): HTMLElement =>
      document.body.querySelector<HTMLElement>('[data-testid="Tess step"]')!
    expect(step().getAttribute('aria-label')).equals(
      'Reading: A team’s games, in progress'
    )
    await act(async () => {
      tell({
        type: 'step',
        id: 't1',
        label: 'Reading: A team’s games',
        status: 'done'
      })
      tell({ type: 'text', delta: 'You play **Demo' })
    })
    await frame()
    expect(step().getAttribute('aria-label')).equals(
      'Reading: A team’s games, done'
    )
    // Drawn as Markdown each time it grows: a half-written bold shows as written.
    expect(byTestId('Tess live reply')!.textContent).contains('You play **Demo')
    await act(async () => {
      tell({ type: 'text', delta: ' Eagles** next.' })
    })
    await frame()
    expect(byTestId('Tess live reply')!.textContent).contains(
      'You play Demo Eagles next.'
    )
    await act(async () => {
      api.sends[0].answer.resolve([
        message('3', 'user', 'What are our games?'),
        message('4', 'assistant', 'You play **Demo Eagles** next.', {
          thinking: 'They want their games.',
          steps: [{ label: 'Reading: A team’s games', status: 'done' }]
        })
      ])
    })
    await settle()
    expect(byTestId('Tess live reply')).equals(null)
    expect(byTestId('Tess thinking')).equals(null)
    expect(latest!.live).equals(null)
    expect(thought()!.getAttribute('aria-label')).equals('Thought for 1s')
    expect(thought()!.getAttribute('aria-expanded')).equals('false')
    expect(latest!.thoughtSeconds).deep.equals({ '4': 1 })
    // Told late, after she is done: nothing changes.
    await act(async () => {
      tell({ type: 'text', delta: 'late' })
    })
    await frame()
    expect(latest!.live).equals(null)
  })

  it('reads the conversation once she is done when the stream is cut, as when an answer is lost', async function () {
    const api = new FakeTess()
    await render(<Harness api={api} />)
    await loaded(api)
    await type('What are our games?')
    const { tell, request } = api.sends[0]
    await act(async () => {
      tell({ type: 'thinking', delta: 'Reading.' })
    })
    await frame()
    expect(byTestId('Tess live reply')).not.equals(null)
    await act(async () => {
      api.sends[0].answer.reject(
        new HttpError(
          'offline',
          'Cannot reach TeamStation. Check your connection and try again.'
        )
      )
    })
    await settle()
    // The live reply is gone; the chat waits for her, as it does for a lost answer.
    expect(byTestId('Tess live reply')).equals(null)
    expect(byTestId('Tess thinking')!.textContent).equals('Tess is thinking…')
    await act(async () => {
      api.loads[1].resolve({
        available: true,
        messages: [
          ...HISTORY,
          message('3', 'user', 'What are our games?', {
            clientId: request.clientId
          }),
          message('4', 'assistant', 'You play Demo Eagles next.', {
            thinking: 'Reading.'
          })
        ],
        contextTokens: 10,
        answering: false
      })
    })
    await settle()
    expect(texts('Tess reply').at(-1)).contains('You play Demo Eagles next.')
    expect(byTestId('Tess error')).equals(null)
    expect(byTestId('Tess thinking')).equals(null)
    // Read from history: how long she thought is not known.
    expect(thought()!.getAttribute('aria-label')).equals('Thinking')
    expect(latest!.thoughtSeconds).deep.equals({})
  })

  it('keeps a message the server said it stored when the stream and the reread both fail', async function () {
    const api = new FakeTess()
    await render(<Harness api={api} />)
    await loaded(api)
    await type('Add a game')
    const { tell, request } = api.sends[0]
    await act(async () => {
      tell({
        type: 'stored',
        messages: [
          message('3', 'user', 'Add a game', { clientId: request.clientId })
        ]
      })
    })
    await act(async () => {
      api.sends[0].answer.reject(
        new HttpError(
          'offline',
          'Cannot reach TeamStation. Check your connection and try again.'
        )
      )
    })
    await act(async () => {
      api.loads[1].reject(new Error('offline'))
    })
    await settle()
    // The stored copy stays, once, and the draft is not given back to send
    // a second time.
    expect(texts('Tess user message')).has.length(2)
    expect(texts('Tess user message').at(-1)).equals('Add a game')
    expect((byLabel('Ask Tess') as HTMLTextAreaElement).value).equals('')
    expect(byTestId('Tess error')!.textContent).equals(
      'Cannot reach TeamStation. Check your connection and try again.'
    )
    // Told stored, a refusal code that means "never stored" no longer does.
    await type('And a practice')
    const second = api.sends[1]
    await act(async () => {
      second.tell({
        type: 'stored',
        messages: [
          message('5', 'user', 'And a practice', {
            clientId: second.request.clientId
          })
        ]
      })
    })
    await act(async () => {
      second.answer.reject(new HttpError('tooLarge', 'Too long.'))
    })
    await act(async () => {
      api.loads[2].reject(new Error('offline'))
    })
    await settle()
    expect(texts('Tess user message').at(-1)).equals('And a practice')
    expect((byLabel('Ask Tess') as HTMLTextAreaElement).value).equals('')
  })

  it('gives the draft back, and the changes pending again, when the stream says the server took a stored message back', async function () {
    const api = new FakeTess()
    await render(<Harness api={api} />)
    await loaded(api)
    expect(texts('Tess change status')).deep.equals([])
    await type('Add a game')
    const { tell, request } = api.sends[0]
    await act(async () => {
      tell({
        type: 'stored',
        messages: [
          message('3', 'user', 'Add a game', { clientId: request.clientId })
        ]
      })
    })
    expect(texts('Tess change status')).deep.equals(['Expired'])
    // Tess's model failed before she stored anything: the server took the
    // message back and made the change pending again, and says so.
    await act(async () => {
      api.sends[0].answer.reject(
        new TessTurnError(
          new HttpError('unavailable', "Tess's model answered 529"),
          false
        )
      )
    })
    await settle()
    // Told, so nothing is read again.
    expect(api.loads).has.length(1)
    expect(texts('Tess user message')).has.length(1)
    expect(texts('Tess change status')).deep.equals([])
    expect(byLabel('Hold to confirm')).not.equals(null)
    expect((byLabel('Ask Tess') as HTMLTextAreaElement).value).equals(
      'Add a game'
    )
    expect(byTestId('Tess error')!.textContent).equals(
      "Tess's model answered 529"
    )
    // Refused once the conversation was compacted, before it was stored.
    await type('And a practice')
    await act(async () => {
      api.sends[1].answer.reject(
        new TessTurnError(
          new HttpError('unavailable', 'Compaction failed'),
          false
        )
      )
    })
    await settle()
    expect(api.loads).has.length(1)
    expect(texts('Tess user message')).has.length(1)
    expect((byLabel('Ask Tess') as HTMLTextAreaElement).value).equals(
      'And a practice'
    )
  })

  it('keeps a message the stream says the server kept, when the reread fails, even unseen as stored', async function () {
    const api = new FakeTess()
    await render(<Harness api={api} />)
    await loaded(api)
    await type('Add a game')
    const { tell, request } = api.sends[0]
    await act(async () => {
      tell({
        type: 'stored',
        messages: [
          message('3', 'user', 'Add a game', { clientId: request.clientId })
        ]
      })
    })
    // A tool round was stored before the failure: the message stays.
    await act(async () => {
      api.sends[0].answer.reject(
        new TessTurnError(
          new HttpError('unavailable', "Tess's model answered 529"),
          true
        )
      )
    })
    await act(async () => {
      api.loads[1].reject(new Error('offline'))
    })
    await settle()
    expect(texts('Tess user message').at(-1)).equals('Add a game')
    expect(texts('Tess change status')).deep.equals(['Expired'])
    expect((byLabel('Ask Tess') as HTMLTextAreaElement).value).equals('')
    // Its `stored` event left out, the server still says it kept it.
    await type('And a practice')
    await act(async () => {
      api.sends[1].answer.reject(
        new TessTurnError(
          new HttpError('internal', 'Something went wrong'),
          true
        )
      )
    })
    await act(async () => {
      api.loads[2].reject(new Error('offline'))
    })
    await settle()
    expect(texts('Tess user message').at(-1)).equals('And a practice')
    expect((byLabel('Ask Tess') as HTMLTextAreaElement).value).equals('')
  })

  it('keeps how a confirmed change ended, as told, when the stream and the reread both fail', async function () {
    const api = new FakeTess()
    clock = manualClock()
    await render(<Harness api={api} />)
    await loaded(api)
    await hold()
    await act(async () => {
      api.confirms[0].tell({
        type: 'stored',
        messages: [],
        changes: [{ ...CHANGE, status: 'done' }]
      })
    })
    await act(async () => {
      api.confirms[0].answer.reject(new Error('Network down'))
    })
    await act(async () => {
      api.loads[1].reject(new Error('Network down'))
    })
    await settle()
    // Not offered again: it ran.
    expect(texts('Tess change status')).deep.equals(['Done'])
    expect(
      document.body.querySelector('[aria-label="Hold to confirm"]')
    ).equals(null)
  })

  it('shows a confirmed change as it ended before Tess reports it, and her report as it comes', async function () {
    const api = new FakeTess()
    clock = manualClock()
    await render(<Harness api={api} />)
    await loaded(api)
    await hold()
    const { tell } = api.confirms[0]
    await act(async () => {
      tell({
        type: 'stored',
        messages: [],
        changes: [{ ...CHANGE, status: 'done' }]
      })
      tell({ type: 'stored', messages: [] })
    })
    expect(texts('Tess change status')).deep.equals(['Done'])
    await act(async () => {
      tell({ type: 'text', delta: 'The game is on' })
    })
    await frame()
    expect(byTestId('Tess live reply')!.textContent).contains('The game is on')
    await act(async () => {
      api.confirms[0].answer.resolve({
        changes: [{ ...CHANGE, status: 'done' }],
        messages: [message('5', 'assistant', 'The game is on the schedule.')]
      })
    })
    await settle()
    expect(byTestId('Tess live reply')).equals(null)
    expect(texts('Tess reply').at(-1)).includes('The game is on the schedule.')
    // She told no thinking or step: no row, and no time kept.
    expect(latest!.thoughtSeconds).deep.equals({})
  })

  it('stops the running message by its client id, and ends thinking with the stopped reply', async function () {
    const api = new FakeTess()
    await render(<Harness api={api} />)
    await loaded(api)
    // Nothing is out: nothing to stop.
    await act(async () => {
      await latest!.stop()
    })
    expect(api.stops).deep.equals([])
    await type('Schedule the whole season')
    await act(async () => {
      api.sends[0].tell({ type: 'text', delta: 'Let me start with' })
    })
    // The field is empty while she answers: the button is Stop, which
    // takes a press once the moment after the send has passed.
    expect(document.body.querySelector('[aria-label="Send"]')).equals(null)
    await new Promise(resolve => setTimeout(resolve, STOP_GUARD_MS))
    await click(byLabel('Stop Tess'))
    expect(api.stops).deep.equals([api.sends[0].request.clientId])
    await act(async () => {
      api.sends[0].answer.resolve([
        message('3', 'user', 'Schedule the whole season'),
        message('4', 'assistant', '', { stopped: true })
      ])
    })
    await settle()
    expect(byTestId('Tess thinking')).equals(null)
    expect(byTestId('Tess live reply')).equals(null)
    expect(texts('Tess stopped')).deep.equals(['Stopped'])
    expect(document.body.querySelector('[aria-label="Stop Tess"]')).equals(null)
    // Once she is done there is nothing to stop.
    await act(async () => {
      await latest!.stop()
    })
    expect(api.stops).length(1)
  })

  it('stops a confirm by the client id it was sent with, and shows a stop that fails', async function () {
    const api = new FakeTess()
    clock = manualClock()
    await render(<Harness api={api} />)
    await loaded(api)
    await hold()
    const { clientId } = api.confirms[0]
    expect(clientId).match(/^[A-Za-z0-9_-]{1,64}$/)
    api.stopFails = true
    await act(async () => {
      await latest!.stop()
    })
    expect(api.stops).deep.equals([clientId])
    expect(byTestId('Tess error')!.textContent).equals(
      'Cannot reach TeamStation.'
    )
    await act(async () => {
      api.confirms[0].answer.resolve({
        changes: [{ ...CHANGE, status: 'done' }],
        messages: [message('5', 'assistant', '', { stopped: true })]
      })
    })
    await settle()
    expect(texts('Tess change status')).deep.equals(['Done'])
    expect(texts('Tess stopped')).deep.equals(['Stopped'])
  })

  it('draws nothing told after the chat has closed', async function () {
    const api = new FakeTess()
    await render(<Harness api={api} />)
    await loaded(api)
    await type('What are our games?')
    await act(async () => {
      api.sends[0].tell({ type: 'thinking', delta: 'Reading.' })
    })
    await unmount()
    api.sends[0].tell({ type: 'text', delta: 'late' })
    api.sends[0].answer.resolve([
      message('3', 'user', 'What are our games?'),
      message('4', 'assistant', 'Late.', { thinking: 'Reading.' })
    ])
    await settle()
    await new Promise(resolve => setTimeout(resolve, 40))
  })

  describe('the queue', function () {
    const queuedTexts = (): string[] => texts('Tess queued text')
    const sentTexts = (api: FakeTess): string[] =>
      api.sends.map(send => send.request.text)
    /** The button `label` on the queued bubble that says `text`. */
    const onBubble = (text: string, label: string): HTMLElement => {
      const bubble = [
        ...document.body.querySelectorAll<HTMLElement>(
          '[data-testid="Tess queued"]'
        )
      ].find(
        node =>
          node.querySelector('[data-testid="Tess queued text"]')
            ?.textContent === text
      )
      if (bubble == null) throw new Error(`No queued ${text}`)
      const button = bubble.querySelector<HTMLElement>(
        `[aria-label="${label}"]`
      )
      if (button == null) throw new Error(`No ${label} on ${text}`)
      return button
    }
    const edit = async (text: string): Promise<void> => {
      await click(onBubble(text, `Edit queued message: ${text}`))
    }
    const answer = async (
      api: FakeTess,
      at: number,
      messages: TessMessage[]
    ): Promise<void> => {
      await act(async () => {
        api.sends[at].answer.resolve(messages)
      })
      await settle()
    }

    it('queues what is sent while she answers, and sends it one at a time once she is done', async function () {
      const api = new FakeTess()
      await render(<Harness api={api} />)
      await loaded(api)
      await type('First')
      await type('Second')
      await type('Third')
      expect(sentTexts(api)).deep.equals(['First'])
      expect(queuedTexts()).deep.equals(['Second', 'Third'])
      expect(
        texts('Tess queued').map(text => text.includes('queued'))
      ).deep.equals([true, true])
      // The field is empty again, and the button stops her.
      expect((byLabel('Ask Tess') as HTMLTextAreaElement).value).equals('')
      expect(byLabel('Stop Tess')).not.equals(null)
      await answer(api, 0, [
        message('3', 'user', 'First'),
        message('4', 'assistant', 'One.')
      ])
      expect(sentTexts(api)).deep.equals(['First', 'Second'])
      expect(queuedTexts()).deep.equals(['Third'])
      expect(texts('Tess user message').at(-1)).equals('Second')
      await answer(api, 1, [
        message('5', 'user', 'Second'),
        message('6', 'assistant', 'Two.')
      ])
      expect(sentTexts(api)).deep.equals(['First', 'Second', 'Third'])
      expect(queuedTexts()).deep.equals([])
      expect(byTestId('Tess queue')).equals(null)
    })

    it('waits while her reply has changes awaiting the hold, and goes once they are held', async function () {
      const api = new FakeTess()
      clock = manualClock()
      await render(<Harness api={api} />)
      await loaded(api)
      await type('Add the game')
      await type('Then the roster')
      const proposed: TessChange = { ...CHANGE, id: 'c9' }
      await answer(api, 0, [
        message('3', 'user', 'Add the game'),
        message('4', 'assistant', 'Hold Confirm.', { changes: [proposed] })
      ])
      expect(sentTexts(api)).deep.equals(['Add the game'])
      expect(queuedTexts()).deep.equals(['Then the roster'])
      await hold()
      expect(api.confirms.map(confirm => confirm.ids)).deep.equals([['c9']])
      expect(sentTexts(api)).length(1)
      await act(async () => {
        api.confirms[0].answer.resolve({
          changes: [{ ...proposed, status: 'done' }],
          messages: [message('5', 'assistant', 'The game is on.')]
        })
      })
      await settle()
      expect(sentTexts(api)).deep.equals(['Add the game', 'Then the roster'])
      expect(queuedTexts()).deep.equals([])
    })

    it('returns a message refused going out to the head, with why, and waits until its arrow sends it again', async function () {
      const api = new FakeTess()
      await render(<Harness api={api} />)
      await loaded(api)
      await type('First')
      await type('Second')
      await type('Third')
      await answer(api, 0, [message('3', 'user', 'First')])
      expect(sentTexts(api)).deep.equals(['First', 'Second'])
      await act(async () => {
        api.sends[1].answer.reject(
          new HttpError('conflict', 'Tess is still answering another message.')
        )
      })
      await settle()
      expect(queuedTexts()).deep.equals(['Second', 'Third'])
      expect(texts('Tess queued error')).deep.equals([
        'Tess is still answering another message.'
      ])
      // On its bubble, not under the composer; and the shown one is gone.
      expect(byTestId('Tess error')).equals(null)
      expect(texts('Tess user message').at(-1)).equals('First')
      // The queue waits.
      await settle()
      expect(sentTexts(api)).length(2)
      await click(onBubble('Second', 'Send now'))
      expect(sentTexts(api)).deep.equals(['First', 'Second', 'Second'])
      expect(texts('Tess queued error')).deep.equals([])
      expect(queuedTexts()).deep.equals(['Third'])
      await answer(api, 2, [message('4', 'user', 'Second')])
      expect(sentTexts(api)).deep.equals(['First', 'Second', 'Second', 'Third'])
    })

    it('sends one now: stops her, sends it first, and leaves the rest in order; held changes it passes expire', async function () {
      const api = new FakeTess()
      await render(<Harness api={api} />)
      await loaded(api)
      await type('Plan the season')
      await type('A')
      await type('B')
      await type('C')
      // While she answers: stopped, and sent once the stop has ended her.
      await click(onBubble('C', 'Send now'))
      expect(api.stops).deep.equals([api.sends[0].request.clientId])
      expect(sentTexts(api)).deep.equals(['Plan the season'])
      expect(queuedTexts()).deep.equals(['A', 'B'])
      const proposed: TessChange = { ...CHANGE, id: 'c9' }
      await answer(api, 0, [
        message('3', 'user', 'Plan the season'),
        message('4', 'assistant', 'Hold Confirm.', {
          changes: [proposed],
          stopped: true
        })
      ])
      expect(sentTexts(api)).deep.equals(['Plan the season', 'C'])
      expect(queuedTexts()).deep.equals(['A', 'B'])
      await answer(api, 1, [
        message('5', 'user', 'C'),
        message('6', 'assistant', 'Hold Confirm.', {
          changes: [{ ...proposed, id: 'c10' }]
        })
      ])
      // Her reply holds a change: the queue waits for it. The ones before
      // have expired.
      expect(sentTexts(api)).length(2)
      expect(texts('Tess change status')).deep.equals(['Expired', 'Expired'])
      expect(byLabel('Hold to confirm')).not.equals(null)
      // While she is free: at once, declining the change.
      await click(onBubble('B', 'Send now'))
      expect(sentTexts(api)).deep.equals(['Plan the season', 'C', 'B'])
      expect(api.stops).length(1)
      expect(queuedTexts()).deep.equals(['A'])
      await act(async () => {
        api.sends[2].tell({
          type: 'stored',
          messages: [message('7', 'user', 'B')]
        })
      })
      expect(texts('Tess change status')).deep.equals([
        'Expired',
        'Expired',
        'Expired'
      ])
      expect(
        document.body.querySelector('[aria-label="Hold to confirm"]')
      ).equals(null)
      await answer(api, 2, [message('7', 'user', 'B')])
      expect(sentTexts(api)).deep.equals(['Plan the season', 'C', 'B', 'A'])
    })

    it('keeps the queue while the chat is closed, and sends it once it opens again', async function () {
      const api = new FakeTess()
      await render(<Harness api={api} owner="u1" />)
      await loaded(api)
      await type('First')
      await type('Second')
      await type('Third')
      await unmount()
      // Closed, nothing goes, though she is done.
      await act(async () => {
        api.sends[0].answer.resolve([message('3', 'user', 'First')])
      })
      await settle()
      expect(sentTexts(api)).deep.equals(['First'])
      // Another account opening the chat sees none of it.
      const other = new FakeTess()
      await render(<Harness api={other} owner="u2" />)
      await loaded(other)
      expect(queuedTexts()).deep.equals([])
      await unmount()
      // Opened again, the same bubbles, and they go once it has read.
      const again = new FakeTess()
      await render(<Harness api={again} owner="u1" />)
      expect(queuedTexts()).deep.equals(['Second', 'Third'])
      expect(again.sends).length(0)
      await loaded(again, [message('3', 'user', 'First')])
      expect(sentTexts(again)).deep.equals(['Second'])
      await answer(again, 0, [message('4', 'user', 'Second')])
      expect(sentTexts(again)).deep.equals(['Second', 'Third'])
      expect(queuedTexts()).deep.equals([])
    })

    it('keeps a queued message refused while the chat is closed at the head, with why', async function () {
      const api = new FakeTess()
      await render(<Harness api={api} owner="u1" />)
      await loaded(api)
      await type('First')
      await type('Second')
      await type('Third')
      await answer(api, 0, [message('3', 'user', 'First')])
      expect(sentTexts(api)).deep.equals(['First', 'Second'])
      await unmount()
      await act(async () => {
        api.sends[1].answer.reject(
          new HttpError('conflict', 'Tess is still answering another message.')
        )
      })
      await settle()
      const again = new FakeTess()
      await render(<Harness api={again} owner="u1" />)
      await loaded(again, [message('3', 'user', 'First')])
      expect(queuedTexts()).deep.equals(['Second', 'Third'])
      expect(texts('Tess queued error')).deep.equals([
        'Tess is still answering another message.'
      ])
      expect(again.sends).length(0)
    })

    /**
     * Sends First, then Second from the queue, behind which Third waits, and
     * closes the chat while Second is out; opens it again on `again`.
     */
    const reopenedWhileOut = async (
      api: FakeTess,
      again: FakeTess
    ): Promise<void> => {
      await render(<Harness api={api} owner="u1" />)
      await loaded(api)
      await type('First')
      await type('Second')
      await type('Third')
      await answer(api, 0, [message('3', 'user', 'First')])
      expect(sentTexts(api)).deep.equals(['First', 'Second'])
      await unmount()
      await render(<Harness api={again} owner="u1" />)
      expect(queuedTexts()).deep.equals(['Third'])
    }
    const conversationOf = (
      messages: TessMessage[],
      answering = false
    ): TessConversation => ({
      available: true,
      messages,
      contextTokens: 10,
      answering
    })

    it('shows a message the closed chat sent failing at the head, with why, and sends nothing past it', async function () {
      const api = new FakeTess()
      const again = new FakeTess()
      clock = manualClock()
      await reopenedWhileOut(api, again)
      // Opened while Tess answers Second.
      await act(async () => {
        again.loads[0].resolve(
          conversationOf([message('3', 'user', 'First')], true)
        )
      })
      await settle()
      expect(byTestId('Tess thinking')).not.equals(null)
      // Her turn fails before she stores anything: the server took it back.
      await act(async () => {
        api.sends[1].answer.reject(
          new TessTurnError(
            new HttpError('unavailable', "Tess's model answered 529"),
            false
          )
        )
      })
      await settle()
      expect(queuedTexts()).deep.equals(['Second', 'Third'])
      expect(texts('Tess queued error')).deep.equals([
        "Tess's model answered 529"
      ])
      // The conversation is read again for it, and as she is done.
      await act(async () => {
        again.loads[1].resolve(conversationOf([message('3', 'user', 'First')]))
      })
      await clock.advance(ANSWERING_POLL_MS)
      await act(async () => {
        again.loads[2].resolve(conversationOf([message('3', 'user', 'First')]))
      })
      await settle()
      expect(byTestId('Tess thinking')).equals(null)
      // The queue waits at the failed head; Third does not pass it.
      expect(again.sends).length(0)
      expect(queuedTexts()).deep.equals(['Second', 'Third'])
      await click(onBubble('Second', 'Send now'))
      expect(sentTexts(again)).deep.equals(['Second'])
      expect(queuedTexts()).deep.equals(['Third'])
    })

    it('sends nothing past a message the closed chat sent before Tess took it, and shows her answer to it', async function () {
      const api = new FakeTess()
      const again = new FakeTess()
      await reopenedWhileOut(api, again)
      // Read before the server has Second: she is not answering yet.
      await loaded(again, [message('3', 'user', 'First')])
      expect(byTestId('Tess thinking')).not.equals(null)
      expect(again.sends).length(0)
      await answer(api, 1, [
        message('4', 'user', 'Second'),
        message('5', 'assistant', 'Two.')
      ])
      // What it did shows once the conversation is read again; then Third.
      expect(again.sends).length(0)
      await act(async () => {
        again.loads[1].resolve(
          conversationOf([
            message('3', 'user', 'First'),
            message('4', 'user', 'Second'),
            message('5', 'assistant', 'Two.')
          ])
        )
      })
      await settle()
      expect(texts('Tess reply').at(-1)).includes('Two.')
      expect(sentTexts(again)).deep.equals(['Third'])
      expect(queuedTexts()).deep.equals([])
    })

    it('stops a message the closed chat sent, from the chat opened before Tess took it, by its client id', async function () {
      const api = new FakeTess()
      const again = new FakeTess()
      await reopenedWhileOut(api, again)
      const { clientId } = api.sends[1].request
      // Pressed while the conversation is still being read.
      await act(async () => {
        await latest!.stop()
      })
      expect(again.stops).deep.equals([clientId])
      // Read before the server has Second: it names no turn; Stop still
      // names Second, and so does one sent now.
      await loaded(again, [message('3', 'user', 'First')])
      await click(byLabel('Stop Tess'))
      expect(again.stops).deep.equals([clientId, clientId])
      await click(onBubble('Third', 'Send now'))
      expect(again.stops).deep.equals([clientId, clientId, clientId])
      expect(again.sends).length(0)
      // Once it settles, its id names nothing.
      await answer(api, 1, [
        message('4', 'user', 'Second'),
        message('5', 'assistant', '', { stopped: true })
      ])
      await act(async () => {
        again.loads[1].resolve(
          conversationOf([
            message('3', 'user', 'First'),
            message('4', 'user', 'Second'),
            message('5', 'assistant', '', { stopped: true })
          ])
        )
      })
      await settle()
      expect(sentTexts(again)).deep.equals(['Third'])
    })

    /**
     * Sends First, then Second from the queue, behind which Third waits; the
     * chat closes and Second's stream drops, so whether the server has it is
     * unknown. Answers the client id it went with.
     */
    const lostWhileClosed = async (api: FakeTess): Promise<string> => {
      await render(<Harness api={api} owner="u1" />)
      await loaded(api)
      await type('First')
      await type('Second')
      await type('Third')
      await answer(api, 0, [message('3', 'user', 'First')])
      expect(sentTexts(api)).deep.equals(['First', 'Second'])
      await unmount()
      await act(async () => {
        api.sends[1].answer.reject(
          new HttpError('offline', 'Cannot reach TeamStation.')
        )
      })
      await settle()
      return api.sends[1].request.clientId!
    }

    it('drops a queued message lost with the chat closed once the conversation shows it reached Tess', async function () {
      const clientId = await lostWhileClosed(new FakeTess())
      const again = new FakeTess()
      await render(<Harness api={again} owner="u1" />)
      // Back at the head, it waits for the conversation to say.
      expect(queuedTexts()).deep.equals(['Second', 'Third'])
      await loaded(again, [
        message('3', 'user', 'First'),
        message('4', 'user', 'Second', { clientId }),
        message('5', 'assistant', 'Noted.')
      ])
      // It reached her: it is not sent again, and the queue goes on.
      expect(sentTexts(again)).deep.equals(['Third'])
      expect(queuedTexts()).deep.equals([])
    })

    it('keeps a queued message lost with the chat closed at the head, with why, when the conversation does not show it', async function () {
      await lostWhileClosed(new FakeTess())
      const again = new FakeTess()
      await render(<Harness api={again} owner="u1" />)
      await loaded(again, [message('3', 'user', 'First')])
      // Never sent again unasked: the person sends it again or removes it.
      expect(queuedTexts()).deep.equals(['Second', 'Third'])
      expect(texts('Tess queued error')).deep.equals([
        'This message may not have reached Tess. Send it again, or remove it.'
      ])
      expect(again.sends).length(0)
      await click(onBubble('Second', 'Send now'))
      await settle()
      expect(sentTexts(again)).deep.equals(['Second'])
      expect(queuedTexts()).deep.equals(['Third'])
    })

    it('forgets every queue once the person signs out', async function () {
      const api = new FakeTess()
      await render(<Harness api={api} owner="u1" />)
      await loaded(api)
      await type('First')
      await type('Second')
      await unmount()
      forgetQueues()
      const again = new FakeTess()
      await render(<Harness api={again} owner="u1" />)
      expect(queuedTexts()).deep.equals([])
    })

    it('goes on once the changes it waits for have expired, counted from when they arrived whatever the device clock says', async function () {
      const api = new FakeTess()
      clock = manualClock()
      await render(<Harness api={api} />)
      await loaded(api, [])
      await type('Plan the season')
      await type('Then the playoffs')
      // This device's clock is an hour ahead of the server's: by it, the
      // server's expiresAt has passed already.
      const proposed: TessChange = {
        ...CHANGE,
        id: 'c9',
        expiresAt: new Date(Date.now() - 30 * 60000).toISOString(),
        expiresInMs: 30 * 60000
      }
      await answer(api, 0, [
        message('3', 'user', 'Plan the season'),
        message('4', 'assistant', 'Hold Confirm.', { changes: [proposed] })
      ])
      // Her reply holds a change: the queue waits for it, its hold offered.
      const holdShown = (): boolean =>
        document.body.querySelector('[aria-label="Hold to confirm"]') != null
      expect(sentTexts(api)).deep.equals(['Plan the season'])
      expect(queuedTexts()).deep.equals(['Then the playoffs'])
      expect(holdShown()).equals(true)
      await clock.advance(30 * 60000 - 1000)
      await settle()
      expect(holdShown()).equals(true)
      expect(queuedTexts()).deep.equals(['Then the playoffs'])
      await clock.advance(1000)
      await settle()
      // Past its time it has expired, as on the server, and the queue goes.
      expect(texts('Tess change status')).deep.equals(['Expired'])
      expect(sentTexts(api)).deep.equals([
        'Plan the season',
        'Then the playoffs'
      ])
      expect(queuedTexts()).deep.equals([])
    })

    it('takes an edited message out so it cannot go, and puts it back at its place when sent', async function () {
      const api = new FakeTess()
      await render(<Harness api={api} />)
      await loaded(api)
      await type('First')
      await type('A')
      await type('B')
      await type('C')
      await type('D')
      await click(onBubble('D', 'Remove from queue'))
      expect(queuedTexts()).deep.equals(['A', 'B', 'C'])
      await edit('B')
      const field = byLabel('Ask Tess') as HTMLTextAreaElement
      expect(field.value).equals('B')
      expect(queuedTexts()).deep.equals(['A', 'C'])
      await type('B, edited')
      expect(queuedTexts()).deep.equals(['A', 'B, edited', 'C'])
      // Out for editing when she is done: the queue waits for it.
      await edit('A')
      await answer(api, 0, [message('3', 'user', 'First')])
      expect(sentTexts(api)).deep.equals(['First'])
      expect(queuedTexts()).deep.equals(['B, edited', 'C'])
      // Sent again, it goes first, at its place.
      await type('A, edited')
      expect(sentTexts(api)).deep.equals(['First', 'A, edited'])
      expect(queuedTexts()).deep.equals(['B, edited', 'C'])
    })

    it('puts a message out for editing back at its place, as edited so far, when another is taken to edit', async function () {
      const api = new FakeTess()
      await render(<Harness api={api} />)
      await loaded(api)
      await type('First')
      await type('A')
      await type('B')
      await type('C')
      await edit('A')
      const field = byLabel('Ask Tess') as HTMLTextAreaElement
      // Words typed into A, not yet sent.
      await act(async () => {
        Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype,
          'value'
        )!.set!.call(field, 'A, edited')
        field.dispatchEvent(new window.Event('input', { bubbles: true }))
      })
      await settle()
      expect(queuedTexts()).deep.equals(['B', 'C'])
      await edit('B')
      expect(field.value).equals('B')
      expect(queuedTexts()).deep.equals(['A, edited', 'C'])
      await type('B, edited')
      expect(queuedTexts()).deep.equals(['A, edited', 'B, edited', 'C'])
      // The queue goes on in its order.
      await answer(api, 0, [message('3', 'user', 'First')])
      expect(sentTexts(api)).deep.equals(['First', 'A, edited'])
      expect(queuedTexts()).deep.equals(['B, edited', 'C'])
    })

    it('keeps the order when the head that failed is edited with others behind it', async function () {
      const api = new FakeTess()
      await render(<Harness api={api} />)
      await loaded(api)
      await type('First')
      await type('Second')
      await type('Third')
      await answer(api, 0, [message('3', 'user', 'First')])
      await act(async () => {
        api.sends[1].answer.reject(
          new HttpError('conflict', 'Tess is still answering another message.')
        )
      })
      await settle()
      expect(queuedTexts()).deep.equals(['Second', 'Third'])
      // Taken out to edit: Third waits behind it.
      await edit('Second')
      await settle()
      expect(sentTexts(api)).deep.equals(['First', 'Second'])
      expect(queuedTexts()).deep.equals(['Third'])
      await type('Second, edited')
      expect(sentTexts(api)).deep.equals(['First', 'Second', 'Second, edited'])
      await answer(api, 2, [message('4', 'user', 'Second, edited')])
      expect(sentTexts(api)).deep.equals([
        'First',
        'Second',
        'Second, edited',
        'Third'
      ])
    })

    it('waits for an edited head through an emptied field, sends it retyped at its place, and puts it back when the chat closes', async function () {
      const api = new FakeTess()
      await render(<Harness api={api} owner="u1" />)
      await loaded(api)
      await type('First')
      await type('A')
      await type('B')
      await edit('A')
      // Emptied while she answers, then once she is done: B does not pass it.
      const field = byLabel('Ask Tess') as HTMLTextAreaElement
      const fill = async (value: string): Promise<void> => {
        await act(async () => {
          Object.getOwnPropertyDescriptor(
            window.HTMLTextAreaElement.prototype,
            'value'
          )!.set!.call(field, value)
          field.dispatchEvent(new window.Event('input', { bubbles: true }))
        })
        await settle()
      }
      await fill('')
      await answer(api, 0, [message('3', 'user', 'First')])
      expect(sentTexts(api)).deep.equals(['First'])
      expect(queuedTexts()).deep.equals(['B'])
      // Retyped and sent: it goes first, at its place, then B.
      await type('A, reworded')
      expect(sentTexts(api)).deep.equals(['First', 'A, reworded'])
      expect(queuedTexts()).deep.equals(['B'])
      await answer(api, 1, [message('4', 'user', 'A, reworded')])
      expect(sentTexts(api)).deep.equals(['First', 'A, reworded', 'B'])
      // Emptied, then another taken to edit: it goes back as it was.
      await type('C')
      await type('D')
      await edit('C')
      await fill('')
      await edit('D')
      expect(queuedTexts()).deep.equals(['C'])
      // Closed while one is out for editing: it is back, as it was.
      await unmount()
      const again = new FakeTess()
      await render(<Harness api={again} owner="u1" />)
      expect(queuedTexts()).deep.equals(['C', 'D'])
    })

    it('sends an edited message at once when she is free and nothing waits', async function () {
      const api = new FakeTess()
      await render(<Harness api={api} />)
      await loaded(api)
      await type('First')
      await type('A')
      await edit('A')
      await answer(api, 0, [message('3', 'user', 'First')])
      expect(sentTexts(api)).deep.equals(['First'])
      await type('A, now')
      expect(sentTexts(api)).deep.equals(['First', 'A, now'])
      expect(queuedTexts()).deep.equals([])
    })
  })
})
