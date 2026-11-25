import { expect } from 'chai'
import { describe, it } from 'mocha'
import type {
  ImageLibraryOptions,
  ImagePickerResponse
} from 'react-native-image-picker'

import {
  ALBUM_UNAVAILABLE,
  pickedFileOfAsset,
  pickFromLibrary,
  readVideoDuration
} from './pickedFiles.native'

/** An album that answers `response` and records what it was asked. */
function album(response: ImagePickerResponse): {
  launch: (options: ImageLibraryOptions) => Promise<ImagePickerResponse>
  asked: ImageLibraryOptions[]
} {
  const asked: ImageLibraryOptions[] = []
  return {
    asked,
    launch: async options => {
      asked.push(options)
      return response
    }
  }
}

describe('U10 files picked from a phone’s photo album', () => {
  it('opens the album for one photo, or one video, as it is stored', async () => {
    for (const kind of ['photo', 'video'] as const) {
      const fake = album({ didCancel: true })
      await pickFromLibrary(fake.launch, kind)
      expect(fake.asked).deep.equals([
        {
          mediaType: kind,
          selectionLimit: 1,
          assetRepresentationMode: 'current'
        }
      ])
    }
  })

  it('answers nothing for a cancelled pick, or one with no asset', async () => {
    expect(
      await pickFromLibrary(album({ didCancel: true }).launch, 'photo')
    ).equals(null)
    expect(await pickFromLibrary(album({ assets: [] }).launch, 'photo')).equals(
      null
    )
    expect(
      await pickFromLibrary(
        album({ assets: [{ fileName: 'x.png' }] }).launch,
        'photo'
      )
    ).equals(null)
  })

  it('says when the album could not be opened', async () => {
    let caught: unknown
    try {
      await pickFromLibrary(album({ errorCode: 'permission' }).launch, 'photo')
    } catch (error) {
      caught = error
    }
    expect((caught as Error).message).equals(ALBUM_UNAVAILABLE)
  })

  it('takes a picture’s name, type, size, file and dimensions, calling image/jpg image/jpeg', async () => {
    const picked = await pickFromLibrary(
      album({
        assets: [
          {
            uri: 'file:///tmp/IMG_1.jpg',
            fileName: 'IMG_1.jpg',
            type: 'image/jpg',
            fileSize: 2048,
            width: 1200,
            height: 800
          }
        ]
      }).launch,
      'photo'
    )
    expect(picked).deep.equals({
      name: 'IMG_1.jpg',
      type: 'image/jpeg',
      size: 2048,
      url: 'file:///tmp/IMG_1.jpg',
      width: 1200,
      height: 800
    })
  })

  it('takes a video’s length from the album', async () => {
    const picked = pickedFileOfAsset(
      { uri: 'file:///tmp/clip.mov', type: 'video/quicktime', duration: 12.5 },
      'video'
    )
    expect(picked).deep.equals({
      name: 'clip.mov',
      type: 'video/quicktime',
      size: 0,
      url: 'file:///tmp/clip.mov',
      durationSec: 12.5
    })
    expect(await readVideoDuration(picked!)).equals(12.5)
  })

  it('names a file by its path, and gives a video with no type MP4', () => {
    expect(pickedFileOfAsset({ uri: 'file:///tmp/' }, 'video')).deep.include({
      name: 'file',
      type: 'video/mp4'
    })
    expect(pickedFileOfAsset({ uri: 'content://a/b' }, 'photo')).deep.include({
      name: 'b',
      type: 'application/octet-stream'
    })
  })

  it('refuses a video whose length the album did not give', async () => {
    let caught: unknown
    try {
      await readVideoDuration({
        name: 'a',
        type: 'video/mp4',
        size: 1,
        url: 'x'
      })
    } catch (error) {
      caught = error
    }
    expect((caught as Error).message).equals(
      'This video could not be read. Try another file.'
    )
  })
})
