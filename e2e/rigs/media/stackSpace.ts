import { BlockedError } from '../../core/result'
import type { HarnessContext, StackControl } from '../../core/spec'

/**
 * The media work a recording scenario needs done on the stack itself, where
 * the API, its database and its Space are: each is one call to the stack's
 * `remux` control route, which runs it there and answers what it did. A
 * test never reaches the stack's droplet, database or Space keys itself.
 *
 * The route takes `{ action, ... }`:
 *
 *   programme   { seconds, path }      encodes a test programme (HEVC with
 *                                      sound, keyed every 2 s) and serves it
 *                                      on the pages stand-in at `path`
 *                                      → { path, bytes }
 *   single-file { videoId, gameId, title, startAt, seconds }
 *                                      a programme remuxed to one video.mp4
 *                                      under videos/<videoId>/, and its row,
 *                                      as every upload before segments was
 *                                      → { videoId }
 *   segment     { args }               `segmentSpaceVideos` with `args`
 *                                      → { output }
 *   objects     { prefix }             the Space's objects under `prefix`
 *                                      → { objects: [{ key, size }] }
 *   play        { gameId, battingTeamId, videoId, secondsIn, atBatIndex }
 *                                      a play `secondsIn` into the video's
 *                                      own clock, so the game lists it as a
 *                                      highlight → { eventId }
 *   machine     {}                     the droplet's size → { vcpus, memGiB }
 */
export interface StackMedia {
  programme: (options: {
    seconds: number
    path: string
  }) => Promise<{ path: string; bytes: number }>
  singleFile: (options: {
    videoId: string
    gameId: string
    title: string
    startAt: string
    seconds: number
  }) => Promise<{ videoId: string }>
  segment: (args: string[]) => Promise<string>
  objects: (prefix: string) => Promise<Array<{ key: string; size: number }>>
  play: (options: {
    gameId: string
    battingTeamId: string
    videoId: string
    secondsIn: number
    atBatIndex: number
  }) => Promise<string>
  machine: () => Promise<{ vcpus: number; memGiB: number }>
}

/** The stack's control routes, or blocked: these scenarios need them. */
export function stackControl(ctx: HarnessContext): StackControl {
  const control = ctx.stack.control
  if (control == null) {
    throw new BlockedError('this stack has no control routes for its media')
  }
  return control
}

/** The stack's API, where the apps send their uploads. */
export function stackApi(ctx: HarnessContext): string {
  return `${ctx.stack.origin.replace(/\/+$/, '')}/api/v1`
}

/** The media actions above, over the stack's `remux` route. */
export function stackMedia(control: Pick<StackControl, 'remux'>): StackMedia {
  const call = async (action: string, body: object): Promise<any> =>
    await control.remux({ action, ...body })
  return {
    programme: async options => await call('programme', options),
    singleFile: async options => await call('single-file', options),
    segment: async args =>
      ((await call('segment', { args })) as { output: string }).output,
    objects: async prefix =>
      (
        (await call('objects', { prefix })) as {
          objects: Array<{ key: string; size: number }>
        }
      ).objects,
    play: async options =>
      ((await call('play', options)) as { eventId: string }).eventId,
    machine: async () => await call('machine', {})
  }
}
