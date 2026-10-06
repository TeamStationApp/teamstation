/**
 * The chat crypto bench on an iOS simulator or an Android emulator, through
 * maestro-d's JavaScript client (`ChatBenchScreen`).
 *
 *   MAESTRO_D=chat-<run> CHAT_PLATFORM=ios|android CHAT_DEVICE=<id> \
 *     CHAT_ARTIFACTS=<dir> node -r sucrase/register src/app/dev/chatBenchPhones.e2e.ts
 *
 * Required: `MAESTRO_D`, a daemon of this run's own, already started
 * (`maestro-d start --daemon "$MAESTRO_D"`; run `maestro-d ps` first and never
 * share one); `CHAT_PLATFORM`; `CHAT_DEVICE`, the simulator's UDID or the
 * emulator's serial, which the test pins and never chooses; `CHAT_ARTIFACTS`,
 * where the screenshot goes. Optional: `MAESTRO_D_CLIENT_ROOT`, a checkout of
 * the maestro-d npm package, since `maestro-d` is not a dependency.
 *
 * The app must be the bench build: a Release build made with
 * `TS_CHAT_BENCH=1`. It opens `teamstation://dev/chat-bench`, waits for
 * `done` and `vectors ok` (the native core reproduces every frozen vector),
 * saves a screenshot, prints the figures it can read off the screen, and
 * fails under 100 MB/s. The screenshot is the record.
 */
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

interface Node {
  text?: string
  children?: Node[]
}
interface Device {
  stopApp: (options: object) => Promise<unknown>
  openLink: (options: object) => Promise<unknown>
  assertVisible: (options: object) => Promise<unknown>
  takeScreenshot: (options: object) => Promise<unknown>
  hierarchy: () => Promise<Node>
  detach: () => Promise<unknown>
}
interface Daemon {
  attach: (options: object) => Promise<Device>
  close: () => Promise<unknown>
}

function required(key: string): string {
  const value = process.env[key]
  assert(value != null && value !== '', `${key} is required`)
  return value
}

async function main(): Promise<void> {
  const root = process.env.MAESTRO_D_CLIENT_ROOT
  const load =
    root != null && root !== ''
      ? createRequire(join(resolve(root), 'package.json'))
      : createRequire(__filename)
  const { MaestroD } = load('maestro-d') as {
    MaestroD: { connect: (options: object) => Promise<Daemon> }
  }
  const device = required('CHAT_DEVICE')
  const platform = required('CHAT_PLATFORM')
  assert(
    platform === 'ios' || platform === 'android',
    `CHAT_PLATFORM is ios or android, not ${platform}`
  )
  const artifacts = resolve(required('CHAT_ARTIFACTS'))
  await mkdir(artifacts, { recursive: true })

  const daemon = await MaestroD.connect({
    name: required('MAESTRO_D'),
    spawn: false
  })
  const m = await daemon.attach({
    device,
    platform,
    appId: 'app.teamstation.app',
    artifacts: 'on-failure'
  })
  try {
    // Stopped, then opened by its link: a cold start straight onto the bench,
    // so the app never draws Home or asks any server who is signed in.
    await m.stopApp({ appId: 'app.teamstation.app' })
    await m.openLink({ link: 'teamstation://dev/chat-bench' })
    await m.assertVisible({ text: 'Chat crypto bench', timeout: 30_000 })
    // 20 MiB both ways and 1,000 wraps take seconds on a phone's JavaScript
    // engine; give it minutes before calling it hung.
    await m.assertVisible({ text: 'done', timeout: 300_000 })
    // The native core must give every frozen vector's bytes, or the figures
    // below measure something that is not this protocol.
    await m.assertVisible({ text: 'vectors ok', timeout: 5_000 })
    const shot = join(artifacts, 'chat-bench')
    await m.takeScreenshot({ path: shot })
    console.log(`Screenshot ${shot}.png`)

    const flatten = (node: Node): Node[] => [
      node,
      ...(node.children ?? []).flatMap(flatten)
    ]
    const lines = flatten(await m.hierarchy())
      .map(node => node.text ?? '')
      .filter(text => /vectors|MB\/s|wraps\/s|bytes:|failed/.test(text))
    for (const line of [...new Set(lines)]) console.log(line)
    const stream = lines
      .map(line => /^stream MB\/s: ([\d.]+)/.exec(line)?.[1])
      .find(found => found != null)
    assert(stream != null, 'No stream MB/s on the screen')
    // Native code, so a figure in the tens means a debug or wrong build.
    if (Number(stream) >= 100) {
      console.log(`PASS stream ${stream} MB/s >= 100`)
    } else {
      console.log(`FAIL stream ${stream} MB/s < 100`)
      process.exitCode = 1
    }
  } finally {
    await m.detach()
    await daemon.close()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
