import { expect } from 'chai'
import { describe, it } from 'mocha'

import { SponsorRuleError } from '../../common/sponsors/sponsorRules'
import { pickedFileOf } from './pickedFiles'
import {
  browserMedia,
  type DecodedImage,
  type Mediabunny,
  NO_WEBCODECS,
  NoWebCodecs,
  prepareMedia,
  REEL_ENCODING,
  type WebMedia
} from './prepareMedia'
import type { PickedFile } from './sponsorTypes'

interface Drawn {
  width: number
  height: number
  from: { x: number; y: number; width: number; height: number }
  type?: string
}

interface Converted {
  options: Record<string, unknown>
  executed: boolean
}

/** A browser stand-in: decoded sizes by URL, canvases recorded, Mediabunny faked. */
function fakeMedia({
  sizes = {},
  encoder = true,
  canEncode = true,
  durationSec = 12,
  track = { displayWidth: 3840, displayHeight: 2160 },
  outputBytes = 2_000_000,
  valid = true,
  executeFails = false,
  readFails = false
}: {
  sizes?: Record<string, { width: number; height: number }>
  encoder?: boolean
  canEncode?: boolean
  durationSec?: number
  track?: { displayWidth: number; displayHeight: number } | null
  outputBytes?: number | null
  valid?: boolean
  executeFails?: boolean
  readFails?: boolean
} = {}): {
  media: WebMedia
  drawn: Drawn[]
  converted: Converted[]
  loads: number
  asked: Array<{ codec: string; width: number; height: number }>
} {
  const drawn: Drawn[] = []
  const converted: Converted[] = []
  const asked: Array<{ codec: string; width: number; height: number }> = []
  const record = {
    media: undefined as unknown as WebMedia,
    drawn,
    converted,
    loads: 0,
    asked
  }
  class Quality {
    constructor(readonly value: unknown) {}
  }
  class Output {
    target: { buffer: ArrayBuffer | null }
    constructor(options: { target: { buffer: ArrayBuffer | null } }) {
      this.target = options.target
    }
  }
  const mediabunny = {
    ALL_FORMATS: ['all'],
    BlobSource: class {
      constructor(readonly blob: Blob) {}
    },
    BufferTarget: class {
      buffer: ArrayBuffer | null = null
    },
    Mp4OutputFormat: class {
      readonly kind = 'mp4'
    },
    Output,
    Quality,
    Input: class {
      async computeDuration(): Promise<number> {
        if (readFails) throw new Error('unreadable')
        return durationSec
      }

      async getPrimaryVideoTrack(): Promise<{
        getDisplayWidth: () => Promise<number>
        getDisplayHeight: () => Promise<number>
      } | null> {
        if (track == null) return null
        return {
          getDisplayWidth: async () => track.displayWidth,
          getDisplayHeight: async () => track.displayHeight
        }
      }
    },
    canEncodeVideo: async (
      codec: string,
      size: { width: number; height: number }
    ) => {
      asked.push({ codec, ...size })
      return canEncode
    },
    Conversion: {
      init: async (options: Record<string, unknown>) => {
        const entry: Converted = { options, executed: false }
        converted.push(entry)
        return {
          isValid: valid,
          execute: async () => {
            if (executeFails) throw new Error('encoder stopped')
            entry.executed = true
            ;(options.output as Output).target.buffer =
              outputBytes == null ? null : new ArrayBuffer(outputBytes)
          }
        }
      }
    }
  } as unknown as Mediabunny
  record.media = {
    decodeImage: async url => {
      const size = sizes[url]
      if (size == null)
        throw new SponsorRuleError(
          'This picture could not be read. Try another file.'
        )
      return {
        ...size,
        source: Object.create(null) as CanvasImageSource
      } satisfies DecodedImage
    },
    canvas: (width, height) => {
      const entry: Drawn = {
        width,
        height,
        from: { x: 0, y: 0, width: 0, height: 0 }
      }
      drawn.push(entry)
      return {
        draw: (_image, from) => {
          entry.from = from
        },
        toBytes: async type => {
          entry.type = type
          return new Uint8Array(7)
        }
      }
    },
    readBlob: async () => new Blob([new Uint8Array(5)]),
    objectUrl: (_bytes, type) => `blob:prepared-${type}`,
    hasVideoEncoder: () => encoder,
    loadMediabunny: async () => {
      record.loads++
      return mediabunny
    }
  }
  return record
}

const file = (name: string, type: string, url = name): PickedFile => ({
  name,
  type,
  size: 5,
  url
})

async function refusal(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run()
  } catch (caught) {
    return caught as Error
  }
  throw new Error('expected a refusal')
}

describe('U8 shrinking sponsor uploads on the web', () => {
  it('redraws a 960 × 540 PNG logo at 480 × 270 PNG', async () => {
    const fake = fakeMedia({ sizes: { big: { width: 960, height: 540 } } })
    const out = await prepareMedia(
      'logo',
      file('big.png', 'image/png', 'big'),
      fake.media
    )
    expect(fake.drawn).deep.equals([
      {
        width: 480,
        height: 270,
        from: { x: 0, y: 0, width: 960, height: 540 },
        type: 'image/png'
      }
    ])
    expect(out).deep.include({
      type: 'image/png',
      width: 480,
      height: 270,
      size: 7,
      url: 'blob:prepared-image/png'
    })
  })

  it('sends a 300 × 100 logo as it is', async () => {
    const fake = fakeMedia({ sizes: { small: { width: 300, height: 100 } } })
    const out = await prepareMedia(
      'logo',
      file('small.png', 'image/png', 'small'),
      fake.media
    )
    expect(fake.drawn).deep.equals([])
    expect(out).deep.include({ width: 300, height: 100, size: 5, url: 'small' })
  })

  it('centre-crops a row logo to a 128 square, keeping JPEG', async () => {
    const fake = fakeMedia({ sizes: { wide: { width: 300, height: 200 } } })
    const out = await prepareMedia(
      'rowLogo',
      file('wide.jpg', 'image/jpeg', 'wide'),
      fake.media
    )
    expect(fake.drawn[0]).deep.equals({
      width: 128,
      height: 128,
      from: { x: 50, y: 0, width: 200, height: 200 },
      type: 'image/jpeg'
    })
    expect(out.type).equals('image/jpeg')
  })

  it('crops a background from its upper-right corner to the 1920:224 strip', async () => {
    const fake = fakeMedia({
      sizes: {
        tall: { width: 1000, height: 800 },
        huge: { width: 4000, height: 300 }
      }
    })
    await prepareMedia(
      'rowBackground',
      file('tall.png', 'image/png', 'tall'),
      fake.media
    )
    // 1000 wide at 1920:224 is 117 high, from the top.
    expect(fake.drawn[0]).deep.equals({
      width: 1000,
      height: 117,
      from: { x: 0, y: 0, width: 1000, height: 117 },
      type: 'image/png'
    })
    await prepareMedia(
      'rowBackground',
      file('huge.png', 'image/png', 'huge'),
      fake.media
    )
    // 300 high is 2571 wide, from the right edge, scaled to 1920 × 224.
    expect(fake.drawn[1]).deep.equals({
      width: 1920,
      height: 224,
      from: { x: 4000 - 2571, y: 0, width: 2571, height: 300 },
      type: 'image/png'
    })
  })

  it('refuses a picture it cannot read, or one with no size', async () => {
    const fake = fakeMedia({ sizes: { empty: { width: 0, height: 0 } } })
    for (const url of ['missing', 'empty']) {
      const error = await refusal(
        async () =>
          await prepareMedia(
            'rowLogo',
            file('x.png', 'image/png', url),
            fake.media
          )
      )
      expect(error).instanceOf(SponsorRuleError)
      expect(error.message).equals(
        'This picture could not be read. Try another file.'
      )
    }
  })

  it('tells a browser without VideoEncoder to use the mobile app, before loading Mediabunny', async () => {
    const fake = fakeMedia({ encoder: false })
    const error = await refusal(
      async () =>
        await prepareMedia('reel', file('a.mp4', 'video/mp4'), fake.media)
    )
    expect(error).instanceOf(NoWebCodecs)
    expect(error.message).equals(NO_WEBCODECS)
    expect(fake.loads).equals(0)
  })

  it('tells a browser that cannot encode H.264 at the size to use the mobile app', async () => {
    const fake = fakeMedia({ canEncode: false })
    const error = await refusal(
      async () =>
        await prepareMedia('reel', file('a.mp4', 'video/mp4'), fake.media)
    )
    expect(error).instanceOf(NoWebCodecs)
    expect(fake.asked).deep.equals([{ codec: 'avc', width: 640, height: 360 }])
    expect(fake.converted).deep.equals([])
  })

  it('refuses a 20-second source before converting', async () => {
    const fake = fakeMedia({ durationSec: 20 })
    const error = await refusal(
      async () =>
        await prepareMedia('reel', file('a.mp4', 'video/mp4'), fake.media)
    )
    expect(error.message).equals(
      'This reel is 20 seconds. Reels must be 10 to 15 seconds long.'
    )
    expect(fake.converted).deep.equals([])
  })

  it('converts to avc at 30 fps and 1 Mbit/s within 640 × 360, with AAC', async () => {
    const fake = fakeMedia({
      track: { displayWidth: 1080, displayHeight: 1920 }
    })
    const out = await prepareMedia(
      'reel',
      file('clip.mov', 'video/quicktime'),
      fake.media
    )
    const { video, audio } = fake.converted[0].options as {
      video: Record<string, unknown>
      audio: Record<string, unknown>
    }
    expect(video).deep.include({
      codec: 'avc',
      width: 202,
      height: 360,
      fit: 'fill',
      frameRate: 30
    })
    // An explicit bitrate: a bare number would be a quality level.
    expect((video.quality as { value: unknown }).value).deep.equals({
      bitrate: 1_000_000
    })
    expect(audio.codec).equals('aac')
    expect((audio.quality as { value: unknown }).value).deep.equals({
      bitrate: 128_000
    })
    expect(fake.converted[0].executed).equals(true)
    expect(out).deep.include({
      name: 'clip.mov',
      type: 'video/mp4',
      size: 2_000_000,
      width: 202,
      height: 360,
      durationMs: 12_000,
      durationSec: 12
    })
    expect(REEL_ENCODING.videoBitrate).equals(1_000_000)
  })

  it('refuses an output over 3.2 MB before upload', async () => {
    const fake = fakeMedia({ outputBytes: 3_200_001 })
    const error = await refusal(
      async () =>
        await prepareMedia('reel', file('a.mp4', 'video/mp4'), fake.media)
    )
    expect(error.message).equals('Reels can be at most 3.2 MB.')
  })

  it('refuses a video it cannot read, one without a picture, and a conversion that fails', async () => {
    for (const [options, sentence] of [
      [{ readFails: true }, 'This video could not be read. Try another file.'],
      [{ track: null }, 'This video could not be read. Try another file.'],
      [{ valid: false }, 'This video could not be shrunk. Try another file.'],
      [
        { executeFails: true },
        'This video could not be shrunk. Try another file.'
      ],
      [
        { outputBytes: null },
        'This video could not be shrunk. Try another file.'
      ]
    ] as const) {
      const fake = fakeMedia(options)
      const error = await refusal(
        async () =>
          await prepareMedia('reel', file('a.mp4', 'video/mp4'), fake.media)
      )
      expect(error.message, JSON.stringify(options)).equals(sentence)
    }
  })

  it('knows a browser with no Mediabunny module to load cannot shrink a reel', async () => {
    expect(browserMedia.hasVideoEncoder()).equals(
      typeof (globalThis as { VideoEncoder?: unknown }).VideoEncoder !==
        'undefined'
    )
    const error = await refusal(async () => await browserMedia.loadMediabunny())
    expect(error.message).equals(NO_WEBCODECS)
  })

  describe('the browser’s own pictures, canvas and files', () => {
    const descriptor = (
      target: object,
      name: string
    ): PropertyDescriptor | undefined =>
      Object.getOwnPropertyDescriptor(target, name)
    const held: Array<[object, string, PropertyDescriptor | undefined]> = []
    const stub = (target: object, name: string, value: unknown): void => {
      held.push([target, name, descriptor(target, name)])
      Object.defineProperty(target, name, {
        configurable: true,
        writable: true,
        value
      })
    }
    const restore = (): void => {
      for (const [target, name, old] of held.reverse()) {
        if (old == null) Reflect.deleteProperty(target, name)
        else Object.defineProperty(target, name, old)
      }
      held.length = 0
    }

    it('decodes a picture through an Image, and refuses one it cannot decode', async () => {
      const image = window.HTMLImageElement.prototype
      stub(globalThis, 'Image', window.Image)
      try {
        stub(image, 'decode', async function (this: HTMLImageElement) {
          if (this.src.endsWith('broken')) throw new Error('decode')
          Object.defineProperty(this, 'naturalWidth', { value: 640 })
          Object.defineProperty(this, 'naturalHeight', { value: 360 })
        })
        const decoded = await browserMedia.decodeImage(
          'https://example.test/ok'
        )
        expect(decoded).deep.include({ width: 640, height: 360 })
        const error = await refusal(
          async () =>
            await browserMedia.decodeImage('https://example.test/broken')
        )
        expect(error.message).equals(
          'This picture could not be read. Try another file.'
        )
      } finally {
        restore()
      }
    })

    it('draws on a canvas from the source rect and exports its bytes, refusing when it cannot', async () => {
      const canvas = window.HTMLCanvasElement.prototype
      const drawn: unknown[][] = []
      let blob: Blob | null = new Blob([new Uint8Array([1, 2, 3])])
      stub(canvas, 'getContext', () => ({
        imageSmoothingQuality: 'low',
        drawImage: (...args: unknown[]) => drawn.push(args)
      }))
      stub(canvas, 'toBlob', (done: (made: Blob | null) => void) => {
        done(blob)
      })
      try {
        const drawing = browserMedia.canvas(128, 128)
        const source = Object.create(null) as CanvasImageSource
        drawing.draw(
          { width: 300, height: 200, source },
          { x: 50, y: 0, width: 200, height: 200 }
        )
        expect(drawn).deep.equals([[source, 50, 0, 200, 200, 0, 0, 128, 128]])
        expect([...(await drawing.toBytes('image/png'))]).deep.equals([1, 2, 3])
        blob = null
        const error = await refusal(
          async () => await drawing.toBytes('image/png')
        )
        expect(error).instanceOf(SponsorRuleError)
        stub(canvas, 'getContext', () => null)
        expect(() => {
          browserMedia
            .canvas(1, 1)
            .draw(
              { width: 1, height: 1, source },
              { x: 0, y: 0, width: 1, height: 1 }
            )
        }).throws('This picture could not be read. Try another file.')
      } finally {
        restore()
      }
    })

    it('reads a file this page picked from the File itself, never fetching its blob: URL', async () => {
      const fetched: unknown[] = []
      stub(globalThis, 'fetch', async (url: unknown) => {
        fetched.push(url)
        throw new TypeError('Failed to fetch')
      })
      try {
        const file = new window.File([new Uint8Array(6)], 'logo.png', {
          type: 'image/png'
        })
        const picked = pickedFileOf(file, {
          createObjectURL: () => 'blob:picked-logo'
        })
        expect(await browserMedia.readBlob(picked.url)).equals(file)
        expect(fetched).deep.equals([])
      } finally {
        restore()
      }
    })

    it('reads any other address through fetch and makes an object URL for the shrunk one', async () => {
      const made: Blob[] = []
      stub(
        globalThis,
        'fetch',
        async () => new Response(new Uint8Array([7, 8]))
      )
      stub(URL, 'createObjectURL', (blob: Blob) => {
        made.push(blob)
        return 'blob:made'
      })
      try {
        const blob = await browserMedia.readBlob('blob:picked')
        expect(blob.size).equals(2)
        expect(browserMedia.objectUrl(new Uint8Array(4), 'image/png')).equals(
          'blob:made'
        )
        expect(made[0].type).equals('image/png')
        expect(made[0].size).equals(4)
      } finally {
        restore()
      }
    })

    it('loads Mediabunny from the address the build gives', async () => {
      const at = '/mediabunny-TEST.js'
      stub(globalThis, 'TS_MEDIABUNNY_URL', at)
      try {
        // The test page has no module at that address, so the import fails
        // after the address is made: the page's own origin, not a bundled path.
        const error = await refusal(
          async () => await browserMedia.loadMediabunny()
        )
        expect(String(error.message)).includes('mediabunny-TEST.js')
      } finally {
        restore()
      }
    })
  })
})
