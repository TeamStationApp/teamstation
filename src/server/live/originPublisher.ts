import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  codecsAttribute,
  codecsFromInit,
  pictureSizeFromInit
} from '../media/codecString'
import {
  ffprobeFor,
  type ProbedStream,
  probeVideoStream
} from '../media/ffmpeg'
import { putObject, putObjectFile } from '../media/images'
import { presignGetUrl } from '../media/presign'
import type { SpaceSettings } from '../media/spacesHls'
import {
  contentTypeFor,
  listSpaceObjectEntries,
  verifyObjectLength
} from '../media/spacesVideo'
import { type MediaPlaylist, parseMediaPlaylist } from '../media/wallClockScan'
import {
  combinedMaster,
  masterPictureSize,
  type PictureSize
} from './finishVideo'
import { isSegmentName, objectKey, publishedPlaylist } from './originPublish'
import { FIRST_INIT, isInitName, listedSegments } from './segmentClock'

interface FileStamp {
  size: number
  mtimeMs: number
  md5: string
}
/** The init segments a playlist names, in order, each once. */
function initsOf(playlist: MediaPlaylist): string[] {
  return [
    ...new Set([
      ...(playlist.map == null ? [] : [playlist.map.uri]),
      ...playlist.segments.flatMap(segment =>
        segment.map == null ? [] : [segment.map.uri]
      )
    ])
  ]
}

export interface OriginPublisherOptions {
  space: SpaceSettings
  videoId: string
  dir: string
  ffmpegPath: string
  isFinal: (name: string) => boolean
  rowExists: () => Promise<boolean>
  onFirstSegment: (probe: ProbedStream) => Promise<void>
  /** The recording's largest picture, when a later part has changed it. */
  onLargestPicture: (size: PictureSize) => Promise<void>
  log: (message: string) => void
  /** A test may substitute a probe; object I/O still goes through HTTP. */
  probe?: (playlist: string) => Promise<ProbedStream>
}

export interface OriginFlush {
  complete: boolean
  body?: string
}

/**
 * One video's remote origin. Its caller serializes start, flush and close on
 * the video's own queue, so a slow store never holds the live controller tick.
 */
export class OriginPublisher {
  closing = false
  private stopped = false
  private started = false
  private masterWritten = false
  private notified = false
  /** How many parts the Space's master has been written to cover. */
  private partsInMaster = 1
  private metadata?: ProbedStream
  private lastBody?: string
  private readonly acknowledged = new Map<string, FileStamp>()
  private readonly published = new Set<string>()

  constructor(private readonly options: OriginPublisherOptions) {}

  stop(): void {
    this.stopped = true
  }

  /** Seed from remote checksums, never one GET per segment. */
  async start(): Promise<void> {
    if (this.started || !(await this.active())) return
    const body = await this.localPlaylist()
    if (body == null) return
    const { space, videoId } = this.options
    const entries = await listSpaceObjectEntries(space, `videos/${videoId}/`)
    const remote = new Map(entries.map(entry => [entry.key, entry]))
    const response = await fetch(
      presignGetUrl({
        ...space,
        key: objectKey(videoId, 'index.m3u8'),
        expiresSec: 300
      })
    )
    if (response.ok) {
      const held = await response.text()
      for (const segment of parseMediaPlaylist(held).segments) {
        if (!isSegmentName(segment.uri))
          throw new Error('Invalid published live segment URI')
        this.published.add(segment.uri)
      }
      this.lastBody = held
    } else {
      await response.body?.cancel()
      if (response.status !== 404)
        throw new Error(`Reading live origin answered ${response.status}`)
    }
    const local = parseMediaPlaylist(body)
    const names = [
      ...initsOf(local).filter(isInitName),
      ...local.segments.map(segment => segment.uri)
    ]
    for (const name of names) {
      const entry = remote.get(objectKey(videoId, name))
      if (entry == null) continue
      const here = await this.snapshot(name)
      if (here?.size === entry.size && here.md5 === entry.etag.toLowerCase())
        this.acknowledged.set(name, here)
    }
    this.masterWritten = remote.has(objectKey(videoId, 'master.m3u8'))
    this.started = true
  }

  async flush(options: { close?: boolean } = {}): Promise<OriginFlush> {
    if ((this.closing && options.close !== true) || !(await this.active()))
      return { complete: false }
    await this.start()
    const onDisk = await this.localPlaylist()
    if (onDisk == null || !(await this.active())) return { complete: false }
    const playlist = parseMediaPlaylist(onDisk)
    if (playlist.segments.length === 0) return { complete: false }
    // Validate every name before performing any write.
    for (const segment of playlist.segments)
      objectKey(this.options.videoId, segment.uri)
    if (playlist.map?.uri !== FIRST_INIT)
      throw new Error('Live playlist has no init.mp4 map')
    const inits = initsOf(playlist)
    // Every map is in the store before the segments listed under it.
    for (const init of inits) {
      objectKey(this.options.videoId, init)
      if (!(await this.publishFile(init))) return { complete: false }
    }
    let failure: unknown
    let failed = false
    for (const segment of playlist.segments) {
      if (!this.options.isFinal(segment.uri)) break
      try {
        if (!(await this.publishFile(segment.uri))) break
      } catch (error) {
        failure = error
        failed = true
        break
      }
    }
    const acknowledged = new Set<string>()
    for (const segment of playlist.segments) {
      if (
        this.options.isFinal(segment.uri) &&
        (await this.unchanged(segment.uri, this.acknowledged.get(segment.uri)))
      )
        acknowledged.add(segment.uri)
    }
    // A reconnect can replace the init while a slow segment upload runs.
    for (const init of inits) {
      if (!(await this.unchanged(init, this.acknowledged.get(init))))
        return { complete: false }
    }
    const body = publishedPlaylist(onDisk, acknowledged, this.published)
    const exposed = parseMediaPlaylist(body).segments
    if (exposed.length > 0 && (await this.active())) {
      if (body !== this.lastBody) {
        await this.putPlaylist('index.m3u8', body)
        this.lastBody = body
        for (const segment of exposed) this.published.add(segment.uri)
      }
      if (!this.notified && acknowledged.size > 0) {
        this.metadata ??= await this.probe(body)
        if (!this.masterWritten && (await this.active())) {
          const { width, height } = this.metadata
          await this.putPlaylist(
            'master.m3u8',
            await this.masterOfPart(
              FIRST_INIT,
              exposed[0],
              width == null || height == null ? undefined : { width, height }
            )
          )
          this.masterWritten = true
        }
        if (await this.active()) {
          await this.options.onFirstSegment(this.metadata)
          this.notified = true
        }
      }
      if (this.notified && this.masterWritten) await this.sayEveryPart(body)
    }
    if (failed) throw failure
    return {
      complete:
        playlist.ended &&
        acknowledged.size === playlist.segments.length &&
        this.lastBody === body &&
        this.notified &&
        !this.stopped,
      body
    }
  }

  /** A master playlist of one part, from its init segment and first segment. */
  private async masterOfPart(
    init: string,
    first: { uri: string; durationSec: number },
    size: PictureSize | undefined
  ): Promise<string> {
    const { dir } = this.options
    const codecs = codecsAttribute(
      codecsFromInit(await readFile(join(dir, init)))
    )
    const bytes = (await stat(join(dir, first.uri))).size
    // Include every track's bytes; HLS probes commonly report no bitrate.
    const bandwidth = Math.max(
      1,
      Math.ceil(((bytes * 8) / first.durationSec) * 1.1)
    )
    const attributes = [
      `BANDWIDTH=${bandwidth}`,
      ...(size == null ? [] : [`RESOLUTION=${size.width}x${size.height}`]),
      ...(codecs === '' ? [] : [`CODECS="${codecs}"`])
    ]
    return `#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-STREAM-INF:${attributes.join(',')}\nindex.m3u8\n`
  }

  /**
   * Once a playlist lists a part with its own init segment, the Space's master
   * and the video's row say the most any part needs, as a recording finished
   * on this machine does (`combinedMaster`): players choose by the master, and
   * the first part's says only what that part needs. Each pass that lists a new
   * part does it, which the closing pass is one of, and a new process does it
   * again.
   *
   * The recording is whole and playing whatever this does. A failure is said
   * in the log and tried again at the next pass, and never stops a flush or a
   * close.
   */
  private async sayEveryPart(body: string): Promise<void> {
    const parts = new Map<string, { uri: string; durationSec: number }>()
    for (const { name, init, durationSec } of listedSegments(body)) {
      if (!parts.has(init)) parts.set(init, { uri: name, durationSec })
    }
    if (parts.size <= this.partsInMaster) return
    try {
      const { width, height } = this.metadata ?? {}
      const masters: string[] = []
      for (const [init, first] of parts) {
        const size =
          init === FIRST_INIT && width != null && height != null
            ? { width, height }
            : pictureSizeFromInit(await readFile(join(this.options.dir, init)))
        masters.push(await this.masterOfPart(init, first, size))
      }
      const master = combinedMaster(masters)
      await this.putPlaylist('master.m3u8', master)
      const size = masterPictureSize(master)
      if (size != null) await this.options.onLargestPicture(size)
      this.partsInMaster = parts.size
    } catch (error) {
      this.options.log(
        `live: ${this.options.videoId} master of ${parts.size} parts not written: ${String(error)}`
      )
    }
  }

  private async active(): Promise<boolean> {
    if (this.stopped) return false
    if (!(await this.options.rowExists())) this.stop()
    return !this.stopped
  }

  private async localPlaylist(): Promise<string | undefined> {
    try {
      return await readFile(join(this.options.dir, 'master.m3u8'), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  private async unchanged(name: string, held?: FileStamp): Promise<boolean> {
    if (held == null) return false
    const info = await stat(join(this.options.dir, name)).catch(() => undefined)
    return info?.size === held.size && info.mtimeMs === held.mtimeMs
  }

  private async snapshot(name: string): Promise<FileStamp | undefined> {
    const path = join(this.options.dir, name)
    const info = await stat(path)
    const hash = createHash('md5')
    for await (const bytes of createReadStream(path)) hash.update(bytes)
    const held = {
      size: info.size,
      mtimeMs: info.mtimeMs,
      md5: hash.digest('hex')
    }
    return (await this.unchanged(name, held)) ? held : undefined
  }

  private async publishFile(name: string): Promise<boolean> {
    if (await this.unchanged(name, this.acknowledged.get(name))) return true
    if (!(await this.active())) return false
    this.acknowledged.delete(name)
    const held = await this.snapshot(name)
    if (held == null || !(await this.active())) return false
    // FFmpeg empties an init segment as a writer continuing a recording starts,
    // and writes it again moments later. The next pass gets it.
    if (held.size === 0) return false
    const { space, videoId, dir } = this.options
    const key = objectKey(videoId, name)
    await putObjectFile({
      space,
      key,
      path: join(dir, name),
      contentType: contentTypeFor(name)
    })
    const result = await verifyObjectLength({ space, key, size: held.size })
    if (!result.ok) throw new Error(result.reason)
    if (!(await this.unchanged(name, held))) return false
    this.acknowledged.set(name, held)
    return true
  }

  private async putPlaylist(name: string, body: string): Promise<void> {
    if (!(await this.active())) return
    await putObject({
      space: this.options.space,
      key: objectKey(this.options.videoId, name),
      body: Buffer.from(body),
      contentType: contentTypeFor(name)
    })
  }

  private async probe(body: string): Promise<ProbedStream> {
    // A closed snapshot avoids waiting for more live input during ffprobe.
    const path = join(this.options.dir, '.origin-probe.m3u8')
    await writeFile(
      path,
      body.includes('#EXT-X-ENDLIST') ? body : body + '#EXT-X-ENDLIST\n'
    )
    try {
      return await (
        this.options.probe ??
        (async path =>
          await probeVideoStream(ffprobeFor(this.options.ffmpegPath), path))
      )(path)
    } finally {
      await rm(path, { force: true })
    }
  }
}
