import { mkdir, readdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'

import {
  ffprobeFor,
  MASTER_PLAYLIST,
  MEDIA_PLAYLIST,
  probeDuration,
  probeVideoStream,
  remuxToHls,
  VIDEO_FILE
} from '../media/ffmpeg'
import { LIVE_PLAYLIST_NAME } from './splitter'

/**
 * Turning a finished live stream into an ordinary recording.
 *
 * While a game is on, the stream is a growing playlist and a segment every few
 * seconds, because that is what a viewer can join in the middle of. A finished
 * game is a different thing: it is watched from the start, seeked around, and
 * has to be stored somewhere cheap. Every other recording in TeamStation is one
 * fragmented MP4 with a byte-range playlist, which is what lets a video in the
 * Space need **one** presigned URL instead of one per segment.
 *
 * So the segments are remuxed into that shape the moment the stream ends. It is
 * still `-c copy` — the same pictures, in one file instead of two thousand —
 * and afterwards the video is indistinguishable from an uploaded one, so
 * everything downstream (the Space, the playlist rewriting, stills) works
 * without knowing this video was ever live.
 */

/** The files a live stream leaves behind, alongside the recording it becomes. */
export function isLivePart(name: string): boolean {
  return name === 'init.mp4' || /^seg\d+\.m4s$/.test(name)
}

export interface VodResult {
  durationSec: number
  width?: number
  height?: number
  codecName: string
  codecTag: string
  /** The recording's own files, which are what goes to the Space. */
  files: string[]
}

/**
 * Remuxes a closed live playlist in place, and takes the segments away.
 *
 * The remux writes into a subdirectory first and the files are moved up only
 * once it has finished, so a crash in the middle leaves the live playlist
 * standing rather than a half-written recording where a game used to be.
 */
export async function toRecording(
  ffmpegPath: string,
  dir: string
): Promise<VodResult> {
  const staging = join(dir, '.vod')
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })

  await remuxToHls(ffmpegPath, {
    input: join(dir, LIVE_PLAYLIST_NAME),
    outDir: staging
  })

  const probe = await probeVideoStream(
    ffprobeFor(ffmpegPath),
    join(staging, VIDEO_FILE)
  )
  const durationSec = await probeDuration(
    ffprobeFor(ffmpegPath),
    join(staging, MEDIA_PLAYLIST)
  )

  // The segments stay where they are.
  //
  // Somebody is watching this game — that is what a game that has just ended
  // means — and their player is holding the live playlist and asking for the
  // next segment by name. Deleting the segments the moment the remux finished
  // took the end of the game away from exactly the people who cared most about
  // it. They go when the local copy does, hours later.
  //
  // The playlist itself is replaced, so anybody arriving afterwards gets the
  // recording rather than a live stream that has stopped.
  const files: string[] = []
  for (const name of await readdir(staging)) {
    await rename(join(staging, name), join(dir, name))
    files.push(name)
  }
  await rm(staging, { recursive: true, force: true })

  return {
    durationSec,
    width: probe.width,
    height: probe.height,
    codecName: probe.codecName,
    codecTag: probe.codecTag,
    files: files.sort()
  }
}

/** Whether a directory has already been turned into a recording. */
export async function isRecordingShape(dir: string): Promise<boolean> {
  const names = await readdir(dir).catch((): string[] => [])
  return names.includes(VIDEO_FILE) && names.includes(MASTER_PLAYLIST)
}
