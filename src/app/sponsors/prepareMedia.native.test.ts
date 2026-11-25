import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import { SponsorRuleError } from '../../common/sponsors/sponsorRules'
import { installStandIns } from '../../test/moduleStandIns'
import type * as Native from './prepareMedia.native'
import type { PickedFile } from './sponsorTypes'

/** U9: the phones' shrinking, on a stand-in for the SponsorMedia module. */

const calls: Array<[string, ...unknown[]]> = []
let rejectWith: Error | null = null
let reelBytes = 2_000_000
const answer = async (
  name: string,
  args: unknown[],
  extra = {}
): Promise<never> => {
  calls.push([name, ...args])
  if (rejectWith != null) return await Promise.reject(rejectWith)
  const answered: Record<string, unknown> = {
    uri: `file:///cache/${name}.out`,
    bytes: 9,
    width: 480,
    height: 270,
    ...extra
  }
  return await Promise.resolve(answered as never)
}
const SponsorMedia: Native.SponsorMediaModule = {
  resizeImage: async (...args) => await answer('resizeImage', args),
  cropSquare: async (...args) => await answer('cropSquare', args),
  cropCover: async (...args) => await answer('cropCover', args),
  encodeReel: async (...args) =>
    await answer('encodeReel', args, {
      bytes: reelBytes,
      width: 640,
      height: 360,
      durationMs: 12_400
    })
}

const read: string[] = []
const readBytes = async (uri: string): Promise<Uint8Array> => {
  read.push(uri)
  return new Uint8Array(3)
}

const file = (type: string, extra: Partial<PickedFile> = {}): PickedFile => ({
  name: 'picked',
  type,
  size: 10,
  url: 'file:///album/picked',
  ...extra
})

async function refusal(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run()
  } catch (caught) {
    return caught as Error
  }
  throw new Error('expected a refusal')
}

describe('U9 shrinking sponsor uploads on a phone', () => {
  let native: typeof Native
  let restore = (): void => undefined
  before(async () => {
    restore = installStandIns({
      'react-native': { NativeModules: { SponsorMedia } }
    })
    native = await import('./prepareMedia.native')
  })
  after(() => {
    restore()
  })
  const media = (): Native.NativeMedia => ({ module: SponsorMedia, readBytes })
  const reset = (): void => {
    calls.length = 0
    read.length = 0
    rejectWith = null
    reelBytes = 2_000_000
  }

  it('finds the app’s module among the native modules', () => {
    expect(native.phoneMedia.module).equals(SponsorMedia)
  })

  it('fits a logo in 480 × 270 as PNG and reads its bytes from the result', async () => {
    reset()
    const out = await native.prepareMedia('logo', file('image/png'), media())
    expect(calls).deep.equals([
      ['resizeImage', 'file:///album/picked', 480, 270, 'png']
    ])
    expect(read).deep.equals(['file:///cache/resizeImage.out'])
    expect(out).deep.include({
      type: 'image/png',
      size: 3,
      url: 'file:///cache/resizeImage.out',
      width: 480,
      height: 270
    })
  })

  it('crops a row logo to a 128 square and a background to 1920 × 224, keeping JPEG or PNG', async () => {
    reset()
    const logo = await native.prepareMedia(
      'rowLogo',
      file('image/jpeg'),
      media()
    )
    const background = await native.prepareMedia(
      'rowBackground',
      file('image/png'),
      media()
    )
    expect(calls).deep.equals([
      ['cropSquare', 'file:///album/picked', 128, 'jpeg'],
      ['cropCover', 'file:///album/picked', 1920, 224, 'png']
    ])
    expect(logo.type).equals('image/jpeg')
    expect(background.type).equals('image/png')
  })

  it('encodes a reel within 640 × 360 at 30 fps, 1 Mbit/s and AAC 128 kbit/s', async () => {
    reset()
    const out = await native.prepareMedia(
      'reel',
      file('video/quicktime', { durationSec: 12.4 }),
      media()
    )
    expect(calls).deep.equals([
      [
        'encodeReel',
        'file:///album/picked',
        {
          width: 640,
          height: 360,
          fps: 30,
          videoBitrate: 1_000_000,
          audioBitrate: 128_000
        }
      ]
    ])
    expect(out).deep.include({
      type: 'video/mp4',
      url: 'file:///cache/encodeReel.out',
      width: 640,
      height: 360,
      durationMs: 12_400,
      durationSec: 12.4
    })
  })

  it('refuses a reel of the wrong length before encoding, and one the album gave no length', async () => {
    reset()
    const long = await refusal(
      async () =>
        await native.prepareMedia(
          'reel',
          file('video/mp4', { durationSec: 20 }),
          media()
        )
    )
    expect(long.message).equals(
      'This reel is 20 seconds. Reels must be 10 to 15 seconds long.'
    )
    const unknown = await refusal(
      async () => await native.prepareMedia('reel', file('video/mp4'), media())
    )
    expect(unknown.message).equals(
      'This video could not be read. Try another file.'
    )
    expect(calls).deep.equals([])
  })

  it('refuses an encoded reel over 3.2 MB', async () => {
    reset()
    reelBytes = 3_200_001
    const error = await refusal(
      async () =>
        await native.prepareMedia(
          'reel',
          file('video/mp4', { durationSec: 12 }),
          media()
        )
    )
    expect(error.message).equals('Reels can be at most 3.2 MB.')
    expect(read).deep.equals([])
  })

  it('surfaces the module’s refusal as its sentence', async () => {
    reset()
    rejectWith = new Error('This video could not be shrunk. Try another file.')
    const error = await refusal(
      async () =>
        await native.prepareMedia(
          'reel',
          file('video/mp4', { durationSec: 12 }),
          media()
        )
    )
    expect(error).instanceOf(SponsorRuleError)
    expect(error.message).equals(
      'This video could not be shrunk. Try another file.'
    )
    rejectWith = new Error('')
    const bare = await refusal(
      async () => await native.prepareMedia('logo', file('image/png'), media())
    )
    expect(bare.message).equals(
      'This file could not be shrunk. Try another file.'
    )
  })

  it('refuses everything when the app has no SponsorMedia module', async () => {
    reset()
    const error = await refusal(
      async () =>
        await native.prepareMedia('logo', file('image/png'), {
          module: undefined,
          readBytes
        })
    )
    expect(error.message).equals(
      'This file could not be shrunk. Try another file.'
    )
  })

  it('reads a result’s bytes through fetch', async () => {
    const fetched: string[] = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (uri: string) => {
      fetched.push(uri)
      return new Response(new Uint8Array([1, 2]))
    }) as typeof fetch
    try {
      const bytes = await native.phoneMedia.readBytes('file:///cache/x')
      expect([...bytes]).deep.equals([1, 2])
      expect(fetched).deep.equals(['file:///cache/x'])
    } finally {
      globalThis.fetch = realFetch
    }
  })
})
