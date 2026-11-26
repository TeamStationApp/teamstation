import { execFileSync, spawn, spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  unlinkSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'

/**
 * A phone's screen, recorded and read back on this Mac: for a screen that
 * changes faster than the phone's driver can read it, such as the last lines
 * of the schedule build modal, which show for under a second before the
 * preview opens. An Android phone records itself (`screenrecord`); a
 * USB-connected iPhone is recorded on this Mac through AVFoundation, as
 * QuickTime does (recordIosScreen.swift).
 */

export interface AndroidRecording {
  /** Stops the recording, pulls it to `localPath`, deletes it on the phone. */
  stop: (localPath: string) => Promise<void>
}

function adb(serial: string, ...args: string[]): string {
  return execFileSync('adb', ['-s', serial, ...args], { encoding: 'utf8' })
}

/** Starts recording the phone's screen (at most 170 s) until `stop`. */
export function recordAndroidScreen(serial: string): AndroidRecording {
  const onPhone = `/sdcard/e2e-${Date.now()}.mp4`
  // Detached on the phone, so it outlives this shell and is stopped by its
  // own pid, which finishes the file.
  const pid = adb(
    serial,
    'shell',
    `nohup screenrecord --time-limit 170 ${onPhone} >/dev/null 2>&1 & echo $!`
  ).trim()
  if (!/^\d+$/.test(pid)) throw new Error(`screenrecord did not start: ${pid}`)
  return {
    stop: async localPath => {
      spawnSync('adb', ['-s', serial, 'shell', `kill -2 ${pid}`])
      for (let i = 0; i < 40; i++) {
        const running = spawnSync('adb', [
          '-s',
          serial,
          'shell',
          `kill -0 ${pid} 2>/dev/null`
        ])
        if (running.status !== 0) break
        await new Promise(resolve => setTimeout(resolve, 250))
      }
      try {
        adb(serial, 'pull', onPhone, localPath)
      } finally {
        adb(serial, 'shell', `rm -f ${onPhone}`)
      }
    }
  }
}

export interface IosRecording {
  /** When the movie's first frame was recorded, in ms since 1970. */
  startedAtMs: number
  /** Stops the recording and copies the movie (QuickTime) to `localPath`. */
  stop: (localPath: string) => Promise<void>
}

/** The part of a child process a recorder is run through. */
export interface RecorderProcess {
  stdout: Readable
  stderr: Readable
  kill: (signal: NodeJS.Signals) => boolean
  once: (event: 'exit', listener: (code: number | null) => void) => unknown
}

/** Starts `command` with its output piped, as a recorder runs. */
export function spawnRecorder(
  command: string,
  args: readonly string[]
): RecorderProcess {
  return spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
}

/**
 * Runs a recorder that writes `movie` until SIGINT: once it prints
 * `{"recording": <ms>}` it is recording, and on SIGINT it finishes the movie
 * and exits 0. Fails if it has not started within `startTimeoutMs`.
 */
export async function startRecorder(
  command: string,
  args: readonly string[],
  movie: string,
  startTimeoutMs = 90_000,
  start: typeof spawnRecorder = spawnRecorder
): Promise<IosRecording> {
  const child = start(command, args)
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk
  })
  const exited = new Promise<number | null>(resolve =>
    child.once('exit', code => {
      resolve(code)
    })
  )
  const startedAtMs = await new Promise<number>((resolve, reject) => {
    let out = ''
    const timer = setTimeout(() => {
      reject(new Error(`The screen recorder did not start: ${stderr.trim()}`))
      child.kill('SIGKILL')
    }, startTimeoutMs)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      out += chunk
      const match = /\{"recording": ?(\d+)\}/.exec(out)
      if (match == null) return
      clearTimeout(timer)
      resolve(Number(match[1]))
    })
    child.once('exit', code => {
      clearTimeout(timer)
      reject(
        new Error(
          `The screen recorder exited (${code}) before recording: ${stderr.trim()}`
        )
      )
    })
  })
  return {
    startedAtMs,
    stop: async localPath => {
      child.kill('SIGINT')
      let timer: ReturnType<typeof setTimeout> | undefined
      const code = await Promise.race([
        exited,
        new Promise<'timeout'>(resolve => {
          timer = setTimeout(() => {
            resolve('timeout')
          }, 30_000)
        })
      ])
      clearTimeout(timer)
      if (code === 'timeout') child.kill('SIGKILL')
      try {
        if (code !== 0 || !existsSync(movie))
          throw new Error(
            `The screen recorder did not finish (${code}): ${stderr.trim()}`
          )
        copyFileSync(movie, localPath)
      } finally {
        if (existsSync(movie)) unlinkSync(movie)
      }
    }
  }
}

/** The name `devicectl list devices --json-output` gives a device's UDID. */
export function iosDeviceName(list: unknown, udid: string): string {
  const devices =
    (
      list as {
        result?: {
          devices?: Array<{
            deviceProperties?: { name?: string }
            hardwareProperties?: { udid?: string }
          }>
        }
      }
    ).result?.devices ?? []
  const name = devices.find(device => device.hardwareProperties?.udid === udid)
    ?.deviceProperties?.name
  if (name == null) throw new Error(`devicectl lists no device ${udid}`)
  return name
}

/**
 * Starts recording a USB-connected iPhone's screen on this Mac, until
 * `stop`. Its capture device is named as the phone is, which devicectl gives.
 */
export async function recordIosScreen(udid: string): Promise<IosRecording> {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-ios-screen-'))
  const listPath = join(dir, 'devices.json')
  let name: string
  try {
    execFileSync(
      'xcrun',
      ['devicectl', 'list', 'devices', '--json-output', listPath],
      { stdio: 'ignore' }
    )
    name = iosDeviceName(JSON.parse(readFileSync(listPath, 'utf8')), udid)
  } finally {
    if (existsSync(listPath)) unlinkSync(listPath)
  }
  const movie = join(dir, 'screen.mov')
  const recording = await startRecorder(
    'swift',
    [join(__dirname, 'recordIosScreen.swift'), name, movie],
    movie
  ).catch((error: unknown) => {
    rmdirSync(dir)
    throw error
  })
  return {
    startedAtMs: recording.startedAtMs,
    stop: async localPath => {
      try {
        await recording.stop(localPath)
      } finally {
        rmdirSync(dir)
      }
    }
  }
}

export interface FrameText {
  /** The frame's time from the recording's start, in seconds. */
  atSec: number
  lines: string[]
}

/** A recording's length, in seconds. */
export function videoSeconds(video: string): number {
  const probe = execFileSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'csv=p=0',
      video
    ],
    { encoding: 'utf8' }
  )
  return Number(probe.trim())
}

/**
 * The text of a recording's last `seconds`, `fps` frames a second, read with
 * macOS Vision (ocrFrames.swift), each line top to bottom.
 */
export function lastFramesText(
  video: string,
  seconds = 8,
  fps = 4
): FrameText[] {
  const duration = videoSeconds(video)
  return framesText(video, Math.max(0, duration - seconds), duration, fps)
}

export function screenshotText(
  paths: string[]
): Array<{ file: string; lines: string[] }> {
  const out = execFileSync(
    'swift',
    [join(__dirname, 'ocrFrames.swift'), ...paths],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  )
  return out
    .split('\n')
    .filter(line => line.startsWith('{'))
    .map(line => JSON.parse(line) as { file: string; lines: string[] })
}

/**
 * The text of a recording from `fromSec` to `toSec`, `fps` frames a second,
 * read with macOS Vision (ocrFrames.swift), each line top to bottom.
 */
export function framesText(
  video: string,
  fromSec: number,
  toSec: number,
  fps = 4
): FrameText[] {
  const from = Math.max(0, fromSec)
  const dir = mkdtempSync(join(tmpdir(), 'e2e-frames-'))
  execFileSync('ffmpeg', [
    '-v',
    'error',
    '-ss',
    String(from),
    '-i',
    video,
    '-t',
    String(Math.max(0, toSec - from)),
    '-vf',
    `fps=${fps}`,
    join(dir, 'f%04d.png')
  ])
  const frames = readdirSync(dir)
    .filter(name => name.endsWith('.png'))
    .sort()
  try {
    const read = screenshotText(frames.map(f => join(dir, f)))
    return read.map(frame => ({
      atSec: from + frames.indexOf(frame.file.split('/').at(-1)!) / fps,
      lines: frame.lines
    }))
  } finally {
    for (const name of frames) unlinkSync(join(dir, name))
    rmdirSync(dir)
  }
}
