import type React from 'react'

/**
 * What the stack navigator draws, and the rules that decide how it moves.
 *
 * Pure, so the rules can be tested without a renderer. `StackNavigator.tsx`
 * animates what these say; `App.tsx` builds the scenes.
 */

/** A screen pushed over another, or a full-screen cover from the bottom. */
export type Presentation = 'push' | 'cover'
export type Direction = 'forward' | 'back'

export interface StackScene {
  /** Stable across in-place frame updates; see `frameKey`. */
  key: string
  /** The tab whose stack it belongs to. */
  group: string
  /** 0 is the tab's root screen. */
  depth: number
  presentation: Presentation
  /** Draws its own chrome: no header or navbar over it. */
  immersive: boolean
  node: React.ReactNode
}

export type StackTransition =
  { kind: 'none' } | { kind: Direction; presentation: Presentation }

/** How far the covered screen shifts, as a share of the width. */
export const PARALLAX = 0.3
/** How wide the strip at the left edge that starts a drag back is. */
export const EDGE_WIDTH = 24
export const PUSH_MS = 350
export const COVER_MS = 400

/**
 * The move from the scene on show to the next one.
 *
 * The navigation path says which way it went (`intent`); only a stack change
 * no path labelled is inferred, and then only within one tab: a tab switch,
 * a sign-in or an in-place replace does not move. A pop to the root from
 * several levels deep is one back.
 */
export function transitionOf(
  from: StackScene | undefined,
  to: StackScene,
  intent: Direction | 'none' | undefined
): StackTransition {
  if (from == null || from.key === to.key) return { kind: 'none' }
  if (intent === 'forward')
    return { kind: 'forward', presentation: to.presentation }
  if (intent === 'back')
    return { kind: 'back', presentation: from.presentation }
  if (intent === 'none' || from.group !== to.group) return { kind: 'none' }
  if (to.depth > from.depth)
    return { kind: 'forward', presentation: to.presentation }
  if (to.depth < from.depth)
    return { kind: 'back', presentation: from.presentation }
  return { kind: 'none' }
}

/**
 * Whether a released drag back pops: past half way, or flung rightward. A
 * leftward fling always springs back, however far it got.
 */
export function swipeCompletes(dx: number, vx: number, width: number): boolean {
  return vx >= -200 && (dx > width / 2 || (vx > 500 && dx > 0))
}

/**
 * A frame, as far as telling one screen from another goes: its name and the
 * ids that pick out what it shows. The same fields `history.ts` matches a
 * screen by, plus Coach Game's team.
 */
export interface FrameIdentity {
  name: string
  team?: { id: string }
  gameId?: string
  userId?: string
  season?: { id: string }
  kind?: string
  id?: string
  teamId?: string
}

/**
 * Which screen a frame is, ignoring everything that changes in place — its
 * section, filters, the video's moment, its title.
 */
export function identityOf(frame: FrameIdentity): string {
  const parts = [
    frame.name,
    frame.team?.id,
    frame.gameId,
    frame.userId,
    frame.season?.id,
    frame.kind,
    frame.id,
    frame.name === 'coachGame' ? frame.teamId : undefined
  ]
  return parts.map(part => part ?? '').join(':')
}

/**
 * The scene key of `frames[index]` in `group`'s stack.
 *
 * Keyed by identity, not depth, because a history move rebuilds the stack:
 * a player reached by Forward replaces the team at the same depth, and one
 * player screen can be at depth 2 and then depth 1. The `#n` suffix counts
 * only the unbroken run of the same screen directly below, so `[X, X]` is two
 * scenes while `[game, team, game]` keys both games alike — the top keeps its
 * key when a rebuild leaves it alone in the stack.
 */
export function frameKey(
  group: string,
  frames: readonly FrameIdentity[],
  index: number
): string {
  const identity = identityOf(frames[index])
  let run = 0
  while (
    index - run - 1 >= 0 &&
    identityOf(frames[index - run - 1]) === identity
  )
    run++
  return `${group}:${identity}#${run}`
}

/** The key of a tab's root screen. */
export function rootKey(group: string): string {
  return `${group}:root`
}

/**
 * Whether Android's system Back, which walks the history, lands where popping
 * the stack would: on the frame beneath. Only then may the back gesture drag
 * the top off; otherwise it walks as it always has.
 */
export function systemBackPops(
  previous: string | undefined,
  beneath: string
): boolean {
  return previous === beneath
}
