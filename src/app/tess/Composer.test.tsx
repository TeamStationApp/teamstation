import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { Text } from 'react-native'

import {
  byLabel,
  byTestId,
  click,
  render,
  rerender,
  settle,
  unmount
} from '../../test/tessTestKit'
import {
  Composer,
  type ComposerHandle,
  type ComposerProps,
  editAroundLine,
  insertWords,
  STOP_GUARD_MS
} from './Composer'
import type { TessAttachmentRef, TessUpload } from './tessTypes'
import type { LevelSource } from './useTessMicrophone'

interface Sent {
  text: string
  attachments: TessAttachmentRef[]
  /** An edited queued message's place. */
  seq?: number
}

function field(): HTMLTextAreaElement {
  return byLabel('Ask Tess') as HTMLTextAreaElement
}

async function type(value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      'value'
    )!.set!.call(field(), value)
    field().dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}

/**
 * The cursor put at `start` to `end`, as a click or the arrow keys put it:
 * the field reports it on the key's release.
 */
async function caret(start: number, end = start): Promise<void> {
  await act(async () => {
    field().focus()
    field().setSelectionRange(start, end)
    // A release of the mouse, which also ends any press an earlier test
    // left down, after which the field reports no selection.
    field().dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true }))
  })
}

/** A microphone's loudness that a test plays by hand. */
function levels(): LevelSource & { play: (level: number) => void } {
  const listeners = new Set<(level: number) => void>()
  return {
    subscribe: listener => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    play: level => {
      for (const listener of listeners) listener(level)
    }
  }
}

async function key(init: KeyboardEventInit): Promise<KeyboardEvent> {
  const event = new window.KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    ...init
  })
  await act(async () => {
    field().dispatchEvent(event)
  })
  await settle()
  return event
}

function composer(overrides: Partial<ComposerProps> = {}): {
  sent: Sent[]
  uploads: TessUpload[]
  errors: string[]
  props: ComposerProps
} {
  const sent: Sent[] = []
  const uploads: TessUpload[] = []
  const errors: string[] = []
  const props: ComposerProps = {
    busy: false,
    onSend: async (text, attachments, options) => {
      sent.push({
        text,
        attachments,
        ...(options?.seq == null ? {} : { seq: options.seq })
      })
      return true
    },
    onUpload: async upload => {
      uploads.push(upload)
      return {
        id: `a${uploads.length}`,
        name: upload.name,
        kind: 'csv',
        described: false
      }
    },
    onError: message => errors.push(message),
    ...overrides
  }
  return { sent, uploads, errors, props }
}

async function attachCsv(name: string, type = 'text/csv'): Promise<void> {
  await dropCsvs([name], type)
}

/** Opens the panel and drops these CSV files on it at once. */
async function dropCsvs(names: string[], type = 'text/csv'): Promise<void> {
  await click(byLabel('Attach a file'))
  await act(async () => {
    const event = new window.Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', {
      value: {
        files: names.map(name => new window.File(['a,b\n'], name, { type }))
      }
    })
    byTestId('Tess drop zone')!.dispatchEvent(event)
  })
  await settle()
  await settle()
}

function chipCount(): number {
  return document.body.querySelectorAll('[data-testid="Tess attachment"]')
    .length
}

const TOO_MANY =
  'A message to Tess takes at most 5 files. Send these first, or remove one.'

describe('Composer', function () {
  afterEach(async () => {
    await unmount()
  })

  it('sends on Enter and clears the field', async function () {
    const { sent, props } = composer()
    await render(<Composer {...props} />)
    await type('  Where are my team settings?  ')
    const enter = await key({ key: 'Enter' })
    expect(enter.defaultPrevented).equals(true)
    expect(sent).deep.equals([
      { text: 'Where are my team settings?', attachments: [] }
    ])
    expect(field().value).equals('')
  })

  it('leaves Shift+Enter to the field as a new line', async function () {
    const { sent, props } = composer()
    await render(<Composer {...props} />)
    await type('First line')
    const shifted = await key({ key: 'Enter', shiftKey: true })
    expect(shifted.defaultPrevented).equals(false)
    // The iOS field's native name is not the web's element id.
    expect(field().hasAttribute('id')).equals(false)
    await key({ key: 'Enter', isComposing: true })
    await key({ key: 'a' })
    expect(sent).deep.equals([])
    expect(field().value).equals('First line')
  })

  it('is one line, and grows with what it holds to six lines, then scrolls', async function () {
    const { props } = composer()
    await render(<Composer {...props} />)
    expect(field().getAttribute('rows')).equals('1')
    // jsdom lays nothing out: the field's content is as tall as this says,
    // its padding (24) and its lines (22 each).
    let lines = 1
    Object.defineProperty(field(), 'scrollHeight', {
      configurable: true,
      get: () => 24 + 22 * lines
    })
    const height = (): string => field().style.height
    await type('a')
    expect(height()).equals('48px')
    lines = 3
    await type('a\nb\nc')
    expect(height()).equals('92px')
    lines = 9
    await type('a\nb\nc\nd\ne\nf\ng\nh\ni')
    expect(height(), 'six lines, and it scrolls').equals('158px')
    lines = 1
    await key({ key: 'Enter' })
    expect(field().value).equals('')
    expect(height()).equals('48px')
  })

  it('measures its height again when its width changes, as the draft wraps anew', async function () {
    // What the browser would tell of the field's size, by hand.
    const observed: Array<(entries: unknown[]) => void> = []
    let disconnected = 0
    const realObserver = (globalThis as { ResizeObserver?: unknown })
      .ResizeObserver
    ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      constructor(report: (entries: unknown[]) => void) {
        observed.push(report)
      }

      observe(): void {}
      disconnect(): void {
        disconnected += 1
      }
    }
    try {
      const { props } = composer()
      await render(<Composer {...props} />)
      let lines = 2
      Object.defineProperty(field(), 'scrollHeight', {
        configurable: true,
        get: () => 24 + 22 * lines
      })
      await type('a long draft that wraps')
      expect(field().style.height).equals('70px')
      expect(observed).length(1)
      const resized = async (width: number): Promise<void> => {
        await act(async () => {
          observed[0]([{ contentRect: { width } }])
        })
      }
      // Narrower, it wraps to four lines; the same width again measures
      // nothing new; and a report without an entry is no width.
      lines = 4
      await resized(240)
      expect(field().style.height).equals('114px')
      await resized(240)
      await act(async () => {
        observed[0]([])
      })
      lines = 1
      await resized(520)
      expect(field().style.height).equals('48px')
      await unmount()
      expect(disconnected).equals(1)
    } finally {
      ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver =
        realObserver
    }
  })

  it('has a small + with no border or fill, in the secondary text colour', async function () {
    const { props } = composer()
    await render(<Composer {...props} />)
    const plus = byLabel('Attach a file')
    const style = getComputedStyle(plus)
    expect([style.width, style.height]).deep.equals(['32px', '32px'])
    // jsdom leaves a property no style set empty.
    expect(['', '0px']).includes(style.borderTopWidth)
    expect(['', 'rgba(0, 0, 0, 0)']).includes(style.backgroundColor)
    expect(getComputedStyle(plus.firstElementChild!).color).equals(
      'rgb(92, 107, 85)'
    )
  })

  it('sends with the button only when there is something to send', async function () {
    const { sent, props } = composer()
    await render(<Composer {...props} />)
    const send = byLabel('Send')
    expect(send.getAttribute('aria-disabled')).equals('true')
    await click(send)
    await key({ key: 'Enter' })
    expect(sent).deep.equals([])
    await type('Hello')
    await click(byLabel('Send'))
    await settle()
    expect(sent).deep.equals([{ text: 'Hello', attachments: [] }])
  })

  it('sends while Tess answers, with the button or Enter, for the chat to queue', async function () {
    const { sent, props } = composer({ busy: true, onStop: () => undefined })
    await render(<Composer {...props} />)
    await type('Then the playoffs')
    const send = byLabel('Send')
    expect(send.getAttribute('aria-disabled')).not.equals('true')
    await click(send)
    await settle()
    expect(field().value).equals('')
    await type('And the roster')
    const enter = await key({ key: 'Enter' })
    expect(enter.defaultPrevented).equals(true)
    expect(sent).deep.equals([
      { text: 'Then the playoffs', attachments: [] },
      { text: 'And the roster', attachments: [] }
    ])
  })

  it('edits a queued message in place of the draft, and sends it back to its place', async function () {
    const handle = React.createRef<ComposerHandle>()
    const { sent, props } = composer({ busy: true })
    await render(<Composer {...props} handle={handle} />)
    await attachCsv('draft.csv')
    await type('An unsent draft')
    const files = [
      { id: 'a7', name: 'runs.csv', kind: 'csv' as const, described: false }
    ]
    await act(async () => {
      handle.current!.edit({ text: 'Queued words', attachments: files, seq: 4 })
    })
    // The draft, its file too, is gone.
    expect(field().value).equals('Queued words')
    expect(
      [
        ...document.body.querySelectorAll('[data-testid="Tess attachment"]')
      ].map(chip => chip.textContent)
    ).deep.equals(['attach_fileruns.csvclose'])
    await type('Queued words, edited')
    // The draft as it is now, for the chat to put back if another is edited.
    expect(handle.current!.draft()).deep.equals({
      text: 'Queued words, edited',
      attachments: files
    })
    await key({ key: 'Enter' })
    // The next send is a plain one.
    await type('Something new')
    await key({ key: 'Enter' })
    expect(sent).deep.equals([
      { text: 'Queued words, edited', attachments: files, seq: 4 },
      { text: 'Something new', attachments: [] }
    ])
  })

  it('keeps an edited message’s place when its send is given back', async function () {
    const handle = React.createRef<ComposerHandle>()
    let answer = false
    const seqs: Array<number | undefined> = []
    const { props } = composer({
      onSend: async (_text, _attachments, options) => {
        seqs.push(options?.seq)
        return answer
      }
    })
    await render(<Composer {...props} handle={handle} />)
    await act(async () => {
      handle.current!.edit({ text: 'Queued words', attachments: [], seq: 2 })
    })
    await key({ key: 'Enter' })
    expect(field().value).equals('Queued words')
    answer = true
    await key({ key: 'Enter' })
    expect(seqs).deep.equals([2, 2])
  })

  it('keeps a queued message being edited through an emptied field, and sends what is typed next at its place', async function () {
    const handle = React.createRef<ComposerHandle>()
    const { sent, props } = composer({ busy: true })
    await render(<Composer {...props} handle={handle} />)
    await act(async () => {
      handle.current!.edit({ text: 'Queued words', attachments: [], seq: 3 })
    })
    await type('')
    await type('Reworded')
    await key({ key: 'Enter' })
    // The next send is a plain one.
    await type('Something new')
    await key({ key: 'Enter' })
    expect(sent).deep.equals([
      { text: 'Reworded', attachments: [], seq: 3 },
      { text: 'Something new', attachments: [] }
    ])
  })

  it('is Stop only while Tess answers and the draft is empty, and Send once there is something', async function () {
    let stops = 0
    const { sent, props } = composer({
      busy: true,
      onStop: () => {
        stops += 1
      }
    })
    const labelled = (label: string): HTMLElement | null =>
      document.body.querySelector<HTMLElement>(`[aria-label="${label}"]`)
    await render(<Composer {...props} />)
    expect(labelled('Send')).equals(null)
    expect(labelled('Stop Tess')!.textContent).equals('stop')
    await click(byLabel('Stop Tess'))
    expect(stops).equals(1)
    // A letter typed: Send, which the chat queues.
    await type('A')
    expect(labelled('Stop Tess')).equals(null)
    expect(byLabel('Send').getAttribute('aria-disabled')).not.equals('true')
    expect(sent).deep.equals([])
    // Only white space is nothing to send.
    await type('  ')
    expect(labelled('Stop Tess')).not.equals(null)
    // A file is something to send.
    await type('')
    await attachCsv('runs.csv')
    expect(labelled('Stop Tess')).equals(null)
    expect(byLabel('Send').getAttribute('aria-disabled')).not.equals('true')
    // Free again, and empty: Send, disabled.
    await rerender(<Composer {...props} busy={false} />)
    await click(byLabel('Remove runs.csv'))
    expect(labelled('Stop Tess')).equals(null)
    expect(byLabel('Send').getAttribute('aria-disabled')).equals('true')
    // With no way to stop, it stays Send while she answers.
    await rerender(<Composer {...props} onStop={undefined} />)
    expect(labelled('Stop Tess')).equals(null)
    expect(stops).equals(1)
  })

  it('sends once and stops nothing on a double press of Send while Tess answers', async function () {
    let stops = 0
    const { sent, props } = composer({
      busy: true,
      onStop: () => {
        stops += 1
      }
    })
    const realNow = Date.now
    let now = 1000
    Date.now = () => now
    try {
      await render(<Composer {...props} />)
      await type('Then the playoffs')
      await click(byLabel('Send'))
      // The draft is empty: the second press lands on Stop, and is ignored.
      await click(byLabel('Stop Tess'))
      now += STOP_GUARD_MS - 1
      await click(byLabel('Stop Tess'))
      expect(sent).deep.equals([{ text: 'Then the playoffs', attachments: [] }])
      expect(stops).equals(0)
      // Pressed once the moment has passed, it stops her.
      now += 1
      await click(byLabel('Stop Tess'))
      expect(stops).equals(1)
    } finally {
      Date.now = realNow
    }
  })

  it('gives the draft and its files back when the send fails', async function () {
    const { props } = composer({ onSend: async () => false })
    await render(<Composer {...props} />)
    await attachCsv('runs.csv')
    await type('Chart these')
    await key({ key: 'Enter' })
    await settle()
    expect(field().value).equals('Chart these')
    expect(byTestId('Tess attachment')!.textContent).includes('runs.csv')
  })

  it('attaches through the panel, shows chips with remove buttons, and sends them', async function () {
    const { sent, uploads, props } = composer()
    await render(<Composer {...props} />)
    expect(byTestId('Tess attach panel')).equals(null)
    await attachCsv('runs.csv')
    await attachCsv('hits.csv')
    expect(uploads.map(upload => upload.name)).deep.equals([
      'runs.csv',
      'hits.csv'
    ])
    expect(byTestId('Tess attach panel')).equals(null)
    const chips = [
      ...document.body.querySelectorAll('[data-testid="Tess attachment"]')
    ].map(chip => chip.textContent)
    expect(chips).deep.equals([
      'attach_fileruns.csvclose',
      'attach_filehits.csvclose'
    ])
    await click(byLabel('Remove runs.csv'))
    await click(byLabel('Send'))
    await settle()
    expect(sent).deep.equals([
      {
        text: '',
        attachments: [
          { id: 'a2', name: 'hits.csv', kind: 'csv', described: false }
        ]
      }
    ])
    expect(byTestId('Tess attachment')).equals(null)
  })

  it('refuses a sixth file as it is taken, and + says so rather than open', async function () {
    const { sent, uploads, errors, props } = composer()
    await render(<Composer {...props} />)
    await dropCsvs(['1.csv', '2.csv', '3.csv', '4.csv', '5.csv', '6.csv'])
    expect(uploads.map(upload => upload.name)).deep.equals([
      '1.csv',
      '2.csv',
      '3.csv',
      '4.csv',
      '5.csv'
    ])
    expect(errors).deep.equals([TOO_MANY])
    expect(chipCount()).equals(5)
    await click(byLabel('Attach a file'))
    expect(byTestId('Tess attach panel')).equals(null)
    expect(errors).deep.equals([TOO_MANY, TOO_MANY])
    // One removed, there is room for one more.
    await click(byLabel('Remove 1.csv'))
    await attachCsv('7.csv')
    expect(chipCount()).equals(5)
    expect(errors.length).equals(2)
    await click(byLabel('Send'))
    await settle()
    expect(sent[0].attachments.map(attachment => attachment.name)).deep.equals([
      '2.csv',
      '3.csv',
      '4.csv',
      '5.csv',
      '7.csv'
    ])
  })

  it('holds a draft that came back with more files than a message takes, until one is removed', async function () {
    let fail: (sent: boolean) => void = () => undefined
    const { sent, errors, props } = composer({
      onSend: async (text, attachments) => {
        sent.push({ text, attachments })
        return await new Promise<boolean>(resolve => {
          fail = resolve
        })
      }
    })
    const handle = React.createRef<ComposerHandle>()
    await render(<Composer {...props} handle={handle} />)
    await dropCsvs(['1.csv', '2.csv', '3.csv'])
    await click(byLabel('Send'))
    await settle()
    // More taken while the first three are out.
    await dropCsvs(['4.csv', '5.csv', '6.csv'])
    await act(async () => {
      fail(false)
    })
    await settle()
    expect(chipCount()).equals(6)
    expect(errors).deep.equals([TOO_MANY])
    expect(byLabel('Send').getAttribute('aria-disabled')).equals('true')
    // What is said waits in the field.
    await act(async () => {
      handle.current!.insertDictation('Chart them')
    })
    expect(sent.length).equals(1)
    expect(field().value).equals('Chart them')
    await click(byLabel('Remove 6.csv'))
    expect(byLabel('Send').getAttribute('aria-disabled')).not.equals('true')
  })

  it('toggles the panel with +, and shows nothing for a refused upload', async function () {
    const { props } = composer({ onUpload: async () => null })
    await render(<Composer {...props} />)
    await click(byLabel('Attach a file'))
    expect(byLabel('Attach a file').getAttribute('aria-expanded')).equals(
      'true'
    )
    await click(byLabel('Attach a file'))
    expect(byTestId('Tess attach panel')).equals(null)
    await attachCsv('runs.csv')
    expect(byTestId('Tess attachment')).equals(null)
  })

  it('waits for an upload before it sends', async function () {
    let finish: (attachment: TessAttachmentRef) => void = () => undefined
    const { props } = composer({
      onUpload: async () =>
        await new Promise<TessAttachmentRef>(resolve => {
          finish = resolve
        })
    })
    await render(<Composer {...props} />)
    await attachCsv('runs.csv')
    expect(document.body.textContent).includes('Attaching…')
    await type('Chart these')
    expect(byLabel('Send').getAttribute('aria-disabled')).equals('true')
    await act(async () => {
      finish({ id: 'a1', name: 'runs.csv', kind: 'csv', described: false })
    })
    await settle()
    expect(document.body.textContent).not.includes('Attaching…')
    expect(byLabel('Send').getAttribute('aria-disabled')).not.equals('true')
  })

  it('counts a dropped file as uploading while it is still being read, so Enter does not send without it', async function () {
    const { sent, uploads, errors, props } = composer()
    const handle = React.createRef<ComposerHandle>()
    await render(<Composer {...props} handle={handle} />)
    await type('Chart these')
    let read: () => void = () => undefined
    const csv = new window.File(['a,b\n'], 'runs.csv', { type: 'text/csv' })
    csv.arrayBuffer = async () =>
      await new Promise<ArrayBuffer>(resolve => {
        read = () => {
          resolve(new Uint8Array(Buffer.from('a,b\n')).buffer)
        }
      })
    await click(byLabel('Attach a file'))
    await act(async () => {
      const event = new window.Event('drop', {
        bubbles: true,
        cancelable: true
      })
      Object.defineProperty(event, 'dataTransfer', { value: { files: [csv] } })
      byTestId('Tess drop zone')!.dispatchEvent(event)
    })
    // The panel has closed and the file is still being read.
    expect(byTestId('Tess attach panel')).equals(null)
    expect(uploads).deep.equals([])
    expect(document.body.textContent).includes('Attaching…')
    expect(byLabel('Send').getAttribute('aria-disabled')).equals('true')
    await key({ key: 'Enter' })
    await caret('Chart these'.length)
    await act(async () => {
      handle.current!.insertDictation('by game')
    })
    expect(sent).deep.equals([])
    expect(field().value).equals('Chart these by game')

    await act(async () => {
      read()
    })
    await settle()
    await settle()
    expect(uploads.map(upload => upload.name)).deep.equals(['runs.csv'])
    await key({ key: 'Enter' })
    expect(sent).deep.equals([
      {
        text: 'Chart these by game',
        attachments: [
          { id: 'a1', name: 'runs.csv', kind: 'csv', described: false }
        ]
      }
    ])
    expect(errors).deep.equals([])
  })

  it('says why a file could not be read, and lets the message go without it', async function () {
    const { sent, errors, props } = composer()
    await render(<Composer {...props} />)
    await type('Chart these')
    await attachCsv('scores.pdf', 'application/pdf')
    expect(errors).deep.equals([
      'Tess reads images, CSV, plain text and Markdown files.'
    ])
    expect(document.body.textContent).not.includes('Attaching…')
    await key({ key: 'Enter' })
    expect(sent).deep.equals([{ text: 'Chart these', attachments: [] }])
  })

  it('puts what was said at the cursor, a space from the words beside it, and sends nothing', async function () {
    const { sent, props } = composer()
    const handle = React.createRef<ComposerHandle>()
    await render(<Composer {...props} handle={handle} />)
    // An empty field takes the words as they are.
    await act(async () => {
      handle.current!.insertDictation('  Hello world  ')
    })
    expect(field().value).equals('Hello world')
    expect(field().selectionStart).equals('Hello world'.length)
    // After "Hello": spaced both sides, the cursor after them.
    await caret('Hello'.length)
    await act(async () => {
      handle.current!.insertDictation('there')
    })
    expect(field().value).equals('Hello there world')
    expect([field().selectionStart, field().selectionEnd]).deep.equals([11, 11])
    // A selection is replaced.
    await caret('Hello '.length, 'Hello there'.length)
    await act(async () => {
      handle.current!.insertDictation('again')
    })
    expect(field().value).equals('Hello again world')
    // Nothing heard is nothing put in.
    await act(async () => {
      handle.current!.insertDictation(' ')
    })
    expect(field().value).equals('Hello again world')
    expect(sent).deep.equals([])
    await key({ key: 'Enter' })
    expect(sent).deep.equals([{ text: 'Hello again world', attachments: [] }])
  })

  it('puts what was said after a send given back at the end of its words, where the cursor shows', async function () {
    const { props } = composer({ onSend: async () => false })
    const handle = React.createRef<ComposerHandle>()
    await render(<Composer {...props} handle={handle} />)
    await type('Plan the season')
    await key({ key: 'Enter' })
    await settle()
    expect(field().value).equals('Plan the season')
    expect([field().selectionStart, field().selectionEnd]).deep.equals([
      'Plan the season'.length,
      'Plan the season'.length
    ])
    await act(async () => {
      handle.current!.insertDictation('and the playoffs')
    })
    expect(field().value).equals('Plan the season and the playoffs')
  })

  it('spaces inserted words from a word either side, and not from closing punctuation', function () {
    const at = (
      start: number,
      end = start
    ): { start: number; end: number } => ({
      start,
      end
    })
    expect(insertWords('', at(0), 'Hi')).deep.equals({ text: 'Hi', caret: 2 })
    expect(insertWords('Hello', at(5), 'there')).deep.equals({
      text: 'Hello there',
      caret: 11
    })
    expect(insertWords('world', at(0), 'Hello')).deep.equals({
      text: 'Hello world',
      caret: 5
    })
    expect(insertWords('Hello world', at(6), 'big')).deep.equals({
      text: 'Hello big world',
      caret: 9
    })
    expect(insertWords('Hello world', at(5), 'there').text).equals(
      'Hello there world'
    )
    for (const mark of ['.', ',', '?', '!', ';', ':', ')', '’'])
      expect(insertWords(`Hello${mark}`, at(5), 'there').text).equals(
        `Hello there${mark}`
      )
    expect(insertWords('Hello\nworld', at(5), 'there').text).equals(
      'Hello there\nworld'
    )
    expect(insertWords('Hello (world)', at(6), 'big').text).equals(
      'Hello big (world)'
    )
    // A cursor past the end, or backwards, is held within the text.
    expect(insertWords('Hello', at(9), 'there').text).equals('Hello there')
    expect(insertWords('Hello', at(4, 2), 'p').text).equals('Hell p o')
  })

  it('adds an empty line for the waveform while recording with text, and takes it away after', async function () {
    const { sent, props } = composer()
    const handle = React.createRef<ComposerHandle>()
    const heard = levels()
    await render(<Composer {...props} handle={handle} />)
    await type('Hello world')
    await caret('Hello'.length)
    expect(byTestId('Tess waveform')).equals(null)
    await rerender(<Composer {...props} handle={handle} dictating={heard} />)
    // The field shows a line after the words for the waveform; the cursor
    // stays after "Hello".
    expect(field().value).equals('Hello world\n')
    expect(field().selectionStart).equals(5)
    const wave = byTestId('Tess waveform')!
    expect(field().parentElement!.contains(wave)).equals(true)
    const strip = getComputedStyle(wave.parentElement!)
    expect([strip.position, strip.left]).deep.equals(['absolute', '80%'])
    // Typed while it records, the words are the draft's, the line is not.
    await type('Hello world!\n')
    expect(field().value).equals('Hello world!\n')
    await rerender(<Composer {...props} handle={handle} />)
    expect(field().value).equals('Hello world!')
    expect(byTestId('Tess waveform')).equals(null)
    // Its words go in where the cursor was, and the line has gone.
    await rerender(<Composer {...props} handle={handle} dictating={heard} />)
    await caret('Hello'.length)
    await act(async () => {
      heard.play(0.2)
    })
    await rerender(<Composer {...props} handle={handle} />)
    await act(async () => {
      handle.current!.insertDictation('there')
    })
    expect(field().value).equals('Hello there world!')
    expect(sent).deep.equals([])
    await key({ key: 'Enter' })
    expect(sent).deep.equals([{ text: 'Hello there world!', attachments: [] }])
  })

  it('tells the waveform’s line from the draft by where the edit is', function () {
    // Within the draft.
    expect(editAroundLine('Hello', 'Hallo\n')).deep.equals({
      text: 'Hallo',
      lineGone: false
    })
    expect(editAroundLine('Hello', 'Hello!\n')).deep.equals({
      text: 'Hello!',
      lineGone: false
    })
    // The line taken away: the draft's own newline stays.
    expect(editAroundLine('hello\n', 'hello\n')).deep.equals({
      text: 'hello\n',
      lineGone: true
    })
    expect(editAroundLine('Hello', '')).deep.equals({
      text: '',
      lineGone: true
    })
    // Typed on the line: the draft's, at its end, without the line's newline.
    expect(editAroundLine('hello\n', 'hello\n\nX')).deep.equals({
      text: 'hello\nX',
      lineGone: false,
      caret: 7
    })
    expect(editAroundLine('hello', 'hello\nX')).deep.equals({
      text: 'helloX',
      lineGone: false,
      caret: 6
    })
  })

  it('keeps the draft’s own newline when the waveform’s line is taken away, and sends none of the line', async function () {
    const { sent, props } = composer()
    const heard = levels()
    await render(<Composer {...props} />)
    await type('hello\n')
    await rerender(<Composer {...props} dictating={heard} />)
    expect(field().value).equals('hello\n\n')
    // Backspace on the line: it goes, and the draft keeps its newline.
    await type('hello\n')
    expect(field().value).equals('hello\n')
    await type('hello\nthere')
    expect(field().value).equals('hello\nthere')
    await key({ key: 'Enter' })
    expect(sent).deep.equals([{ text: 'hello\nthere', attachments: [] }])
    // Gone until the next recording; typed on its line then, the words are
    // the draft's and the line stays.
    await type('hello')
    expect(field().value).equals('hello')
    await rerender(<Composer {...props} />)
    await rerender(<Composer {...props} dictating={heard} />)
    expect(field().value).equals('hello\n')
    await type('hello\nX')
    expect(field().value).equals('helloX\n')
    expect(field().selectionStart).equals(6)
    await key({ key: 'Enter' })
    expect(sent.at(-1)).deep.equals({ text: 'helloX', attachments: [] })
  })

  it('records on the single line of an empty field, adding none', async function () {
    const { props } = composer()
    await render(<Composer {...props} dictating={levels()} />)
    expect(field().value).equals('')
    expect(byTestId('Tess waveform')).not.equals(null)
  })

  it('gives a failed draft back ahead of what was said since', async function () {
    let fail: (delivered: boolean) => void = () => undefined
    const { props } = composer({
      onSend: async () =>
        await new Promise<boolean>(resolve => {
          fail = resolve
        })
    })
    const handle = React.createRef<ComposerHandle>()
    await render(<Composer {...props} handle={handle} />)
    await type('Add a game')
    await key({ key: 'Enter' })
    expect(field().value).equals('')
    await rerender(<Composer {...props} busy handle={handle} />)
    await act(async () => {
      handle.current!.insertDictation('on Saturday')
    })
    await act(async () => {
      fail(false)
    })
    await settle()
    expect(field().value).equals('Add a game on Saturday')
  })

  it('shows the error under the field, and the microphone right of Send, with text too', async function () {
    const { props } = composer()
    await render(
      <Composer
        {...props}
        error="Tess could not answer. Please try again."
        mic={<Text testID="mic">mic</Text>}
      />
    )
    expect(byTestId('Tess error')!.textContent).equals(
      'Tess could not answer. Please try again.'
    )
    const row = (): HTMLElement => byLabel('Send').parentElement!
    expect(row().lastElementChild).equals(byTestId('mic'))
    await type('Hello')
    expect(row().lastElementChild).equals(byTestId('mic'))
    expect(row().contains(field())).equals(true)
  })
})
