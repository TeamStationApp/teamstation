import { expect } from 'chai'
import { describe, it } from 'mocha'

import type { LiveStream, TeamStationClient } from '../../common/api'
import {
  cameraLink,
  type CameraLinks,
  launchCamera,
  type LinkedCamera,
  rtmpUrlParts,
  storePage
} from './cameraDeepLinks'

const KEY = 'ts_00000000000000000000'
const RTMP = `rtmp://ingest.example.test:1936/live/${KEY}`
const RTMPS = `rtmps://ingest.example.test/live/${KEY}`

/** The query of a link, decoded once, in the order it was sent. */
const fields = (link: string): Array<[string, string]> => [
  ...new URLSearchParams(link.slice(link.indexOf('?') + 1)).entries()
]

const mevoFields = (
  protocol: string,
  port: string,
  title: string
): Array<[string, string]> => [
  ['publishHost', 'ingest.example.test'],
  ['publishApplication', 'live'],
  ['publishStream', KEY],
  ['publishPort', port],
  ['publishProtocol', protocol],
  ['streamTitle', title],
  ['encoder', 'hevc']
]

describe('rtmpUrlParts', function () {
  it('splits a URL with a port', function () {
    expect(rtmpUrlParts(RTMP)).deep.equals({
      protocol: 'rtmp',
      host: 'ingest.example.test',
      port: 1936,
      application: 'live',
      key: KEY
    })
  })

  it('takes each protocol’s default port', function () {
    expect(rtmpUrlParts(RTMPS)?.port).equals(443)
    expect(rtmpUrlParts(`rtmp://192.0.2.1/live/${KEY}`)?.port).equals(1935)
  })

  it('keeps everything before the key as the application', function () {
    expect(
      rtmpUrlParts(`rtmp://ingest.example.test/app/live/${KEY}`)?.application
    ).equals('app/live')
  })

  it('refuses anything else', function () {
    for (const url of [
      '',
      'https://ingest.example.test/live/ts_0',
      'rtmp://ingest.example.test/ts_0'
    ])
      expect(rtmpUrlParts(url), url).equals(undefined)
  })
})

describe('cameraLink', function () {
  it('hands GoPro the whole URL, as its link carries it', function () {
    expect(cameraLink('gopro', RTMP, 'Home')).equals(
      `https://gopro.com/app/streaming/rtmp?server=${RTMP}`
    )
    expect(cameraLink('gopro', RTMPS, 'Home')).equals(
      `https://gopro.com/app/streaming/rtmp?server=${RTMPS}`
    )
  })

  it('builds Mevo’s link for rtmp with a custom port', function () {
    const link = cameraLink('mevo', RTMP, 'Home')
    expect(link).equals(
      `mevostream://configure/?publishHost=ingest.example.test&publishApplication=live&publishStream=${KEY}&publishPort=1936&publishProtocol=rtmp&streamTitle=Home&encoder=hevc`
    )
  })

  it('builds Mevo’s link for rtmps on the default port', function () {
    expect(fields(cameraLink('mevo', RTMPS, 'Home')!)).deep.equals(
      mevoFields('rtmps', '443', 'Home')
    )
  })

  it('encodes a name that needs it, and only as far as a query must', function () {
    const link = cameraLink('mevo', RTMP, '1st & 3rd/Home?')!
    expect(link).contains('streamTitle=1st%20%26%203rd%2FHome%3F&')
    expect(fields(link)).deep.equals(
      mevoFields('rtmp', '1936', '1st & 3rd/Home?')
    )
  })

  it('encodes Mevo Studio’s link inside its outer link', function () {
    const link = cameraLink('mevoStudio', RTMP, '1st & 3rd')!
    expect(
      link.startsWith('https://multicam.mevo.com?link=https%3A%2F%2F')
    ).equals(true)
    expect(link.endsWith('&apn=com.mevo.multicam')).equals(true)
    expect(link, 'the name is encoded twice').contains('1st%2520%2526%25203rd')
    const outer = fields(link)
    expect(outer.map(([name]) => name)).deep.equals(['link', 'apn'])
    const inner = outer[0][1]
    expect(inner.startsWith('https://multicam.mevo.com/configure?')).equals(
      true
    )
    expect(fields(inner)).deep.equals(mevoFields('rtmp', '1936', '1st & 3rd'))
  })

  it('builds Mevo Studio’s link for rtmps', function () {
    const inner = fields(cameraLink('mevoStudio', RTMPS, 'Home')!)[0][1]
    expect(fields(inner)).deep.equals(mevoFields('rtmps', '443', 'Home'))
  })

  it('names HEVC on both Mevo links, and never a provider', function () {
    for (const source of ['mevo', 'mevoStudio'] as const) {
      const link = decodeURIComponent(cameraLink(source, RTMP, 'Home')!)
      expect(link, source).contains('encoder=hevc')
      expect(link, source).not.contains('provider')
    }
  })

  it('sends GoPro no codec', function () {
    expect(cameraLink('gopro', RTMP, 'Home')).not.contains('encoder')
  })

  it('has no link for a URL it cannot split', function () {
    expect(cameraLink('mevo', 'https://example.test/', 'Home')).equals(
      undefined
    )
  })
})

/** Stands in for the system and the server, and records what they were asked. */
function launcher(patch: {
  installed?: string[]
  canOpenURL?: CameraLinks['canOpenURL']
  openURL?: (url: string) => Promise<void>
  /** Android's packages. */
  apps?: string[]
  appInstalled?: CameraLinks['appInstalled']
  openInApp?: CameraLinks['openInApp']
  url?: string
  addLiveStream?: () => Promise<LiveStream>
  revealed?: () => Promise<LiveStream>
  os?: string
  source?: LinkedCamera
}): {
  run: () => ReturnType<typeof launchCamera>
  /** Every URL opened, whatever opened it. */
  fired: string[]
  /** The links held to one app, which no browser can take. */
  inApp: Array<[string, string]>
  added: unknown[]
  created: number[]
  stream: LiveStream
} {
  const stream = {
    id: 'liv_1',
    gameId: 'gam_1',
    url: 'url' in patch ? patch.url : RTMP
  } as unknown as LiveStream
  const fired: string[] = []
  const inApp: Array<[string, string]> = []
  const added: unknown[] = []
  const created: number[] = []
  const client = {
    addLiveStream: async (...args: unknown[]) => {
      added.push(args)
      return await (patch.addLiveStream?.() ?? stream)
    },
    revealLiveStream: async () =>
      await (patch.revealed?.() ?? { ...stream, url: RTMP })
  } as unknown as TeamStationClient
  return {
    fired,
    inApp,
    added,
    created,
    stream,
    run: async () =>
      await launchCamera({
        client,
        gameId: 'gam_1',
        name: 'Home',
        source: patch.source ?? 'mevo',
        os: patch.os ?? 'android',
        links: {
          canOpenURL:
            patch.canOpenURL ??
            (async url => (patch.installed ?? []).includes(url)),
          openURL: async url => {
            fired.push(url)
            await patch.openURL?.(url)
          },
          appInstalled:
            patch.appInstalled ??
            (async name => (patch.apps ?? []).includes(name)),
          openInApp: async (url, name) => {
            inApp.push([url, name])
            fired.push(url)
            return (await patch.openInApp?.(url, name)) ?? true
          }
        },
        onCreated: () => created.push(1)
      })
  }
}

const GOPRO_SCHEME = 'goprocontrol://com.gopro.smarty/home'
const MEVO_SCHEME = 'mevostream://configure'
const STUDIO_APP = 'com.mevo.multicam'

describe('launchCamera', function () {
  for (const os of ['android', 'ios'])
    for (const [source, scheme] of [
      ['gopro', GOPRO_SCHEME],
      ['mevo', MEVO_SCHEME]
    ] as const)
      it(`makes the camera, then fires ${source}’s link, on ${os}`, async function () {
        const go = launcher({ os, source, installed: [scheme] })
        expect(await go.run()).deep.equals({ kind: 'opened' })
        expect(go.added).deep.equals([['gam_1', 'Home', { source }]])
        expect(go.created).deep.equals([1])
        expect(go.fired).deep.equals([cameraLink(source, RTMP, 'Home')])
      })

  it('opens Android’s store page for a missing app, and makes no camera', async function () {
    for (const [source, packageName] of [
      ['gopro', 'com.gopro.smarty'],
      ['mevo', 'com.livestream.mevo']
    ] as const) {
      const go = launcher({ source })
      expect(await go.run()).deep.equals({ kind: 'store' })
      expect(go.fired).deep.equals([storePage(packageName)])
      expect(go.added).deep.equals([])
    }
  })

  it('leaves a missing app to the RTMP sheet on iOS, which makes the camera', async function () {
    for (const source of ['gopro', 'mevo'] as const) {
      const go = launcher({ source, os: 'ios' })
      expect(await go.run()).deep.equals({
        kind: 'sheet',
        target: { name: 'Home', source }
      })
      expect(go.fired).deep.equals([])
      expect(go.added).deep.equals([])
    }
  })

  it('treats a check that fails as a missing app', async function () {
    const go = launcher({
      canOpenURL: async () => {
        throw new Error('not allowed')
      }
    })
    expect(await go.run()).deep.equals({ kind: 'store' })
  })

  it('holds each https link to its app, so no browser can take the key', async function () {
    for (const os of ['android', 'ios']) {
      const gopro = launcher({ os, source: 'gopro', installed: [GOPRO_SCHEME] })
      await gopro.run()
      expect(gopro.inApp).deep.equals([
        [cameraLink('gopro', RTMP, 'Home'), 'com.gopro.smarty']
      ])
      const studio = launcher({ os, source: 'mevoStudio', apps: [STUDIO_APP] })
      expect(await studio.run()).deep.equals({ kind: 'opened' })
      expect(studio.inApp).deep.equals([
        [cameraLink('mevoStudio', RTMP, 'Home'), STUDIO_APP]
      ])
    }
  })

  it('leaves Mevo’s own scheme to the system, which only its app answers', async function () {
    const go = launcher({ installed: [MEVO_SCHEME] })
    await go.run()
    expect(go.inApp).deep.equals([])
    expect(go.fired).deep.equals([cameraLink('mevo', RTMP, 'Home')])
  })

  it('opens Android’s store page with Mevo Studio missing, with no key and no camera', async function () {
    const go = launcher({ source: 'mevoStudio' })
    expect(await go.run()).deep.equals({ kind: 'store' })
    expect(go.fired).deep.equals([storePage(STUDIO_APP)])
    expect(go.fired[0]).not.contains(KEY)
    expect(go.added).deep.equals([])
    expect(go.created).deep.equals([])
  })

  it('treats a package check that fails as a missing app', async function () {
    const go = launcher({
      source: 'mevoStudio',
      appInstalled: async () => {
        throw new Error('unsupported')
      }
    })
    expect(await go.run()).deep.equals({ kind: 'store' })
    expect(go.added).deep.equals([])
  })

  it('shows the URL on iOS with Mevo Studio missing, and opens nothing else', async function () {
    const go = launcher({
      os: 'ios',
      source: 'mevoStudio',
      appInstalled: async () => {
        throw new Error('iOS cannot ask')
      },
      openInApp: async () => false
    })
    expect(await go.run()).deep.equals({
      kind: 'sheet',
      target: { stream: go.stream }
    })
    expect(go.added).to.have.length(1)
    expect(go.fired, 'one try, held to the app').deep.equals([
      cameraLink('mevoStudio', RTMP, 'Home')
    ])
  })

  it('shows the URL when Quik will not take its link, rather than a browser', async function () {
    const go = launcher({
      source: 'gopro',
      installed: [GOPRO_SCHEME],
      openInApp: async () => false
    })
    expect(await go.run()).deep.equals({
      kind: 'sheet',
      target: { stream: go.stream }
    })
  })

  it('reveals the URL when the answer leaves it out', async function () {
    const go = launcher({ url: undefined, installed: [MEVO_SCHEME] })
    expect(await go.run()).deep.equals({ kind: 'opened' })
    expect(go.fired).deep.equals([cameraLink('mevo', RTMP, 'Home')])
  })

  it('fires nothing for a refused camera', async function () {
    const go = launcher({
      installed: [MEVO_SCHEME],
      addLiveStream: async () => {
        throw new Error('This game already has 6 cameras.')
      }
    })
    let caught: unknown
    await go.run().catch((error: unknown) => {
      caught = error
    })
    expect((caught as Error).message).contains('6 cameras')
    expect(go.fired).deep.equals([])
    expect(go.created).deep.equals([])
  })

  it('shows the URL of a camera whose link would not open', async function () {
    const go = launcher({
      installed: [MEVO_SCHEME],
      openURL: async () => {
        throw new Error('No activity')
      }
    })
    expect(await go.run()).deep.equals({
      kind: 'sheet',
      target: { stream: go.stream }
    })
    expect(go.created).deep.equals([1])
  })

  it('shows the URL of a camera whose URL could not be read', async function () {
    const go = launcher({
      url: undefined,
      installed: [MEVO_SCHEME],
      revealed: async () => {
        throw new Error('The server is away')
      }
    })
    expect((await go.run()).kind).equals('sheet')
    expect(go.fired).deep.equals([])
  })

  it('shows the URL of a camera whose URL has no link', async function () {
    const go = launcher({
      url: 'https://example.test/',
      installed: [MEVO_SCHEME]
    })
    expect(await go.run()).deep.equals({
      kind: 'sheet',
      target: { stream: go.stream }
    })
    expect(go.fired).deep.equals([])
  })
})
