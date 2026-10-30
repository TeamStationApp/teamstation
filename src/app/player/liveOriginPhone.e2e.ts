import { execFile } from 'node:child_process'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { promisify } from 'node:util'

// The mobile adapter lives outside the server test compiler's src root.
const { attach, flatten } = createRequire(__filename)(
  '../../../mobile/test/maestroD'
)

/** Phone scenarios always use the explicitly supplied physical iPhone. */
export async function originPhone(options: {
  slug: 'iphone-safari' | 'iphone-app'
  app: string
  signInToken: string
  artifacts: string
  diagnostics: string
}): Promise<{
  open: (gameId: string, videoId: string, startWallMs: number) => Promise<void>
  sample: () => Promise<void>
  ended: (duration: number) => Promise<void>
  close: () => Promise<void>
}> {
  const { slug, app, signInToken, artifacts, diagnostics } = options
  const device = process.env.TS_ORIGIN_DEVICE_UDID
  if (device == null || !/^00008[0-9]+-[A-Fa-f0-9]+$/.test(device))
    throw new Error(
      'Supply TS_ORIGIN_DEVICE_UDID for the assigned physical iPhone'
    )
  const name = process.env.MAESTRO_D
  if (name == null) throw new Error('MAESTRO_D is required')
  const safari = slug === 'iphone-safari'
  // A private test build may register its own scheme when another installed
  // variant also handles teamstation:// links on the assigned phone.
  const scheme = process.env.TS_ORIGIN_APP_SCHEME ?? 'teamstation'
  const m = await attach({
    daemon: name,
    device,
    appId: safari ? 'com.apple.mobilesafari' : 'app.teamstation.app',
    artifactDir: artifacts
  })
  const frames = join(diagnostics, `${slug}-frames`)
  await mkdir(frames, { recursive: true })
  let startWallMs = 0
  const clocks = async (): Promise<number[]> => {
    if (!safari) {
      const tree = await m.hierarchy()
      const corner = flatten(tree).find(
        (node: { id?: string }) => node.id === 'gameVideoOpen'
      )?.bounds
      const screen = tree.bounds
      if (corner != null && screen != null) {
        // Read the broadcaster's frame clock, independently of AVPlayer's
        // live duration and the card's auto-hidden progress labels.
        const margin = screen.width - corner.x - corner.width
        const width = screen.width - 2 * margin
        const frame = join(frames, 'probe.png')
        await writeFile(frame, await m.screenshot())
        const w = Math.round(screen.width)
        const h = Math.round(screen.height)
        const { stdout } = await promisify(execFile)(
          process.env.TS_E2E_FFMPEG ?? 'ffmpeg',
          [
            '-v',
            'error',
            '-i',
            frame,
            '-vf',
            `scale=${w}:${h}`,
            '-f',
            'rawvideo',
            '-pix_fmt',
            'rgb24',
            'pipe:1'
          ],
          { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 }
        )
        const brightness = (x: number, y: number): number => {
          const at =
            (Math.round(corner.y + (y * width) / 1280) * w +
              Math.round(margin + (x * width) / 1280)) *
            3
          return (
            0.299 * stdout[at] + 0.587 * stdout[at + 1] + 0.114 * stdout[at + 2]
          )
        }
        // Same 32-bit marker as scoreboardLog/readMarker.ts: 32 cells,
        // then an always-white sentinel, on a black strip of a 720p frame.
        if (
          brightness(40 + 32 * 36 + 16, 664) < 160 ||
          brightness(40, 690) > 96
        )
          return []
        let low = 0
        for (let bit = 0; bit < 32; bit++)
          if (brightness(40 + bit * 36 + 16, 664) > 128) low += 2 ** bit
        const span = 2 ** 32
        const wall = low + Math.round((Date.now() - low) / span) * span
        if (Math.abs(wall - Date.now()) > 300000) return []
        return [(wall - startWallMs) / 1000]
      }
      return []
    }
    return flatten(await m.hierarchy())
      .flatMap((node: { text?: string }) => {
        const match = /^(\d{1,2}):(\d{2})$/.exec(node.text ?? '')
        return match == null ? [] : [Number(match[1]) * 60 + Number(match[2])]
      })
      .filter((value: number) => value < 240)
  }
  try {
    await m.setOrientation('PORTRAIT')
    await m.launchApp({})
    if (!safari) {
      // An installed phone may retain a session from an earlier scratch DB.
      // A sign-in link is only consumed by the signed-out application shell.
      await m.openLink({ link: `${scheme}://account` })
      await m.tapOn({ text: 'Sign out', timeout: 3000, optional: true })
    }
    await m.openLink({
      link: safari
        ? `${app}/signin/${signInToken}`
        : `${scheme}://signin/${signInToken}`,
      ...(safari ? { browser: true } : {})
    })
    await m.tapOn({ text: 'Not Now', timeout: 3000, optional: true })
    await m.assertVisible({ text: 'Notifications', timeout: 30000 })
  } catch (error) {
    await writeFile(
      join(diagnostics, `${slug}-signin-failure.png`),
      await m.screenshot()
    )
    await m.detach()
    throw error
  }
  return {
    open: async (gameId, videoId, started) => {
      startWallMs = started
      const path = `games/${gameId}?tab=watch&video=${videoId}`
      await m.openLink({
        link: safari ? `${app}/${path}` : `${scheme}://${path}`,
        ...(safari ? { browser: true } : {})
      })
      await m.assertVisible({ text: 'Watch full screen', timeout: 30000 })
      // The observed portrait card's central square is its play/pause control.
      await m.tapOn({ point: '50%,55%' })
      const deadline = Date.now() + 30000
      while (!((await clocks())[0] > 0)) {
        if (Date.now() >= deadline)
          throw new Error(`${slug}: playback did not start`)
        await new Promise(resolve => setTimeout(resolve, 500))
      }
    },
    sample: async () => {
      const samples: Array<{ elapsed: number; positions: number[] }> = []
      const start = Date.now()
      for (let i = 0; i <= 6; i++) {
        if (i > 0) await new Promise(resolve => setTimeout(resolve, 5000))
        samples.push({
          elapsed: (Date.now() - start) / 1000,
          positions: await clocks()
        })
        await writeFile(join(frames, `${i}.png`), await m.screenshot())
      }
      await appendFile(
        join(artifacts, 'device-pass.log'),
        `$ node -r sucrase/register src/app/player/liveOrigin.e2e.ts --device ${slug}\n${JSON.stringify(samples)}\nOn-device functional evidence sampled every five seconds; external frame pacing is unmeasured.\n`
      )
      // Physical iOS does not support maestro-d's startRecording command.
      // Preserve the sampled frames as a labelled evidence sequence instead.
      await promisify(execFile)(process.env.TS_E2E_FFMPEG ?? 'ffmpeg', [
        '-y',
        '-framerate',
        '1/5',
        '-i',
        join(frames, '%d.png'),
        '-vf',
        'crop=iw:trunc(ih*0.86/2)*2:0:0',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        join(artifacts, `live-${slug}.mp4`)
      ])
      const first = Math.min(...samples[0].positions)
      const last = Math.min(...samples.at(-1)!.positions)
      if (
        !Number.isFinite(first) ||
        !Number.isFinite(last) ||
        last - first < 25
      )
        throw new Error(
          `${slug}: displayed playback position did not advance by 25 seconds`
        )
    },
    ended: async duration => {
      const deadline = Date.now() + 60000
      for (;;) {
        const positions = await clocks()
        if (
          positions.length >= (safari ? 2 : 1) &&
          Math.min(...positions) >= Math.floor(duration) - 1
        )
          break
        if (Date.now() >= deadline)
          throw new Error(`${slug}: player did not reach the recording end`)
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
      const endedFrame = join(frames, 'ended.png')
      await writeFile(endedFrame, await m.screenshot())
      await promisify(execFile)(process.env.TS_E2E_FFMPEG ?? 'ffmpeg', [
        '-y',
        '-i',
        endedFrame,
        '-vf',
        'crop=iw:trunc(ih*0.86/2)*2:0:0',
        '-frames:v',
        '1',
        join(artifacts, `ended-${slug}.png`)
      ])
    },
    close: async () => {
      await m.detach()
    }
  }
}
