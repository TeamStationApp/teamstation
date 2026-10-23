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
import { Composer, type ComposerHandle, type ComposerProps } from './Composer'
import type { TessAttachmentRef, TessUpload } from './tessTypes'

interface Sent {
  text: string
  attachments: TessAttachmentRef[]
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
    onSend: async (text, attachments) => {
      sent.push({ text, attachments })
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
    await key({ key: 'Enter', isComposing: true })
    await key({ key: 'a' })
    expect(sent).deep.equals([])
    expect(field().value).equals('First line')
  })

  it('sends with the button only when there is something to send and Tess is free', async function () {
    const { sent, props } = composer()
    await render(<Composer {...props} />)
    const send = byLabel('Send')
    expect(send.getAttribute('aria-disabled')).equals('true')
    await click(send)
    await key({ key: 'Enter' })
    expect(sent).deep.equals([])
    await type('Hello')
    await rerender(<Composer {...props} busy />)
    expect(byLabel('Send').getAttribute('aria-disabled')).equals('true')
    await rerender(<Composer {...props} />)
    await click(byLabel('Send'))
    await settle()
    expect(sent).deep.equals([{ text: 'Hello', attachments: [] }])
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
      handle.current!.dictate('Chart them')
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

  it('counts a dropped file as uploading while it is still being read, so neither Enter nor the microphone sends without it', async function () {
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
    await act(async () => {
      handle.current!.dictate('by game')
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

  it('sends what was said with the typed draft and its files, and gives it all back when that fails', async function () {
    let delivered = false
    const { sent, props } = composer({
      onSend: async (text, attachments) => {
        sent.push({ text, attachments })
        return delivered
      }
    })
    const handle = React.createRef<ComposerHandle>()
    await render(<Composer {...props} handle={handle} />)
    await attachCsv('runs.csv')
    await type('Chart these')
    await act(async () => {
      handle.current!.dictate('  for the Hawks  ')
    })
    await settle()
    const runs = { id: 'a1', name: 'runs.csv', kind: 'csv', described: false }
    expect(sent).deep.equals([
      { text: 'Chart these for the Hawks', attachments: [runs] }
    ])
    expect(field().value).equals('Chart these for the Hawks')
    expect(byTestId('Tess attachment')!.textContent).includes('runs.csv')
    delivered = true
    await act(async () => {
      handle.current!.dictate(' ')
    })
    expect(sent.length, 'nothing was said').equals(1)
    await click(byLabel('Send'))
    await settle()
    expect(sent.at(-1)).deep.equals({
      text: 'Chart these for the Hawks',
      attachments: [runs]
    })
    expect(field().value).equals('')
  })

  it('keeps what was said in the field while Tess is answering or a file uploads', async function () {
    let finish: (attachment: TessAttachmentRef) => void = () => undefined
    const { sent, props } = composer({
      onUpload: async () =>
        await new Promise<TessAttachmentRef>(resolve => {
          finish = resolve
        })
    })
    const handle = React.createRef<ComposerHandle>()
    await render(<Composer {...props} busy handle={handle} />)
    await act(async () => {
      handle.current!.dictate('And the schedule?')
    })
    expect(sent).deep.equals([])
    expect(field().value).equals('And the schedule?')
    await rerender(<Composer {...props} handle={handle} />)
    await attachCsv('runs.csv')
    await act(async () => {
      handle.current!.dictate('for Saturday')
    })
    expect(sent).deep.equals([])
    expect(field().value).equals('And the schedule? for Saturday')
    await act(async () => {
      finish({ id: 'a1', name: 'runs.csv', kind: 'csv', described: false })
    })
    await settle()
    await click(byLabel('Send'))
    await settle()
    expect(sent).deep.equals([
      {
        text: 'And the schedule? for Saturday',
        attachments: [
          { id: 'a1', name: 'runs.csv', kind: 'csv', described: false }
        ]
      }
    ])
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
      handle.current!.dictate('on Saturday')
    })
    await act(async () => {
      fail(false)
    })
    await settle()
    expect(field().value).equals('Add a game on Saturday')
  })

  it('shows the error under the field and the microphone centered below it', async function () {
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
    const mic = byTestId('mic')!
    const slot = mic.parentElement!
    expect(getComputedStyle(slot).alignItems).equals('center')
    const parts = [...byTestId('Tess composer')!.children]
    expect(parts.at(-1)).equals(slot)
  })
})
