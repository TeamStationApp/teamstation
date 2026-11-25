import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'

import { mount, press, unmount } from '../../test/gameFormDom'
import { readVideoDuration } from './pickedFiles'
import { SponsorFileDrop } from './SponsorFileDrop'
import type { PickedFile } from './sponsorTypes'

const urls = { createObjectURL: (file: Blob) => `blob:${(file as File).name}` }

function zone(): HTMLElement {
  const found = document.querySelector<HTMLElement>(
    '[data-testid="sponsor-drop-zone"]'
  )
  expect(found, 'the drop zone').not.equals(null)
  return found!
}

/** A drag event as a browser sends it, carrying `files`, or text. */
function drag(
  type: string,
  carrying: { files?: File[]; text?: string }
): Event {
  const event = new window.Event(type, { bubbles: true, cancelable: true })
  const files = carrying.files ?? []
  Object.defineProperty(event, 'dataTransfer', {
    value: {
      types: files.length > 0 ? ['Files'] : ['text/plain'],
      items: files.map(() => ({ kind: 'file' })),
      files,
      dropEffect: 'none'
    }
  })
  return event
}

const lit = (): string | null => zone().getAttribute('data-over')

async function dispatch(event: Event): Promise<void> {
  await act(async () => {
    zone().dispatchEvent(event)
  })
}

afterEach(async () => {
  await unmount()
})

describe('the sponsor file drop zone', () => {
  const png = new window.File([new Uint8Array(8)], 'Bayside.png', {
    type: 'image/png'
  })

  async function mountZone(error?: string): Promise<PickedFile[]> {
    const picked: PickedFile[] = []
    await mount(
      <SponsorFileDrop
        label="Add Logo"
        prompt="Drop a PNG here or Choose file"
        accept="image/png"
        error={error}
        urls={urls}
        onPick={file => picked.push(file)}
      />
    )
    return picked
  }

  it('takes a dropped file and ignores a drag of text', async () => {
    const picked = await mountZone()
    await dispatch(drag('drop', { text: 'Bayside' }))
    expect(picked).deep.equals([])
    const drop = drag('drop', { files: [png] })
    await dispatch(drop)
    expect(drop.defaultPrevented).equals(true)
    expect(picked).deep.equals([
      {
        name: 'Bayside.png',
        type: 'image/png',
        size: 8,
        url: 'blob:Bayside.png'
      }
    ])
  })

  it('takes the file chosen in the browser’s chooser', async () => {
    const picked = await mountZone()
    const input =
      document.querySelector<HTMLInputElement>('input[type="file"]')!
    expect(input.getAttribute('accept')).equals('image/png')
    let opened = 0
    input.addEventListener('click', () => {
      opened++
    })
    await press('Choose file: Add Logo')
    expect(opened).equals(1)
    Object.defineProperty(input, 'files', { configurable: true, value: [png] })
    await act(async () => {
      input.dispatchEvent(new window.Event('change', { bubbles: true }))
    })
    expect(picked.map(file => file.name)).deep.equals(['Bayside.png'])
  })

  it('lights while a file is over it, and not after it leaves or drops', async () => {
    await mountZone()
    expect(lit()).equals('false')
    await dispatch(drag('dragenter', { text: 'words' }))
    expect(lit()).equals('false')
    await dispatch(drag('dragenter', { files: [png] }))
    expect(lit()).equals('true')
    const over = drag('dragover', { files: [png] })
    await dispatch(over)
    expect(over.defaultPrevented).equals(true)
    expect(lit()).equals('true')
    // Moving onto the zone's own button is not leaving it.
    const inside = drag('dragleave', { files: [png] })
    Object.defineProperty(inside, 'relatedTarget', {
      value: zone().querySelector('[role="button"]')
    })
    await dispatch(inside)
    expect(lit()).equals('true')
    await dispatch(drag('dragleave', { files: [png] }))
    expect(lit()).equals('false')
    await dispatch(drag('dragenter', { files: [png] }))
    expect(lit()).equals('true')
    await dispatch(drag('drop', { files: [png] }))
    expect(lit()).equals('false')
  })

  it('shows the sentence for a refused file under the zone', async () => {
    await mountZone('Logos must be PNG files.')
    const alert = document.querySelector('[role="alert"]')
    expect(alert?.textContent).equals('Logos must be PNG files.')
  })
})

describe('reading a video’s length', () => {
  function stubVideo(): HTMLVideoElement {
    const element = document.createElement('video')
    Object.defineProperty(element, 'duration', { value: 12.5 })
    return element
  }

  it('resolves the length from the video’s metadata', async () => {
    const element = stubVideo()
    const reading = readVideoDuration(
      { url: 'blob:reel' },
      { createVideo: () => element }
    )
    expect(element.getAttribute('src')).equals('blob:reel')
    expect(element.preload).equals('metadata')
    element.dispatchEvent(new window.Event('loadedmetadata'))
    expect(await reading).equals(12.5)
  })

  it('rejects when the video cannot be read', async () => {
    const element = stubVideo()
    const reading = readVideoDuration(
      { url: 'blob:broken' },
      { createVideo: () => element }
    )
    element.dispatchEvent(new window.Event('error'))
    const failure = await reading.then(
      () => null,
      (error: unknown) => (error as Error).message
    )
    expect(failure).equals('This video could not be read. Try another file.')
  })

  it('rejects when the length has not come within its time', async () => {
    const reading = readVideoDuration({ url: 'blob:slow' }, { timeoutMs: 5 })
    const failure = await reading.then(
      () => null,
      (error: unknown) => (error as Error).message
    )
    expect(failure).equals('This video could not be read. Try another file.')
  })
})
