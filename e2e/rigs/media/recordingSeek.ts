import { expect } from 'chai'

import { TeamStationClient } from '../../../src/common/api'
import { passwordBytes } from '../../../src/common/passwordProtocol'
import { nativeArgon } from '../../../src/server/auth/passwords'
import type { E2eContext, WebSession } from '../../core/spec'
import type { StackMedia } from './stackSpace'

/** What the `<video>` showing a picture is doing, the furthest along of them. */
export interface PlayerState {
  currentTime: number
  readyState: number
  paused: boolean
}

/** Reads the player, never acts on it. */
export async function playerState(
  page: WebSession['page']
): Promise<PlayerState | null> {
  return await page.evaluate(() => {
    const all = [...document.querySelectorAll('video')]
    if (all.length === 0) return null
    // The player showing a picture: a page keeps idle <video>s too, one
    // parked where the last seek asked even when it never loaded.
    const v = all.sort((a, b) => {
      const ready = Math.min(b.readyState, 2) - Math.min(a.readyState, 2)
      return ready !== 0 ? ready : b.currentTime - a.currentTime
    })[0]
    return {
      currentTime: v.currentTime,
      readyState: v.readyState,
      paused: v.paused
    }
  })
}

/**
 * Waits for the picture to be advancing near `atSec`: two readings a quarter
 * of a second apart, the second later than the first, with frames to show.
 * Answers how long it took, or throws after `withinMs`.
 */
export async function pictureAdvancingAt(
  page: WebSession['page'],
  atSec: number,
  options: { withinMs?: number; toleranceSec?: number } = {}
): Promise<{ ms: number; at: number }> {
  const within = options.withinMs ?? 5000
  const tolerance = options.toleranceSec ?? 1
  const began = Date.now()
  let last: PlayerState | null = null
  for (;;) {
    const now = await playerState(page)
    if (
      now != null &&
      last != null &&
      now.readyState >= 3 &&
      now.currentTime > last.currentTime &&
      Math.abs(last.currentTime - atSec) <= tolerance + 0.5
    ) {
      return { ms: Date.now() - began, at: last.currentTime }
    }
    if (Date.now() - began > within) {
      throw new Error(
        `no picture advancing at ${atSec} s within ${within} ms: ${await allPlayers(page)}`
      )
    }
    last = now
    await new Promise(resolve => setTimeout(resolve, 250))
  }
}

/** A coach's session token on the stack, through the real password protocol. */
export async function apiToken(
  api: string,
  account: { email: string; password: string }
): Promise<string> {
  const session = await new TeamStationClient({
    baseUrl: api,
    passwordKdf: async (password, parameters) =>
      await nativeArgon(passwordBytes(password), parameters)
  }).signInWithPassword(account.email, account.password)
  return session.token
}

/**
 * The video's objects in the Space, under whatever secret prefix it has:
 * only playlists, an init segment and segments, each under 16 MB.
 */
export async function expectSegmentedPrefix(
  media: Pick<StackMedia, 'objects'>,
  videoId: string
): Promise<Array<{ key: string; size: number }>> {
  const entries = (await media.objects(`videos/${videoId}-`))
    .filter(entry => !entry.key.includes('/stills/'))
    .map(entry => ({ key: entry.key, size: entry.size }))
  const names = entries.map(entry => entry.key.split('/').slice(-1)[0]).sort()
  const segments = names.filter(name => /^seg\d{6}\.m4s$/.test(name))
  expect(segments.length).greaterThan(0)
  expect(names).deep.equals(
    ['init.mp4', 'master.m3u8', ...segments, 'video.m3u8'].sort()
  )
  for (const entry of entries) expect(entry.size).lessThan(16 << 20)
  return entries
}

/** The media playlist a player is handed, read through the API's routes. */
export async function servedMediaPlaylist(
  api: string,
  token: string,
  videoId: string
): Promise<string> {
  const playback = await fetch(`${api}/videos/${videoId}/playback`, {
    headers: { authorization: `Bearer ${token}` }
  })
  expect(playback.status).equals(200)
  const url = ((await playback.json()) as { url: string }).url
  const master = await (await fetch(url)).text()
  const variant = master.split('\n').find(line => line.startsWith('http'))
  expect(variant, master).not.equals(undefined)
  const response = await fetch(variant!)
  expect(response.status).equals(200)
  return await response.text()
}

/** Where the game's page starts the highlight for `eventId`, by its own API. */
export async function highlightStart(
  api: string,
  token: string,
  videoId: string,
  eventId: string
): Promise<{ startOffsetSec: number; playOffsetSec: number }> {
  const response = await fetch(`${api}/videos/${videoId}/highlights`, {
    headers: { authorization: `Bearer ${token}` }
  })
  expect(response.status).equals(200)
  const body = (await response.json()) as {
    highlights: Array<{
      eventId: string
      startOffsetSec: number
      playOffsetSec: number
    }>
  }
  const found = body.highlights.find(h => h.eventId === eventId)
  expect(found, `highlight ${eventId}`).not.equals(undefined)
  return found!
}

/**
 * Signs the role in through the real password form at desktop width.
 * `signInWithPassword` knows it worked by the phone layout's "TeamStation
 * menu", which the desktop sidebar does not have, and types the form again;
 * here the signed-in home itself is the proof.
 */
export async function signInOnDesktop(
  ctx: E2eContext,
  m: WebSession['m'],
  role: string
): Promise<void> {
  try {
    await ctx.signIn(role)
  } catch (error) {
    try {
      await m.assertVisible({ text: 'Your Home', timeout: 10000 })
    } catch {
      throw error
    }
  }
}

/** Every <video> on the page, for a failure to say what the page held. */
export async function allPlayers(page: WebSession['page']): Promise<string> {
  return await page.evaluate(() =>
    JSON.stringify(
      [...document.querySelectorAll('video')].map(v => {
        const box = v.getBoundingClientRect()
        return {
          t: Number(v.currentTime.toFixed(2)),
          ready: v.readyState,
          paused: v.paused,
          size: `${Math.round(box.width)}x${Math.round(box.height)}`,
          shown: box.width > 0 && getComputedStyle(v).visibility !== 'hidden'
        }
      })
    )
  )
}
