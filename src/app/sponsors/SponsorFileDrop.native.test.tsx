import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React from 'react'
import type {
  ImageLibraryOptions,
  ImagePickerResponse
} from 'react-native-image-picker'

import { mount, press, settle, text, unmount } from '../../test/gameFormDom'
import { SponsorFileDrop } from './SponsorFileDrop.native'
import type { PickedFile } from './sponsorTypes'

afterEach(async () => {
  await unmount()
})

/** Mounts the phone's chooser over an album that answers `response`. */
async function mountChooser(
  accept: string,
  response: ImagePickerResponse | Error,
  error?: string
): Promise<{ picked: PickedFile[]; asked: ImageLibraryOptions[] }> {
  const picked: PickedFile[] = []
  const asked: ImageLibraryOptions[] = []
  await mount(
    <SponsorFileDrop
      label="Add Logo"
      accept={accept}
      error={error}
      onPick={file => picked.push(file)}
      launch={async options => {
        asked.push(options)
        if (response instanceof Error) throw response
        return response
      }}
    />
  )
  return { picked, asked }
}

describe('U10 the phone’s sponsor file chooser', () => {
  it('opens the photo album for one picture for a logo or row image', async () => {
    const { picked, asked } = await mountChooser('image/png', {
      assets: [
        { uri: 'file:///tmp/a.png', fileName: 'a.png', type: 'image/png' }
      ]
    })
    expect(text()).includes('Add Logo')
    await press('Choose from Photos: Add Logo')
    await settle(0)
    expect(asked.map(options => options.mediaType)).deep.equals(['photo'])
    expect(picked.map(file => file.name)).deep.equals(['a.png'])
  })

  it('opens the album’s videos for a reel', async () => {
    const { asked } = await mountChooser('video/*', { didCancel: true })
    await press('Choose from Photos: Add Logo')
    await settle(0)
    expect(asked.map(options => options.mediaType)).deep.equals(['video'])
  })

  it('does nothing for a cancelled pick', async () => {
    const { picked } = await mountChooser('image/png', { didCancel: true })
    await press('Choose from Photos: Add Logo')
    await settle(0)
    expect(picked).deep.equals([])
    expect(document.querySelector('[role="alert"]')).equals(null)
  })

  it('says why the album could not be opened, and shows the screen’s refusal', async () => {
    await mountChooser('image/png', { errorCode: 'permission' })
    await press('Choose from Photos: Add Logo')
    await settle(0)
    expect(text()).includes(
      'The photo library could not be opened. Please try again.'
    )
    await unmount()
    await mountChooser(
      'image/png',
      new Error('denied'),
      'Logos must be PNG files.'
    )
    expect(text()).includes('Logos must be PNG files.')
    await press('Choose from Photos: Add Logo')
    await settle(0)
    expect(text()).includes('denied')
  })
})
