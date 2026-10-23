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
import { Composer, type ComposerProps } from './Composer'
import type { TessAttachmentRef, TessUpload } from './tessTypes'

afterEach(async () => {
  await unmount()
})

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

async function attachCsv(name: string): Promise<void> {
  await click(byLabel('Attach a file'))
  await act(async () => {
    const event = new window.Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', {
      value: { files: [new window.File(['a,b\n'], name, { type: 'text/csv' })] }
    })
    byTestId('Tess drop zone')!.dispatchEvent(event)
  })
  await settle()
  await settle()
}

describe('Composer', function () {
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
