import { spawnSync } from 'node:child_process'

/**
 * Free measurements of a recording, made before anyone pays to look at it. They answer
 * "is the picture up", never a pacing question: smoothness stays on the bench camera.
 */
export interface VideoInterval {
  start: number
  end: number
}

export interface VideoMeasurement {
  durationSec: number
  hasAudio: boolean
  frozen: VideoInterval[]
  black: VideoInterval[]
  silent: VideoInterval[]
}

function intervals(
  log: string,
  startPattern: RegExp,
  endPattern: RegExp,
  durationSec: number
): VideoInterval[] {
  const starts = [...log.matchAll(startPattern)].map(row => Number(row[1]))
  const ends = [...log.matchAll(endPattern)].map(row => Number(row[1]))
  return starts.map((start, index) => ({
    start,
    end: ends[index] ?? durationSec
  }))
}

export function parseMeasurement(log: string): VideoMeasurement {
  const time = /Duration: (\d+):(\d+):([\d.]+)/.exec(log)
  const durationSec =
    time == null
      ? 0
      : Number(time[1]) * 3600 + Number(time[2]) * 60 + Number(time[3])
  const black = [
    ...log.matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)
  ].map(row => ({ start: Number(row[1]), end: Number(row[2]) }))
  return {
    durationSec,
    hasAudio: /Stream #\S+.*: Audio:/.test(log),
    frozen: intervals(
      log,
      /freeze_start: ([\d.]+)/g,
      /freeze_end: ([\d.]+)/g,
      durationSec
    ),
    black,
    silent: intervals(
      log,
      /silence_start: ([\d.]+)/g,
      /silence_end: ([\d.]+)/g,
      durationSec
    )
  }
}

export function measureVideo(
  path: string,
  ffmpeg = 'ffmpeg'
): VideoMeasurement {
  const probe = spawnSync(ffmpeg, ['-hide_banner', '-i', path], {
    encoding: 'utf8'
  })
  const hasAudio = /Stream #\S+.*: Audio:/.test(probe.stderr)
  const run = spawnSync(
    ffmpeg,
    [
      '-hide_banner',
      '-i',
      path,
      '-vf',
      'freezedetect=n=0.003:d=1,blackdetect=d=0.5:pix_th=0.1',
      ...(hasAudio ? ['-af', 'silencedetect=n=-50dB:d=1'] : []),
      '-f',
      'null',
      '-'
    ],
    { encoding: 'utf8' }
  )
  if (run.status !== 0) {
    throw new Error(`ffmpeg could not read ${path}: ${run.stderr.slice(-300)}`)
  }
  return parseMeasurement(run.stderr)
}

/** What is wrong with the recording, in words a report can carry. */
export function videoProblems(
  measured: VideoMeasurement,
  options: { expectAudio?: boolean } = {}
): string[] {
  const total = (rows: VideoInterval[]): number =>
    rows.reduce((sum, row) => sum + (row.end - row.start), 0)
  const problems: string[] = []
  const add = (name: string, rows: VideoInterval[]): void => {
    if (rows.length > 0) {
      problems.push(`${name} for ${total(rows).toFixed(1)}s`)
    }
  }
  add('frozen', measured.frozen)
  add('black', measured.black)
  add('silent', measured.silent)
  if (options.expectAudio === true && !measured.hasAudio) {
    problems.push('no audio track')
  }
  return problems
}

/** A grid of frames, the only form of video an AI judge is shown. */
export function contactSheet(
  path: string,
  outPath: string,
  ffmpeg = 'ffmpeg'
): void {
  const run = spawnSync(
    ffmpeg,
    [
      '-hide_banner',
      '-y',
      '-i',
      path,
      '-vf',
      'fps=1,scale=480:-2,tile=3x3',
      '-frames:v',
      '1',
      outPath
    ],
    { encoding: 'utf8' }
  )
  if (run.status !== 0) {
    throw new Error(`ffmpeg could not sheet ${path}: ${run.stderr.slice(-300)}`)
  }
}
