import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { attachDevice, connectDaemon } from '../../core/maestro'
import { iosIsSimulator } from '../../core/prepare'
import { loadSettings } from '../../core/settings'

/**
 * Points a device's develop app at a server for its next fresh launch, by
 * the develop build's server link, then launches it fresh, so the launch a
 * test exercises is the ordinary one, talking to that server:
 *
 *   node -r sucrase/register e2e/rigs/app/setServer.ts --platform ios|android|tvos \
 *     --device <udid> --app-id <id> --origin https://e2e-03.teamstation.app [--daemon <name>]
 *
 * A phone is driven through maestro-d; the TV, which maestro-d does not
 * drive, through `xcrun devicectl`. A stable build claims neither scheme, so
 * the link reaches only a develop build.
 */
export type AppPlatform = 'ios' | 'android' | 'tvos'

/** What a phone needs from maestro-d. */
export interface ServerDevice {
  launchApp: (options: { appId: string; stopApp?: boolean }) => Promise<unknown>
  stopApp: (options: { appId: string }) => Promise<unknown>
  openLink: (options: { link: string }) => Promise<unknown>
  assertVisible: (options: Record<string, unknown>) => Promise<unknown>
}

export type Run = (file: string, args: string[]) => Promise<unknown>

export const PHONE_SCHEME = 'teamstation-develop'
export const TV_SCHEME = 'teamstationtv-develop'

/** The link that keeps `origin` for the next launch (`clear` with none). */
export function serverLink(
  platform: AppPlatform,
  origin: string | null
): string {
  const scheme = platform === 'tvos' ? TV_SCHEME : PHONE_SCHEME
  return origin == null
    ? `${scheme}://server?clear=1`
    : `${scheme}://server?origin=${encodeURIComponent(origin)}`
}

/** `text` as a pattern that matches it literally. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The host the app says it kept, which the link's message names. */
function hostOf(origin: string | null): string {
  return origin == null ? 'this build' : new URL(origin).host
}

export async function setServer(options: {
  platform: AppPlatform
  udid: string
  appId: string
  /** `https://<host>`, or null to go back to the build's own server. */
  origin: string | null
  /** A phone's maestro-d device; unused for the TV. */
  device?: ServerDevice
  /** An iOS simulator, which takes the link through simctl, not devicectl. */
  simulator?: boolean
  run?: Run
  sleep?: (ms: number) => Promise<void>
}): Promise<void> {
  const { platform, udid, appId, origin } = options
  const link = serverLink(platform, origin)
  const sleep =
    options.sleep ??
    (async (ms: number) => {
      await new Promise(resolve => setTimeout(resolve, ms))
    })
  if (platform === 'tvos') {
    const run = options.run ?? realRun
    const launch = async (extra: string[]): Promise<void> => {
      await run('xcrun', [
        'devicectl',
        'device',
        'process',
        'launch',
        '--device',
        udid,
        '--terminate-existing',
        ...extra,
        appId
      ])
    }
    await launch(['--payload-url', link])
    // The TV says so a second after it keeps the server.
    await sleep(3000)
    await launch([])
    return
  }
  const device = options.device
  if (device == null)
    throw new Error(`setServer on ${platform} needs a maestro-d device`)
  await device.stopApp({ appId })
  if (platform === 'ios' && options.simulator === true) {
    // A simulator's system hands its own app the link: devicectl sees only
    // phones.
    await (options.run ?? realRun)('xcrun', ['simctl', 'openurl', udid, link])
  } else if (platform === 'ios') {
    // Handed to the develop app by its id: on a phone, the system's own
    // handling of a link stops short of the app it names.
    await (options.run ?? realRun)('xcrun', [
      'devicectl',
      'device',
      'process',
      'launch',
      '--device',
      udid,
      '--terminate-existing',
      '--payload-url',
      link,
      appId
    ])
  } else {
    await device.openLink({ link })
  }
  await device.assertVisible({
    text: `.*${escapeRegExp(hostOf(origin))}.*Restart TeamStation.*`
  })
  // A fresh launch, the ordinary one, now talking to the server kept.
  await device.launchApp({ appId, stopApp: true })
}

const realRun: Run = async (file, args) => await promisify(execFile)(file, args)

/** The command line's options. */
export function parseSetServerArgs(argv: string[]): {
  platform: AppPlatform
  udid: string
  appId: string
  origin: string | null
  daemon: string
} {
  const values: Record<string, string> = {}
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] == null)
      throw new Error(`unknown or empty option ${argv[i]}`)
    values[argv[i].slice(2)] = argv[i + 1]
  }
  const platform = values.platform
  if (platform !== 'ios' && platform !== 'android' && platform !== 'tvos') {
    throw new Error('--platform is ios, android or tvos')
  }
  for (const flag of ['device', 'app-id', 'origin']) {
    if (values[flag] == null) throw new Error(`--${flag} is needed`)
  }
  return {
    platform,
    udid: values.device,
    appId: values['app-id'],
    origin: values.origin === 'clear' ? null : values.origin,
    daemon: values.daemon ?? `setServer-${process.pid}`
  }
}

if (require.main === module) {
  const run = async (): Promise<void> => {
    const args = parseSetServerArgs(process.argv.slice(2))
    if (args.platform === 'tvos') {
      await setServer(args)
    } else {
      const daemon = await connectDaemon(loadSettings(), args.daemon)
      try {
        const device = (await attachDevice(
          daemon,
          join(tmpdir(), `setServer-${process.pid}`),
          {
            device: args.udid,
            appId: args.appId
          }
        )) as unknown as ServerDevice
        await setServer({
          ...args,
          device,
          simulator: args.platform === 'ios' && iosIsSimulator(args.udid)
        })
      } finally {
        await daemon.shutdown()
      }
    }
    console.log(
      `${args.appId} on ${args.udid} uses ${args.origin ?? 'its own server'} from its next launch, and is launched`
    )
  }
  run().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
