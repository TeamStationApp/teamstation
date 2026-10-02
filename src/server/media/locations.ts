import type { Stats } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

import type { SpaceSettings } from './spacesHls'
import { spaceConfigured } from './spacesHls'
import type { FrameSource } from './stills'

/**
 * Where a video's HLS actually sits, under Caddy's media root.
 *
 * `local` and `spaces` directories are named by video id alone, so they need
 * no lookup. PeerTube's are the awkward case: it names the master playlist
 * randomly and moves a video between `private/<id>/` and `<id>/` when its
 * privacy changes, so the directory has to be read. The answer is cached
 * against the directory's mtime, which changes when PeerTube rewrites it.
 */

export interface VideoLocation {
  /** Relative to the media root, e.g. `work/videos/vid_abc`. */
  dir: string
  /** The master playlist within that directory. */
  master: string
}

/**
 * Where a video's frames are read from, wherever its bytes ended up.
 *
 * The one thing a caller wanting a still should ask. A video on this host is a
 * path; one in the Space is named, and the fragment holding the moment is
 * fetched when a still is actually cut.
 */
export async function videoFrameSource(
  options: LocateOptions & { space: SpaceSettings }
): Promise<FrameSource | undefined> {
  const { space, storage, videoId } = options
  if (storage === 'spaces') {
    if (!spaceConfigured(space)) return undefined
    return { kind: 'space', space, videoId }
  }
  const path = await locateVideoFile(options)
  return path == null ? undefined : { kind: 'file', path }
}

/**
 * The single fragmented MP4 a video is, absolute on disk.
 *
 * Only ever what is on this host: a video in the Space has no path, and a
 * caller that wants its pictures asks `videoFrameSource` instead.
 */
export async function locateVideoFile(
  options: LocateOptions
): Promise<string | undefined> {
  const { mediaRoot, storage } = options
  if (storage === 'spaces') return undefined

  const location = await locateVideo(options)
  if (location == null) return undefined
  const dir = join(mediaRoot, location.dir)

  if (storage === 'local') {
    const path = join(dir, 'video.mp4')
    return (await exists(path)) ? path : undefined
  }

  // PeerTube names its file after the video, like its playlist.
  const names = await readdir(dir).catch((): string[] => [])
  const fragmented = names.filter(name => name.endsWith('-fragmented.mp4'))
  if (fragmented.length === 1) return join(dir, fragmented[0])
  return undefined
}

export type VideoStorage = 'peertube' | 'local' | 'spaces'

export interface LocateOptions {
  /** Caddy's media root: `/mnt/datadrive/media` in production. */
  mediaRoot: string
  storage: VideoStorage
  videoId: string
}

interface CacheEntry {
  location: VideoLocation
  mtimeMs: number
}

const peertubeCache = new Map<string, CacheEntry>()

/**
 * The video's directory and master playlist, or `undefined` if its files are
 * not where they should be — which the caller reports as `unavailable` rather
 * than handing a player a URL that will 404.
 */
export async function locateVideo(
  options: LocateOptions
): Promise<VideoLocation | undefined> {
  const { mediaRoot, storage, videoId } = options

  if (storage === 'local') {
    const dir = `work/videos/${videoId}`
    const found = await exists(join(mediaRoot, dir, 'master.m3u8'))
    return found ? { dir, master: 'master.m3u8' } : undefined
  }
  if (storage === 'spaces') {
    // Served by the API from the bucket, not from disk, so there is nothing to
    // look up: the caller does not build a `/media` URL for these.
    return { dir: `videos/${videoId}`, master: 'master.m3u8' }
  }
  return await locatePeertube(mediaRoot, videoId)
}

/**
 * PeerTube keeps a video in `private/<id>/` while it is private and `<id>/`
 * once it is public, and moves it when that changes. Both are tried, private
 * first, because everything imported from Paul's instance is private.
 */
async function locatePeertube(
  mediaRoot: string,
  videoId: string
): Promise<VideoLocation | undefined> {
  for (const dir of [`peertube/private/${videoId}`, `peertube/${videoId}`]) {
    const absolute = join(mediaRoot, dir)
    const info = await statOrUndefined(absolute)
    if (info == null) continue
    if (!info.isDirectory()) continue

    const cached = peertubeCache.get(dir)
    if (cached?.mtimeMs === info.mtimeMs) {
      return cached.location
    }

    const master = await findMaster(absolute)
    if (master == null) continue
    const location = { dir, master }
    peertubeCache.set(dir, { location, mtimeMs: info.mtimeMs })
    return location
  }
  return undefined
}

/**
 * The one `*-master.m3u8` in a PeerTube directory. If there is more than one,
 * this refuses rather than guessing: serving the wrong resolution silently is
 * worse than reporting the video as unavailable.
 */
export async function findMaster(
  absoluteDir: string
): Promise<string | undefined> {
  const names = await readdir(absoluteDir).catch((): string[] => [])
  const masters = names.filter(name => name.endsWith('-master.m3u8'))
  if (masters.length === 1) return masters[0]
  if (masters.length === 0 && names.includes('master.m3u8')) {
    return 'master.m3u8'
  }
  return undefined
}

async function exists(path: string): Promise<boolean> {
  return (await statOrUndefined(path)) != null
}

async function statOrUndefined(path: string): Promise<Stats | undefined> {
  try {
    return await stat(path)
  } catch {
    return undefined
  }
}
