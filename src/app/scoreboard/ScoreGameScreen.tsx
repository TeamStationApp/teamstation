import Clipboard from '@react-native-clipboard/clipboard'
import React, { useEffect, useState } from 'react'
import {
  ActivityIndicator,
  Platform,
  Pressable,
  Text,
  View
} from 'react-native'

import type { GameDetail, TeamStationClient } from '../../common/api'
import { httpOrigin, PRIMARY_HOST } from '../../common/primaryUrl'
import { Button, Card, Icon, Screen } from '../components'
import { lstrings } from '../locales/strings'
import { scoringEntry } from '../scoring/isUnscoredGame'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

/** How long "Copied" stays up after the link is copied. */
export const COPIED_MS = 2000

export interface ScoreGameScreenProps {
  client: TeamStationClient
  gameId: string
  /** Opens the full scorer, at `/games/<gameId>/score`. */
  onFullScoring: () => void
  /** Opens the simplified scoreboard, at `/games/<gameId>/scoreboard-override`. */
  onScoreboard: () => void
  /**
   * The site the widget link is on. The page's own origin by default, so a
   * seat or a local server hands out a link to itself; the primary site
   * where there is no page.
   */
  origin?: string
}

/**
 * Everything the people running a game do to its score, behind the game
 * page's one Score Game pill: full scoring, the simplified scoreboard (1.0's
 * override dashboard), and the scoreboard's web widget link to paste into OBS
 * or TS Director.
 *
 * Each option says why when it is not on offer, because the screen can be
 * reached by its address as well as by the pill. The link is always shown: a
 * closed scoreboard answers it with the branded 404, which is still the right
 * thing to have pasted.
 */
export function ScoreGameScreen(
  props: ScoreGameScreenProps
): React.ReactElement {
  const { client, gameId, onFullScoring, onScoreboard } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const [game, setGame] = useState<GameDetail | undefined>(undefined)
  const [missing, setMissing] = useState(false)

  useEffect(() => {
    let live = true
    setGame(undefined)
    setMissing(false)
    client
      .game(gameId)
      .then(found => {
        if (live) setGame(found)
      })
      .catch(() => {
        if (live) setMissing(true)
      })
    return () => {
      live = false
    }
  }, [client, gameId])

  if (missing) {
    return (
      <View style={styles.centre}>
        <Text style={styles.messageHeading}>{lstrings.common_not_found}</Text>
        <Text style={styles.message}>{lstrings.common_not_found_detail}</Text>
      </View>
    )
  }
  if (game == null) {
    return (
      <View style={styles.centre}>
        <ActivityIndicator color={theme.primaryTextColor} />
      </View>
    )
  }

  return (
    <Screen>
      <ScoreGameOptions
        game={game}
        origin={props.origin}
        onFullScoring={onFullScoring}
        onScoreboard={onScoreboard}
      />
    </Screen>
  )
}

export interface ScoreGameOptionsProps {
  game: GameDetail
  /** Opens the full scorer. */
  onFullScoring?: () => void
  /** Opens the simplified scoreboard. */
  onScoreboard?: () => void
  /** The site the widget link is on. The page's own origin by default. */
  origin?: string
}

/**
 * The three choices under the Score Game pill: full scoring, the simplified
 * scoreboard, and the widget link.
 *
 * Drawn on the game page, under the same hero and pills as Videos and Box
 * score. It does not bring its own screen padding: the page already has the
 * one the hero uses, and a second inset is what made the hero jump.
 */
export function ScoreGameOptions(
  props: ScoreGameOptionsProps
): React.ReactElement {
  const { game, onFullScoring, onScoreboard } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => {
      setCopied(false)
    }, COPIED_MS)
    return () => {
      clearTimeout(timer)
    }
  }, [copied])

  // Full scoring is for the people the server lets write plays: the same
  // `canScore` that decides whether the pill shows. Somebody who reaches this
  // tab by its address is told why not.
  const fullReason = !game.canScore
    ? lstrings.score_game_full_not_scorer
    : scoringEntry(game) == null
      ? lstrings.score_game_full_unavailable
      : undefined
  const fullScoring = fullReason == null
  const board = game.scoreboard
  const scoreboardReason =
    board == null
      ? lstrings.score_game_scoreboard_unavailable
      : !board.open
        ? lstrings.score_game_scoreboard_closed
        : !board.mayOverride
          ? lstrings.score_game_scoreboard_not_runner
          : undefined
  const link = `${props.origin ?? siteOrigin()}/scoreboard/${game.id}`

  return (
    <View style={styles.options}>
      <Card style={styles.section}>
        <Text style={styles.header}>{lstrings.score_game_full_header}</Text>
        <Button
          label={lstrings.score_game_full}
          accessibilityLabel={lstrings.score_game_full}
          block
          disabled={!fullScoring}
          onPress={() => {
            onFullScoring?.()
          }}
        />
        {fullReason != null && <Text style={styles.reason}>{fullReason}</Text>}
      </Card>

      <Card style={styles.section}>
        <Text style={styles.header}>
          {lstrings.score_game_scoreboard_header}
        </Text>
        <Button
          label={lstrings.score_game_scoreboard}
          accessibilityLabel={lstrings.score_game_scoreboard}
          kind="secondary"
          block
          disabled={scoreboardReason != null}
          onPress={() => {
            onScoreboard?.()
          }}
        />
        {scoreboardReason != null && (
          <Text style={styles.reason}>{scoreboardReason}</Text>
        )}
      </Card>

      <Card flush style={styles.section}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={lstrings.score_game_copy_link}
          style={({ pressed }) => [styles.linkCard, pressed && styles.pressed]}
          onPress={() => {
            Clipboard.setString(link)
            setCopied(true)
          }}
        >
          <View style={styles.linkHeader}>
            <Text style={[styles.header, styles.linkTitle]}>
              {lstrings.score_game_link_header}
            </Text>
            <Icon name="content_copy" size={1.25} color={theme.activeColor} />
          </View>
          <Text
            numberOfLines={2}
            selectable
            style={styles.link}
            testID="scoreboardLink"
          >
            {link}
          </Text>
          {copied && (
            <Text style={styles.copied} accessibilityLiveRegion="polite">
              {lstrings.score_game_copied}
            </Text>
          )}
        </Pressable>
      </Card>
    </View>
  )
}

/**
 * The site this page is on: `window.location.origin` in a browser, and the
 * primary site on a phone, which has a window and no location.
 */
export function siteOrigin(
  scope: { window?: { location?: { origin?: string } } } = globalThis
): string {
  return scope.window?.location?.origin ?? httpOrigin(PRIMARY_HOST)
}

/**
 * Fixed width: this is an address somebody pastes into a browser source and
 * checks character by character when it does not work.
 */
const MONOSPACE = Platform.select({
  ios: 'Menlo',
  default: 'monospace'
})

const getStyles = cacheStyles((theme: Theme) => ({
  options: {
    width: '100%',
    gap: theme.rem(theme.spaceMdRem)
  },
  centre: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.backgroundColor,
    padding: theme.rem(1)
  },
  messageHeading: {
    color: theme.primaryTextColor,
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1.25),
    fontWeight: '600',
    textAlign: 'center'
  },
  message: {
    color: theme.secondaryTextColor,
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(1),
    maxWidth: theme.rem(22),
    padding: theme.rem(0.75),
    textAlign: 'center'
  },
  section: {
    gap: theme.rem(theme.spaceSmRem)
  },
  header: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.9375),
    fontWeight: '600',
    color: theme.primaryTextColor
  },
  reason: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.8125),
    color: theme.secondaryTextColor
  },
  linkCard: {
    gap: theme.rem(theme.spaceSmRem),
    padding: theme.rem(theme.spaceMdRem)
  },
  linkHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.rem(theme.spaceSmRem)
  },
  linkTitle: {
    flex: 1
  },
  link: {
    fontFamily: MONOSPACE,
    fontSize: theme.rem(0.8125),
    lineHeight: theme.rem(1.125),
    minHeight: theme.rem(1.125) * 2 + theme.rem(theme.spaceSmRem) * 2,
    color: theme.primaryTextColor,
    backgroundColor: theme.inactiveBackgroundColor,
    borderRadius: theme.rem(theme.radiusRem),
    padding: theme.rem(theme.spaceSmRem)
  },
  pressed: {
    opacity: 0.6
  },
  copied: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.8125),
    fontWeight: '600',
    color: theme.successColor
  }
}))
