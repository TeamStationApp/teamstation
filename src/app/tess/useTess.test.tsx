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
import { TessChat } from './TessChat'
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
    id: string
    answer: Deferred<{ change: TessChange; messages: TessMessage[] }>
    tell: (event: TessStreamEvent) => void
  }> = []

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

  async streamTessConfirm(
    id: string,
    tell: (event: TessStreamEvent) => void
  ): Promise<{ change: TessChange; messages: TessMessage[] }> {
    const answer = deferred<{ change: TessChange; messages: TessMessage[] }>()
    this.confirms.push({ id, answer, tell })
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
    const cards = [
      ...document.body.querySelectorAll<HTMLElement>(
        '[data-testid="Tess change"]'
      )
    ]
    expect(cards.length).equals(2)
    expect(cards[0].textContent).includes('Expired')
    expect(cards[0].querySelector('[aria-label="Hold to confirm"]')).equals(
      null
    )
    expect(cards[1].querySelector('[aria-label="Hold to confirm"]')).not.equals(
      null
    )
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
    // Nothing more is sent meanwhile: the server would refuse it.
    let sent: boolean | undefined
    await act(async () => {
      sent = await latest!.send('And another', [])
    })
    expect(sent).equals(false)
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
    expect(byTestId('Tess thinking')).equals(null)
    expect(api.sends.length).equals(0)

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

  it('holds no other change and sends nothing while Tess answers, until the last of it is answered', async function () {
    const api = new FakeTess()
    clock = manualClock()
    await render(<Harness api={api} />)
    const second: TessChange = {
      ...CHANGE,
      id: 'c2',
      summary: 'Add a game against Demo Eagles on Sunday at 10'
    }
    await loaded(api, [
      HISTORY[0],
      { ...HISTORY[1], changes: [CHANGE, second] }
    ])
    const pills = (): HTMLElement[] => [
      ...document.body.querySelectorAll<HTMLElement>(
        '[aria-label="Hold to confirm"], [aria-label="Confirming…"]'
      )
    ]
    await hold()
    expect(api.confirms.map(confirm => confirm.id)).deep.equals(['c1'])
    // The other card keeps its label and takes no hold.
    const other = byLabel('Hold to confirm')
    expect(pills().length).equals(2)
    expect(other.getAttribute('aria-disabled')).equals('true')
    await act(async () => {
      other.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }))
      await new Promise(resolve => setTimeout(resolve, 80))
    })
    await clock.advance(3000)
    expect(api.confirms.length).equals(1)
    let sent: boolean | undefined
    await act(async () => {
      sent = await latest!.send('And the other one', [])
      await latest!.confirm('c2')
    })
    expect(sent).equals(false)
    expect(api.sends.length).equals(0)
    expect(api.confirms.length).equals(1)

    await act(async () => {
      api.confirms[0].answer.resolve({
        change: { ...CHANGE, status: 'done' },
        messages: [message('5', 'assistant', 'The game is on the schedule.')]
      })
    })
    await settle()
    expect(byTestId('Tess thinking')).equals(null)
    const off = (pill: HTMLElement): boolean =>
      pill.getAttribute('aria-disabled') === 'true'
    expect(pills().map(off)).deep.equals([false])

    // A message out holds the cards too.
    await type('Is that all?')
    expect(pills().map(off)).deep.equals([true])
    await act(async () => {
      api.sends[0].answer.resolve([message('6', 'user', 'Is that all?')])
    })
    await settle()
    // Answered, the card the message passed by has expired.
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
        change: { ...CHANGE, status: 'done' }
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
        change: { ...CHANGE, status: 'done' }
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
        change: { ...CHANGE, status: 'done' },
        messages: [message('5', 'assistant', 'The game is on the schedule.')]
      })
    })
    await settle()
    expect(byTestId('Tess live reply')).equals(null)
    expect(texts('Tess reply').at(-1)).includes('The game is on the schedule.')
    // She told no thinking or step: no row, and no time kept.
    expect(latest!.thoughtSeconds).deep.equals({})
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
})
