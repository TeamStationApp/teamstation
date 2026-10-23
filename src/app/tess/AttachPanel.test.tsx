import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'

import {
  byLabel,
  byTestId,
  click,
  render,
  settle,
  unmount
} from '../../test/tessTestKit'
import { AttachPanel, readWebFile } from './AttachPanel'
import type { TessUpload } from './tessTypes'
import { IMAGE_LIMIT } from './tessUploads'

function file(
  parts: BlobPart[],
  name: string,
  type: string,
  size?: number
): File {
  const made = new window.File(parts, name, { type })
  if (size != null) Object.defineProperty(made, 'size', { value: size })
  return made
}

async function panel(): Promise<{
  attached: TessUpload[]
  errors: string[]
  closed: number[]
}> {
  const attached: TessUpload[] = []
  const errors: string[] = []
  const closed: number[] = []
  await render(
    <AttachPanel
      onAttach={upload => attached.push(upload)}
      onError={message => errors.push(message)}
      onClose={() => closed.push(1)}
    />
  )
  return { attached, errors, closed }
}

async function drop(files: File[]): Promise<void> {
  const zone = byTestId('Tess drop zone')!
  await act(async () => {
    const over = new window.Event('dragover', {
      bubbles: true,
      cancelable: true
    })
    zone.dispatchEvent(over)
    expect(over.defaultPrevented).equals(true)
  })
  await act(async () => {
    const event = new window.Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', { value: { files } })
    zone.dispatchEvent(event)
    expect(event.defaultPrevented).equals(true)
  })
  await settle()
}

describe('AttachPanel', function () {
  afterEach(async () => {
    await unmount()
  })

  it('accepts files dropped on the zone, refusing those Tess cannot read', async function () {
    const { attached, errors, closed } = await panel()
    expect(byTestId('Tess drop zone')!.textContent).includes('Drop files here')
    await drop([
      file(['Team,Runs\nComets,12\n'], 'runs.csv', 'application/vnd.ms-excel'),
      file(['%PDF'], 'scores.pdf', 'application/pdf')
    ])
    expect(attached).deep.equals([
      {
        name: 'runs.csv',
        mediaType: 'text/csv',
        data: Buffer.from('Team,Runs\nComets,12\n').toString('base64')
      }
    ])
    expect(errors).deep.equals([
      'Tess reads images, CSV, plain text and Markdown files.'
    ])
    expect(closed).deep.equals([1])
  })

  it('lights the zone while a file is over it', async function () {
    await panel()
    const zone = byTestId('Tess drop zone')!
    const before = getComputedStyle(zone).borderColor
    await act(async () => {
      zone.dispatchEvent(
        new window.Event('dragover', { bubbles: true, cancelable: true })
      )
    })
    expect(getComputedStyle(zone).borderColor).not.equals(before)
    await act(async () => {
      zone.dispatchEvent(new window.Event('dragleave', { bubbles: true }))
    })
    expect(getComputedStyle(zone).borderColor).equals(before)
  })

  it('ignores a drop with no files', async function () {
    const { attached, closed } = await panel()
    await drop([])
    expect(attached).deep.equals([])
    expect(closed).deep.equals([])
  })

  it('opens the hidden chooser from Choose files, and takes what is chosen', async function () {
    const { attached, closed } = await panel()
    const input =
      document.body.querySelector<HTMLInputElement>('input[type="file"]')!
    expect(input.multiple).equals(true)
    expect(input.accept).equals(
      'image/*,.csv,.txt,.md,text/csv,text/plain,text/markdown'
    )
    expect(input.style.display).equals('none')
    let opened = 0
    input.click = () => {
      opened++
    }
    await click(
      [...document.body.querySelectorAll<HTMLElement>('[role="button"]')].find(
        node => node.textContent === 'Choose files'
      )!
    )
    expect(opened).equals(1)
    const chosen = file([new Uint8Array([137, 80, 78, 71])], 'chart.png', '')
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [chosen]
    })
    await act(async () => {
      input.dispatchEvent(new window.Event('change', { bubbles: true }))
    })
    await settle()
    expect(attached).deep.equals([
      { name: 'chart.png', mediaType: 'image/png', data: 'iVBORw==' }
    ])
    expect(closed).deep.equals([1])
    expect(byLabel('Choose files').tagName).equals('INPUT')
  })

  it('refuses a file over its limit before reading it', async function () {
    try {
      await readWebFile(file(['x'], 'big.png', 'image/png', IMAGE_LIMIT + 1))
      expect.fail('read a file over the limit')
    } catch (error) {
      expect((error as Error).message).equals('big.png is too large to attach.')
    }
  })

  it('reports an unreadable file in words', async function () {
    const { errors } = await panel()
    const broken = file(['x'], 'notes.md', 'text/markdown')
    // A browser read failure is a DOMException, not always this realm's Error.
    broken.arrayBuffer = async () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw { name: 'NotReadableError' }
    }
    await drop([broken])
    expect(errors).deep.equals(['That file could not be read.'])
  })
})
