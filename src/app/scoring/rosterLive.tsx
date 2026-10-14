import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Text, View } from 'react-native'

import type { GameSocketEvent } from '../../common/gameSocket'
import { lstrings } from '../locales/strings'
import { useTheme } from '../theme/ThemeContext'

/** The part of the app's `GameSocket` a screen hears one game's changes on. */
export interface GameChanges {
  subscribe: (
    gameId: string,
    listener: (event: GameSocketEvent) => void
  ) => () => void
}

/**
 * Hears one game's changes, or nothing where the socket cannot be had (a
 * platform with no WebSocket, or an API address it cannot be found from):
 * the screen then works as it did without one. Returns the way to stop.
 */
export function listen(
  socket: GameChanges,
  gameId: string,
  listener: (event: GameSocketEvent) => void
): () => void {
  try {
    return socket.subscribe(gameId, listener)
  } catch {
    return () => undefined
  }
}

/**
 * The lineups digests a roster screen has seen, to tell another device's
 * change from its own.
 *
 * It keeps the last digest it read or saved. While a read or the screen's own
 * save is out, every digest heard is held. When a read answers, a held digest
 * equal to the answer is already in what was read and is dropped, and any
 * other is heard then. When the screen's own save answers, every digest held
 * is dropped: the save replayed the game as stored, so it was written over
 * whatever was heard before it answered. Otherwise a digest that differs from
 * the kept one is somebody else's change: it is kept, and `foreign` is told.
 */
export class LineupDigests {
  private kept: string | undefined
  private waiting = 0
  private held: string[] = []

  constructor(private readonly foreign: (digest: string) => void) {}

  /** A read or a save is out: hold what is heard until it answers. */
  hold(): void {
    this.waiting++
  }

  /**
   * The read or save answered with the server's digest, or failed (no
   * digest), which leaves the kept one, and what was held, as they were.
   * A save that answers (`saved`) drops everything held.
   */
  answered(digest: string | undefined, saved = false): void {
    this.waiting = Math.max(0, this.waiting - 1)
    if (digest != null) {
      this.kept = digest
      this.held = saved ? [] : this.held.filter(each => each !== digest)
    }
    if (this.waiting > 0) return
    const held = this.held
    this.held = []
    for (const each of held) this.heard(each)
  }

  /** A `lineups` change arrived with this digest. */
  heard(digest: string): void {
    if (this.waiting > 0) {
      this.held.push(digest)
      return
    }
    if (digest === this.kept) return
    this.kept = digest
    this.foreign(digest)
  }
}

export interface RosterLiveOptions {
  /** The app's game socket; without one nothing is followed. */
  socket?: GameChanges
  gameId: string
  /** Whether the draft holds changes not saved. */
  dirty: boolean
  /** Reads the lineups' digest as the server holds it now. */
  read: () => Promise<string>
  /**
   * Another device changed the lineups under a clean draft: read the game
   * again and start the draft over from it.
   */
  onReload: () => void
}

export interface RosterLive {
  /**
   * Somebody else changed the lineups under unsaved changes: the screen shows
   * `RosterConflictBanner` while the draft stays dirty.
   */
  conflict: boolean
  /**
   * Starts following: holds what is heard while the digest is read. A screen
   * calls it as it opens, before it reads the game, so a change that lands
   * in between is heard.
   */
  start: () => void
  /** Stops following, as the screen closes. */
  stop: () => void
  /**
   * The screen's own save is out, answering with the digest it stored. What
   * is heard meanwhile waits for it: a success was written over it, and
   * clears the warning, as the last save wins; a failure hears it then.
   */
  saving: (answer: Promise<string>) => void
  /** Drops the warning: the screen has gone back to the server's copy. */
  clear: () => void
}

/**
 * A roster screen following the game socket's `lineups` changes while it is
 * open: a clean draft is read again (`onReload`), and a dirty one is left
 * alone under a warning. A dirty draft with a warning that becomes clean is
 * read again then. The scorekeeper's roster sheet and the coach's screen
 * each follow this way.
 */
export function useRosterLive(options: RosterLiveOptions): RosterLive {
  const { socket, gameId, dirty } = options
  const [conflict, setConflict] = useState(false)
  const latest = useRef(options)
  latest.current = options
  const digests = useRef<LineupDigests | undefined>(undefined)
  useEffect(() => {
    if (socket == null) return
    let live = true
    const stop = listen(socket, gameId, event => {
      const following = digests.current
      if (following == null) return
      if (event.type === 'change' && event.kind === 'lineups') {
        following.heard(event.data.digest)
        return
      }
      // Changes may have been missed while the socket was down.
      if (event.type !== 'resync') return
      latest.current
        .read()
        .then(digest => {
          if (live && digests.current === following) following.heard(digest)
        })
        .catch(() => undefined)
    })
    return () => {
      live = false
      stop()
    }
  }, [socket, gameId])
  const start = useCallback(() => {
    if (latest.current.socket == null) return
    const following = new LineupDigests(() => {
      if (digests.current !== following) return
      if (latest.current.dirty) setConflict(true)
      else latest.current.onReload()
    })
    digests.current = following
    setConflict(false)
    following.hold()
    latest.current.read().then(
      digest => {
        following.answered(digest)
      },
      () => {
        following.answered(undefined)
      }
    )
  }, [])
  const stop = useCallback(() => {
    digests.current = undefined
    setConflict(false)
  }, [])
  const saving = useCallback((answer: Promise<string>) => {
    const following = digests.current
    if (following == null) return
    following.hold()
    answer.then(
      digest => {
        if (digests.current === following) setConflict(false)
        following.answered(digest, true)
      },
      () => {
        following.answered(undefined)
      }
    )
  }, [])
  const clear = useCallback(() => {
    setConflict(false)
  }, [])
  // Changes undone by hand leave nothing to protect: take theirs.
  useEffect(() => {
    if (!conflict || dirty) return
    setConflict(false)
    latest.current.onReload()
  }, [conflict, dirty])
  return { conflict: conflict && dirty, start, stop, saving, clear }
}

/**
 * The warning at the top of a roster screen whose unsaved changes another
 * device's change has arrived under, in the yellow outline of the scoring
 * instructions.
 */
export function RosterConflictBanner(): React.ReactElement {
  const theme = useTheme()
  return (
    <View
      testID="Roster conflict"
      accessibilityRole="alert"
      style={{
        borderRadius: theme.rem(theme.radiusRem),
        borderWidth: 2,
        borderColor: theme.scoringInstructionBorder,
        backgroundColor: theme.scoringInstructionBackground,
        paddingHorizontal: 8,
        paddingVertical: 6
      }}
    >
      <Text
        style={{
          color: theme.scoringCountdownColor,
          fontFamily: theme.semiBoldTextFont,
          fontSize: 14,
          lineHeight: 18
        }}
      >
        {lstrings.scoring_roster_conflict}
      </Text>
    </View>
  )
}
