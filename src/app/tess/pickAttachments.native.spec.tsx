import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { useState } from 'react'

import { documentPicker } from '../../test/stubs/reactNativeDocumentsPicker'
import { imagePicker } from '../../test/stubs/reactNativeImagePicker'
import {
  byLabel,
  click,
  type ManualClock,
  manualClock,
  render,
  settle,
  unmount
} from '../../test/tessTestKit'
import {
  AttachPicker,
  type AttachPickerProps,
  SHEET_DISMISS_MS
} from './AttachPicker.native'
import { DOCUMENT_TYPES } from './nativeAttachments'
import { readPickedFile } from './pickAttachments.native'
import type { TessUpload } from './tessTypes'

let clock: ManualClock | undefined
afterEach(async () => {
  await unmount()
  clock?.restore()
  clock = undefined
  imagePicker.next = { didCancel: true }
  imagePicker.calls = []
  documentPicker.next = []
  documentPicker.calls = []
})

async function sheet(): Promise<{
  attached: TessUpload[]
  errors: string[]
  closed: number[]
}> {
  const attached: TessUpload[] = []
  const errors: string[] = []
  const closed: number[] = []
  clock = manualClock(SHEET_DISMISS_MS)
  await render(
    <Composer
      onAttach={upload => attached.push(upload)}
      onError={message => errors.push(message)}
      onClose={() => closed.push(1)}
    />
  )
  return { attached, errors, closed }
}

/** Shows the sheet until it closes, as the composer does. */
function Composer(props: AttachPickerProps): React.ReactElement | null {
  const [open, setOpen] = useState(true)
  if (!open) return null
  return (
    <AttachPicker
      {...props}
      onClose={() => {
        setOpen(false)
        props.onClose()
      }}
    />
  )
}

/** Taps a choice, lets the sheet go, and lets the picker answer. */
async function choose(label: string): Promise<void> {
  await click(byLabel(label))
  expect(clock!.pending()).deep.equals([SHEET_DISMISS_MS])
  await clock!.advance(SHEET_DISMISS_MS)
  await settle()
  await settle()
}

describe("the phone's + sheet", function () {
  it('offers Photo and File, and Cancel', async function () {
    const { closed } = await sheet()
    expect(document.body.textContent).includes('Attach')
    expect(byLabel('Photo').getAttribute('role')).equals('button')
    expect(byLabel('File').getAttribute('role')).equals('button')
    const cancel = [
      ...document.body.querySelectorAll<HTMLElement>('[role="button"]')
    ].find(node => node.textContent === 'Cancel')!
    await click(cancel)
    expect(closed).deep.equals([1])
    expect(document.body.textContent).not.includes('Photo')
    expect(imagePicker.calls).deep.equals([])
    expect(documentPicker.calls).deep.equals([])
  })

  it('closes, then opens the photo library once the sheet has gone', async function () {
    const { attached, closed } = await sheet()
    imagePicker.next = {
      assets: [{ base64: 'iVBORw==', type: 'image/png', fileName: 'chart.png' }]
    }
    await choose('Photo')
    expect(closed).deep.equals([1])
    expect(imagePicker.calls.length).equals(1)
    expect(attached).deep.equals([
      { name: 'chart.png', mediaType: 'image/png', data: 'iVBORw==' }
    ])
  })

  it('opens the document picker for CSV, text and Markdown, and reads the file', async function () {
    const { attached } = await sheet()
    const csv = 'Team,Runs\nComets,12\n'
    documentPicker.next = [
      {
        uri: `data:text/csv;base64,${Buffer.from(csv).toString('base64')}`,
        name: 'runs.csv',
        error: null,
        type: 'text/csv',
        nativeType: null,
        size: csv.length,
        isVirtual: false,
        convertibleToMimeTypes: null,
        hasRequestedType: true
      }
    ]
    await choose('File')
    // A browser bundle says it is not iOS, so the picker is asked in MIME types.
    expect(documentPicker.calls).deep.equals([
      {
        type: DOCUMENT_TYPES.android,
        allowMultiSelection: false,
        mode: 'import'
      }
    ])
    expect(attached).deep.equals([
      {
        name: 'runs.csv',
        mediaType: 'text/csv',
        data: Buffer.from(csv).toString('base64')
      }
    ])
  })

  it('adds nothing when the picker is cancelled', async function () {
    const { attached, errors } = await sheet()
    documentPicker.next = {
      throws: Object.assign(new Error('cancelled'), {
        code: 'OPERATION_CANCELED'
      })
    }
    await choose('File')
    imagePicker.next = { didCancel: true }
    await unmount()
    await sheet()
    await choose('Photo')
    expect(attached).deep.equals([])
    expect(errors).deep.equals([])
  })

  it('says why a pick failed', async function () {
    const { errors } = await sheet()
    documentPicker.next = { throws: new Error('NULL_PRESENTER') }
    await choose('File')
    expect(errors).deep.equals([
      'The file could not be opened. Please try again.'
    ])
    await unmount()
    const second = await sheet()
    imagePicker.next = { throws: 'the bridge went away' }
    await choose('Photo')
    expect(second.errors).deep.equals(['That file could not be read.'])
  })

  it('reads a picked address as base64', async function () {
    expect(await readPickedFile('data:text/plain;base64,aGk=')).equals('aGk=')
  })
})
