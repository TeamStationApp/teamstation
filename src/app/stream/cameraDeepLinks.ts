import type {
  CameraSource,
  LiveStream,
  TeamStationClient
} from '../../common/api'
import type { RtmpTarget } from './RtmpUrlSheet'

/** A camera whose own app takes the whole stream from a link. */
export type LinkedCamera = Exclude<CameraSource, 'rtmp'>

/** What a stream URL is made of, as the camera apps ask for it. */
export interface RtmpUrlParts {
  protocol: 'rtmp' | 'rtmps'
  host: string
  port: number
  application: string
  key: string
}

/** The part of the system this takes; a test hands in its own. */
export interface CameraLinks {
  canOpenURL: (url: string) => Promise<boolean>
  openURL: (url: string) => Promise<unknown>
  /** Whether Android has this app, enabled. */
  appInstalled: (packageName: string) => Promise<boolean>
  /** Opens a link in the app alone, never a browser; false if it could not. */
  openInApp: (url: string, packageName: string) => Promise<boolean>
}

/** What became of a tap on a camera's row. */
export type CameraLaunch =
  /** The camera's app has the link, and the camera exists. */
  | { kind: 'opened' }
  /** The store page has been opened instead, and no camera was made. */
  | { kind: 'store' }
  /** No link can be fired, so the URL has to be shown. */
  | { kind: 'sheet'; target: RtmpTarget }

export interface LaunchCamera {
  client: TeamStationClient
  gameId: string
  name: string
  source: LinkedCamera
  links: CameraLinks
  os: string
  /** A camera was made, whatever becomes of its link. */
  onCreated: () => void
}

const DEFAULT_PORT = { rtmp: 1935, rtmps: 443 }

const GOPRO_LINK = 'https://gopro.com/app/streaming/rtmp'
const MEVO_LINK = 'mevostream://configure/'
const MEVO_UNIVERSAL_LINK = 'https://app.mevo.com/configure'
const MEVO_STUDIO_HOST = 'https://multicam.mevo.com'
const MEVO_STUDIO_APP = 'com.mevo.multicam'

/**
 * How each app is known to be on this phone, and its Play Store page. Mevo
 * Studio answers to no scheme of its own: Android's package manager knows of
 * it, and iOS finds out only by opening its link. Mevo is the same on iOS,
 * which refuses `mevostream://`, and answers to that scheme on Android alone.
 */
const INSTALL_CHECKS: Record<
  LinkedCamera,
  { url?: string; androidUrl?: string; packageName: string }
> = {
  // Quik's Android filters name a host and path: the bare scheme matches none.
  gopro: {
    url: 'goprocontrol://com.gopro.smarty/home',
    packageName: 'com.gopro.smarty'
  },
  mevo: {
    androidUrl: 'mevostream://configure',
    packageName: 'com.livestream.mevo'
  },
  mevoStudio: { packageName: MEVO_STUDIO_APP }
}

export function storePage(packageName: string): string {
  return `https://play.google.com/store/apps/details?id=${packageName}`
}

/** Splits a stream URL: the key is its last part, the application the rest. */
export function rtmpUrlParts(url: string): RtmpUrlParts | undefined {
  // Hermes' URL leaves `hostname`, `port` and `pathname` unimplemented.
  const match = /^(rtmps?):\/\/([^/:]+)(?::(\d+))?\/(.+)\/([^/]+)$/.exec(url)
  if (match == null) return undefined
  const protocol = match[1] as RtmpUrlParts['protocol']
  return {
    protocol,
    host: match[2],
    port: match[3] == null ? DEFAULT_PORT[protocol] : Number(match[3]),
    application: match[4],
    key: match[5]
  }
}

/**
 * The fields of both Mevo links. The ingest takes HEVC only, so the encoder is
 * always named.
 */
function mevoQuery(parts: RtmpUrlParts, title: string): string {
  const fields: Array<[string, string | number]> = [
    ['publishHost', parts.host],
    ['publishApplication', parts.application],
    ['publishStream', parts.key],
    ['publishPort', parts.port],
    ['publishProtocol', parts.protocol],
    ['streamTitle', title],
    ['encoder', 'hevc']
  ]
  return fields
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
    .join('&')
}

/**
 * The link that hands a camera's app its whole stream, or `undefined` for a
 * URL that cannot be split.
 */
export function cameraLink(
  source: LinkedCamera,
  url: string,
  title: string,
  os: string
): string | undefined {
  const parts = rtmpUrlParts(url)
  if (parts == null) return undefined
  switch (source) {
    case 'gopro':
      return `${GOPRO_LINK}?server=${url}`
    case 'mevo':
      return `${os === 'android' ? MEVO_LINK : MEVO_UNIVERSAL_LINK}?${mevoQuery(parts, title)}`
    case 'mevoStudio': {
      const inner = `${MEVO_STUDIO_HOST}/configure?${mevoQuery(parts, title)}`
      return `${MEVO_STUDIO_HOST}?link=${encodeURIComponent(inner)}&apn=${MEVO_STUDIO_APP}`
    }
  }
}

/** The URL of a camera just made, read again if the answer left it out. */
async function urlOf(
  client: TeamStationClient,
  stream: LiveStream
): Promise<string | undefined> {
  if (stream.url != null) return stream.url
  return (await client.revealLiveStream(stream.gameId, stream.id)).url
}

/**
 * Sends a camera's row to its app: makes the camera, then fires its link. A
 * link carries the stream key, so an `https` one goes to the app alone: a
 * browser would hand the key to a website. With the app missing nothing is made
 * on Android, whose store page comes up and leaves the person free to tap the
 * row again once it is installed. iOS shows the URL instead. A camera whose link
 * cannot fire keeps its row, and shows its URL too. A refused camera throws, and
 * nothing fires.
 */
export async function launchCamera(args: LaunchCamera): Promise<CameraLaunch> {
  const { client, gameId, name, source, links, os, onCreated } = args
  const check = INSTALL_CHECKS[source]
  const probe = os === 'android' ? (check.androidUrl ?? check.url) : check.url
  if (!(await installed(links, probe, check.packageName, os))) {
    if (os !== 'android') return { kind: 'sheet', target: { name, source } }
    await links.openURL(storePage(check.packageName))
    return { kind: 'store' }
  }
  const stream = await client.addLiveStream(gameId, name, { source })
  onCreated()
  try {
    const url = await urlOf(client, stream)
    const link = url == null ? undefined : cameraLink(source, url, name, os)
    if (link != null && (await fire(links, link, check.packageName)))
      return { kind: 'opened' }
  } catch {
    // Its row exists, so the person still needs its URL.
  }
  return { kind: 'sheet', target: { stream } }
}

async function installed(
  links: CameraLinks,
  url: string | undefined,
  packageName: string,
  os: string
): Promise<boolean> {
  if (url != null) return await links.canOpenURL(url).catch(() => false)
  if (os !== 'android') return true
  return await links.appInstalled(packageName).catch(() => false)
}

/** Only an app of its own takes a custom scheme, so no browser can get it. */
async function fire(
  links: CameraLinks,
  link: string,
  packageName: string
): Promise<boolean> {
  if (link.startsWith('https:')) return await links.openInApp(link, packageName)
  await links.openURL(link)
  return true
}
