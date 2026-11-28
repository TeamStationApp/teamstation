import React, { useEffect, useMemo, useState } from 'react'
import {
  ActivityIndicator,
  type LayoutChangeEvent,
  Pressable,
  StyleSheet,
  Text,
  View
} from 'react-native'

import type { GameDetail, TeamStationClient } from '../../common/api'
import type { GameSocket } from '../../common/gameSocket'
import { Button } from '../components/Button'
import { Icon } from '../components/Icon'
import { PersonEmblem } from '../components/PersonEmblem'
import { lstrings, sprintf } from '../locales/strings'
import { MembershipAccess } from '../screens/MembershipAccess'
import { cacheStyles, useTheme } from '../theme/ThemeContext'
import type { Theme } from '../theme/types'
import {
  type HalfInning,
  type HalfSummary,
  type PlayLine,
  type PlayRow,
  playsStream
} from './playsStream'
import { usePlays } from './usePlays'

export interface PlaysTabProps {
  client: TeamStationClient
  game: Pick<
    GameDetail,
    | 'id'
    | 'status'
    | 'nonMemberView'
    | 'homeTeamId'
    | 'awayTeamId'
    | 'homeTeamName'
    | 'awayTeamName'
  >
  /** null while the session is still being restored. */
  signedIn: boolean | null
  onSignIn: () => void
  /** The stream's layout, which changes as lines are added or opened. */
  onLayout?: (event: LayoutChangeEvent) => void
  /** The game socket, to follow the plays as they are scored. */
  socket?: Pick<GameSocket, 'subscribe'>
}

/**
 * A game's Plays tab: one column of its at-bats, oldest first, grouped by
 * half-inning with a summary line closing each half that has ended. Each line
 * opens into the pitches of its at-bat; the at-bat in progress is always
 * open. On a game being scored the plays follow the game socket.
 *
 * A viewer who may not read the plays — signed out, or a member of neither
 * team — is shown how to become a member instead, and nothing is asked for.
 */
export function PlaysTab(props: PlaysTabProps): React.ReactElement {
  const { client, game, signedIn } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const mayRead = signedIn === true && !game.nonMemberView
  const { read, retry } = usePlays({
    client,
    gameId: game.id,
    enabled: mayRead,
    socket: props.socket
  })
  const photos = useRosterPhotos(
    client,
    [game.awayTeamId, game.homeTeamId],
    mayRead
  )
  const [open, setOpen] = useState<ReadonlySet<number>>(() => new Set())
  const halves = useMemo(
    () =>
      read.state === 'ready'
        ? playsStream({
            plays: read.plays,
            currentPlay: read.currentPlay,
            away: { name: game.awayTeamName },
            home: { name: game.homeTeamName },
            final: game.status === 'final'
          })
        : [],
    [read, game.awayTeamName, game.homeTeamName, game.status]
  )

  if (signedIn === null)
    return (
      <View style={styles.centre}>
        <ActivityIndicator
          accessibilityLabel="Loading session"
          color={theme.primaryTextColor}
        />
      </View>
    )
  if (!mayRead)
    return (
      <View style={styles.column} testID="plays-members-only">
        <MembershipAccess
          key={`${game.id}:${signedIn}`}
          client={client}
          signedIn={signedIn}
          resource="plays"
          teams={[
            { id: game.homeTeamId, name: game.homeTeamName },
            { id: game.awayTeamId, name: game.awayTeamName }
          ]}
          onSignIn={props.onSignIn}
        />
      </View>
    )
  if (read.state === 'loading')
    return (
      <View style={styles.centre} testID="plays-loading">
        <ActivityIndicator
          accessibilityLabel="Loading plays"
          color={theme.primaryTextColor}
        />
      </View>
    )
  if (read.state === 'failed')
    return (
      <View style={[styles.column, styles.failed]} testID="plays-failed">
        <Text accessibilityRole="alert" style={styles.failedText}>
          {lstrings.plays_unavailable}
        </Text>
        <Button
          label={lstrings.plays_retry}
          onPress={retry}
          style={{ alignSelf: 'center' }}
        />
      </View>
    )

  const toggle = (atBatIndex: number): void => {
    setOpen(current => {
      const next = new Set(current)
      if (next.has(atBatIndex)) next.delete(atBatIndex)
      else next.add(atBatIndex)
      return next
    })
  }
  return (
    <View style={styles.column} testID="plays-stream" onLayout={props.onLayout}>
      {halves.map(half => (
        <Half
          key={half.key}
          half={half}
          open={open}
          photos={photos}
          onToggle={toggle}
          styles={styles}
          theme={theme}
        />
      ))}
    </View>
  )
}

/** A batter as the rosters know them: their account and their picture. */
interface RosterFace {
  userId: string
  avatarUrl: string | null
}

/** Gumbo id → account and picture, from both teams' rosters; a refused read gives none. */
function useRosterPhotos(
  client: Pick<TeamStationClient, 'roster'>,
  teamIds: string[],
  enabled: boolean
): ReadonlyMap<number, RosterFace> {
  const [photos, setPhotos] = useState<ReadonlyMap<number, RosterFace>>(
    () => new Map()
  )
  const key = teamIds.join(',')
  useEffect(() => {
    if (!enabled) return
    let live = true
    Promise.all(
      key.split(',').map(async teamId => {
        try {
          return await client.roster(teamId)
        } catch {
          return []
        }
      })
    )
      .then(rosters => {
        if (!live) return
        const next = new Map<number, RosterFace>()
        for (const entry of rosters.flat())
          if (entry.gumboId != null)
            next.set(entry.gumboId, {
              userId: entry.userId,
              avatarUrl: entry.avatarUrl
            })
        setPhotos(next)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [client, key, enabled])
  return photos
}

type Styles = ReturnType<typeof getStyles>

function Half(props: {
  half: HalfInning
  open: ReadonlySet<number>
  photos: ReadonlyMap<number, RosterFace>
  onToggle: (atBatIndex: number) => void
  styles: Styles
  theme: Theme
}): React.ReactElement {
  const { half, styles } = props
  return (
    <View style={styles.half} testID={`plays-half-${half.key}`}>
      <View style={styles.halfHeader} accessibilityRole="header">
        <Text style={styles.halfLabel}>{half.label}</Text>
        <Text style={styles.halfTeam} numberOfLines={1}>
          {half.battingTeam}
        </Text>
      </View>
      {half.lines.map(line => (
        <Line
          key={line.atBatIndex}
          line={line}
          // The at-bat in progress shows its pitches as they come; once
          // stored it is an ordinary line, shut unless the viewer opened it.
          open={
            line.inProgress ||
            (line.expandable && props.open.has(line.atBatIndex))
          }
          face={
            line.batter.gumboId == null
              ? undefined
              : props.photos.get(line.batter.gumboId)
          }
          onToggle={props.onToggle}
          styles={styles}
          theme={props.theme}
        />
      ))}
      {half.summary != null && (
        <Text style={styles.summary} testID={`plays-summary-${half.key}`}>
          {summaryText(half.summary)}
        </Text>
      )}
    </View>
  )
}

/** `Runs: 1, Hits: 2, Errors: 0, Left on base: 1`, leaving out what is unknown. */
export function summaryText(summary: HalfSummary): string {
  const parts: string[] = []
  if (summary.runs != null)
    parts.push(sprintf(lstrings.plays_half_runs, summary.runs))
  if (summary.hits != null)
    parts.push(sprintf(lstrings.plays_half_hits, summary.hits))
  if (summary.errors != null)
    parts.push(sprintf(lstrings.plays_half_errors, summary.errors))
  if (summary.leftOnBase != null)
    parts.push(sprintf(lstrings.plays_half_left_on_base, summary.leftOnBase))
  return parts.join(lstrings.plays_half_joiner)
}

function Line(props: {
  line: PlayLine
  open: boolean
  face: RosterFace | undefined
  onToggle: (atBatIndex: number) => void
  styles: Styles
  theme: Theme
}): React.ReactElement {
  const { line, open, styles, theme } = props
  const outs =
    line.outs == null
      ? null
      : sprintf(
          line.outs === 1 ? lstrings.plays_outs_one : lstrings.plays_outs_other,
          line.outs
        )
  const meta = [
    outs,
    line.pitcher == null ? null : sprintf(lstrings.plays_pitcher, line.pitcher)
  ]
    .filter(part => part != null)
    .join(' · ')
  const body = (
    <View style={styles.lineRow}>
      <PersonEmblem
        // A batter the rosters do not know is the theme's untinted tile.
        userId={props.face?.userId ?? ''}
        name={line.batter.name}
        size={2}
        uri={props.face?.avatarUrl}
      />
      <View style={styles.lineText}>
        <Text style={styles.sentence}>{line.sentence}</Text>
        {meta !== '' && <Text style={styles.meta}>{meta}</Text>}
        {line.score != null && (
          <View style={styles.scoreRow} testID="plays-scoring">
            <View
              accessible
              accessibilityLabel={lstrings.plays_scoring}
              style={styles.scoreMarker}
            />
            <Text style={styles.score}>{line.score}</Text>
          </View>
        )}
      </View>
      {line.expandable && !line.inProgress && (
        <View style={open ? styles.chevronOpen : undefined}>
          <Icon
            name="chevron_right"
            size={1.25}
            color={theme.secondaryTextColor}
          />
        </View>
      )}
    </View>
  )
  return (
    <View style={styles.line} testID={`plays-line-${line.atBatIndex}`}>
      {line.expandable && !line.inProgress ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          aria-expanded={open}
          onPress={() => {
            props.onToggle(line.atBatIndex)
          }}
        >
          {body}
        </Pressable>
      ) : (
        body
      )}
      {open && line.rows.length > 0 && (
        <View style={styles.rows} testID={`plays-rows-${line.atBatIndex}`}>
          {line.rows.map((row, index) => (
            <Row key={index} row={row} styles={styles} />
          ))}
        </View>
      )}
    </View>
  )
}

function Row(props: { row: PlayRow; styles: Styles }): React.ReactElement {
  const { row, styles } = props
  if (row.kind === 'event')
    return <Text style={styles.eventRow}>{row.description}</Text>
  const details = [
    `${row.balls}-${row.strikes}`,
    row.speed == null
      ? null
      : sprintf(lstrings.plays_pitch_speed, Math.round(row.speed)),
    row.pitchType ?? null,
    row.exitVelocity == null
      ? null
      : sprintf(lstrings.plays_exit_velocity, Math.round(row.exitVelocity))
  ]
    .filter(part => part != null)
    .join(' · ')
  return (
    <View style={styles.pitchRow} testID="plays-pitch">
      <Text style={styles.pitchNumber}>{row.pitchNumber}</Text>
      <View style={styles.pitchText}>
        <Text style={styles.pitchCall}>{row.call}</Text>
        <Text style={styles.meta}>{details}</Text>
      </View>
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) =>
  StyleSheet.create({
    centre: {
      alignItems: 'center',
      justifyContent: 'center',
      padding: theme.rem(1)
    },
    // One column at every width, centred at reading width.
    column: {
      width: '100%',
      maxWidth: theme.rem(theme.maxContentWidthRem),
      alignSelf: 'center',
      gap: theme.rem(theme.spaceMdRem),
      paddingBottom: theme.rem(1)
    },
    failed: { padding: theme.rem(1), alignItems: 'center' },
    failedText: {
      color: theme.primaryTextColor,
      fontFamily: theme.semiBoldTextFont,
      fontSize: theme.rem(1),
      textAlign: 'center'
    },
    half: {
      borderWidth: 1,
      borderColor: theme.defaultBorderColor,
      borderRadius: theme.rem(theme.radiusRem),
      backgroundColor: theme.cardBackgroundColor,
      overflow: 'hidden'
    },
    halfHeader: {
      flexDirection: 'row',
      alignItems: 'baseline',
      gap: theme.rem(0.5),
      paddingHorizontal: theme.rem(0.75),
      paddingVertical: theme.rem(0.5),
      borderBottomWidth: 1,
      borderBottomColor: theme.defaultBorderColor
    },
    halfLabel: {
      color: theme.primaryTextColor,
      fontFamily: theme.boldTextFont,
      fontSize: theme.rem(1)
    },
    halfTeam: {
      flex: 1,
      color: theme.secondaryTextColor,
      fontFamily: theme.regularTextFont,
      fontSize: theme.rem(0.875)
    },
    line: {
      borderBottomWidth: 1,
      borderBottomColor: theme.defaultBorderColor
    },
    lineRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.rem(0.75),
      paddingHorizontal: theme.rem(0.75),
      paddingVertical: theme.rem(0.5),
      minHeight: 48
    },
    lineText: { flex: 1, minWidth: 0, gap: theme.rem(0.125) },
    sentence: {
      color: theme.primaryTextColor,
      fontFamily: theme.regularTextFont,
      fontSize: theme.rem(0.95)
    },
    meta: {
      color: theme.secondaryTextColor,
      fontFamily: theme.regularTextFont,
      fontSize: theme.rem(0.8)
    },
    scoreRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.rem(0.375)
    },
    scoreMarker: {
      width: theme.rem(0.5),
      height: theme.rem(0.5),
      borderRadius: theme.rem(0.25),
      backgroundColor: theme.liveColor
    },
    score: {
      color: theme.primaryTextColor,
      fontFamily: theme.semiBoldTextFont,
      fontSize: theme.rem(0.8)
    },
    chevronOpen: { transform: [{ rotate: '90deg' }] },
    rows: {
      paddingLeft: theme.rem(3.5),
      paddingRight: theme.rem(0.75),
      paddingBottom: theme.rem(0.5),
      gap: theme.rem(0.25)
    },
    pitchRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: theme.rem(0.5)
    },
    pitchNumber: {
      width: theme.rem(1.25),
      color: theme.secondaryTextColor,
      fontFamily: theme.semiBoldTextFont,
      fontSize: theme.rem(0.8),
      textAlign: 'right'
    },
    pitchText: { flex: 1, minWidth: 0 },
    pitchCall: {
      color: theme.primaryTextColor,
      fontFamily: theme.regularTextFont,
      fontSize: theme.rem(0.85)
    },
    eventRow: {
      color: theme.secondaryTextColor,
      fontFamily: theme.regularTextFont,
      fontStyle: 'italic',
      fontSize: theme.rem(0.8),
      paddingLeft: theme.rem(1.75)
    },
    summary: {
      color: theme.secondaryTextColor,
      fontFamily: theme.semiBoldTextFont,
      fontSize: theme.rem(0.8),
      paddingHorizontal: theme.rem(0.75),
      paddingVertical: theme.rem(0.5)
    }
  })
)
