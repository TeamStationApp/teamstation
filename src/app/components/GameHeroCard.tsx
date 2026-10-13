import React from 'react'
import { Pressable, Text, View } from 'react-native'

import { elevationFor } from '../theme/elevation'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { Emblem } from './Emblem'
import { LivePill } from './LivePill'
import { teamInitialsOf, teamTint } from './teamTile'
import { useBreakpoint } from './useBreakpoint'
import { VideoPoster } from './VideoPoster'

export interface GameHeroCardProps {
  testID?: string
  awayName: string
  homeName: string
  awayScore: number | null
  homeScore: number | null
  /** `FINAL`, `TOP 3RD`, `SAT 10:00 AM`. */
  status: string
  pendingApproval?: boolean
  /**
   * The game is being played now. Its status is then the red `live` pill,
   * top right on the date's line, rather than a chip or a word between the
   * two teams.
   */
  live?: boolean
  winner?: 'away' | 'home'
  /** A frame of the game's video. Absent until one has been cut. */
  posterUrl?: string | null
  /**
   * Play the game in the card, silently, instead of showing a still.
   *
   * The score, the two teams and `FINAL` stay drawn over it, and the frame
   * clips it to the card's corners, so the card looks the same — it just
   * moves.
   *
   * There is no play button on this card. It plays by itself, so a button
   * offering to start it would be describing something that already happened;
   * sound is what `Watch Replay` underneath is for.
   */
  videoUrl?: string | null
  /**
   * Draw the score plainly instead of over a picture.
   *
   * The game screen has the video itself a few pixels below, and a 16:9 frame
   * above a 16:9 player is two large pictures of the same game with the thing
   * you came for pushed off the bottom of the window.
   */
  compact?: boolean
  /**
   * What each side did, counted from the plays.
   *
   * Not the runs: the score is a few lines up in numerals twice this size, so
   * a card that repeats it has spent a line saying nothing. Null on a side
   * means the plays were never counted, which is not the same as none — that
   * side gets no line rather than a row of zeroes.
   */
  teamStats?: {
    away: TeamStatLine | null
    home: TeamStatLine | null
  } | null
  /** `WED, MAY 13`, on its own line above the ground. */
  date?: string
  dateNumberOfLines?: number
  dateLines?: readonly [string, string]
  /** `VALE FIELD`, under the date, where we know it. */
  venue?: string
  /** `12–3`, under each team's name. */
  awayRecord?: string | null
  homeRecord?: string | null
  /** Each side's mark, beside its name. */
  awayLogoUrl?: string | null
  homeLogoUrl?: string | null
  /**
   * Each side's team, which picks the colour of its tile where it has no
   * logo. The name picks it where there is no id.
   */
  awayTeamId?: string
  homeTeamId?: string
  /**
   * Opens a side's team, from its name and its mark.
   *
   * Nothing is drawn to say so — no colour, no chevron, no underline. Paul
   * asked for it to be there without announcing itself, so the card reads
   * exactly as it did and the two names happen to answer a tap. Left out for
   * a side that has no page to open, an opponent from outside the season
   * being the usual one, and then its name is simply a name.
   */
  onOpenAwayTeam?: () => void
  onOpenHomeTeam?: () => void
}

/**
 * The card that stands for a game: its own picture, with the score on it.
 *
 * One component in both places it appears — the recent game on the home
 * screen and the top of a game — because they are the same card. What differs
 * is only what sits under it, which is the caller's business.
 *
 * A game that was never filmed keeps the dark panel. That is not a fallback
 * but a designed state: plenty of games are scored and never recorded, and a
 * panel says the score plainly where an empty grey rectangle would say
 * nothing at all.
 */
/** One side's half of the card's stat block. */
export interface TeamStatLine {
  h: number
  bb: number
  /** This side's batters who struck out. */
  k: number
  hr: number
  e: number
  /** The strikeouts this side's pitching earned — the other side's `k`. */
  kDef: number
}

export function GameHeroCard(props: GameHeroCardProps): React.ReactElement {
  const {
    awayName,
    homeName,
    awayScore: providedAwayScore,
    homeScore: providedHomeScore,
    status: providedStatus,
    pendingApproval = false,
    live: providedLive = false,
    winner: providedWinner,
    posterUrl,
    videoUrl,
    compact = false,
    teamStats,
    date,
    dateNumberOfLines = 1,
    dateLines,
    venue,
    awayRecord,
    homeRecord,
    awayLogoUrl,
    homeLogoUrl,
    awayTeamId,
    homeTeamId,
    onOpenAwayTeam,
    onOpenHomeTeam
  } = props
  const awayScore = pendingApproval ? null : providedAwayScore
  const homeScore = pendingApproval ? null : providedHomeScore
  const status = pendingApproval ? 'Pending approval' : providedStatus
  const live = !pendingApproval && providedLive
  const winner = pendingApproval ? undefined : providedWinner
  const styles = getStyles(useTheme())
  const narrow = useBreakpoint() === 'phone'
  const hasMeta =
    dateLines != null ||
    (date != null && date !== '') ||
    (venue != null && venue !== '')

  const line =
    teamStats == null ||
    (teamStats.away == null && teamStats.home == null) ? null : (
      <View style={styles.line}>
        <StatLines name={awayName} stats={teamStats.away} />
        <StatLines name={homeName} stats={teamStats.home} />
      </View>
    )

  if (compact || posterUrl == null || posterUrl === '') {
    // A light card, not the dark panel: the panel was drawn for a screen with
    // nothing else on it, and against a pale background it reads as a hole.
    return (
      <View testID={props.testID} style={styles.card}>
        {hasMeta && (
          <View style={styles.meta}>
            {/*
              The date on its own line above the ground, rather than the two
              run together with a dot between them: a long field name on a
              phone truncated the date off the end of the line, which is the
              half somebody is actually looking for.
            */}
            <View style={styles.metaLines}>
              {dateLines != null
                ? dateLines.map((line, index) => (
                    <Text
                      key={index}
                      testID={
                        index === 0 ? 'event-hero-date' : 'event-hero-time'
                      }
                      style={styles.eventDate}
                    >
                      {line}
                    </Text>
                  ))
                : date != null &&
                  date !== '' && (
                    <Text
                      style={styles.metaText}
                      numberOfLines={dateNumberOfLines}
                    >
                      {date.toUpperCase()}
                    </Text>
                  )}
              {venue != null && venue !== '' && (
                <Text style={styles.metaVenue} numberOfLines={1}>
                  {venue.toUpperCase()}
                </Text>
              )}
            </View>
            {live ? (
              <LivePill inline />
            ) : status !== '' ? (
              <View style={styles.statusChip}>
                <Text style={styles.statusChipText}>{status}</Text>
              </View>
            ) : null}
          </View>
        )}
        <View style={[styles.plain, narrow && styles.plainStacked]}>
          <ScoreLine
            name={awayName}
            score={awayScore}
            record={awayRecord}
            logoUrl={awayLogoUrl}
            teamId={awayTeamId}
            note="Away"
            won={winner === 'away'}
            stacked={narrow}
            onPress={onOpenAwayTeam}
          />
          {!hasMeta && <Text style={styles.plainStatus}>{status}</Text>}
          <ScoreLine
            name={homeName}
            score={homeScore}
            record={homeRecord}
            logoUrl={homeLogoUrl}
            teamId={homeTeamId}
            note="Home"
            won={winner === 'home'}
            alignEnd={!narrow}
            stacked={narrow}
            onPress={onOpenHomeTeam}
          />
        </View>
        {line}
      </View>
    )
  }

  return (
    <View testID={props.testID} style={styles.card}>
      <VideoPoster uri={posterUrl} videoUrl={videoUrl} size="hero">
        <View style={styles.over}>
          <Text style={styles.team} numberOfLines={1}>
            {`${awayName} ${awayScore ?? ''}`.trim()}
          </Text>
          <Text style={styles.team} numberOfLines={1}>
            {`${homeName} ${homeScore ?? ''}`.trim()}
          </Text>
          {!pendingApproval && <Text style={styles.status}>{status}</Text>}
        </View>
      </VideoPoster>
      {pendingApproval && (
        <View style={[styles.statusChip, styles.pendingOverlay]}>
          <Text style={styles.statusChipText}>{status}</Text>
        </View>
      )}
      {line}
    </View>
  )
}

/**
 * `Hawks  4R · 7H · 1E`, leaving out what the plays cannot say.
 *
 * A game with only a final score on it has no hits *recorded*, which is not
 * the same as no hits. Printing `0H` there would be a claim about the game
 * rather than about our records.
 */
/**
 * One side, in two lines: what it did at the plate, then what it did in the
 * field.
 *
 * `Def:` names the second line because the two carry the same letter for
 * different things — a side's own batters who struck out, and the strikeouts
 * its pitching earned. Without the label they read as a contradiction.
 */
function StatLines(props: {
  name: string
  stats: TeamStatLine | null
}): React.ReactElement | null {
  const { name, stats } = props
  const styles = getStyles(useTheme())
  if (stats == null) return null
  // One line, not two: batting, then what the same side did in the field. A
  // second line per side made the card half as tall again for four numbers.
  const batting = [
    `${stats.h} H`,
    `${stats.bb} BB`,
    `${stats.k} K`,
    `${stats.hr} HR`
  ].join(' · ')
  return (
    <View style={styles.statLine}>
      <Text style={styles.statName} numberOfLines={1}>
        {name}
      </Text>
      <Text style={styles.statValues} numberOfLines={1}>
        {batting}
        {' · '}
        <Text style={styles.statLabel}>Def:</Text>
        {` ${stats.e} E · ${stats.kDef} K`}
      </Text>
    </View>
  )
}

function ScoreLine(props: {
  name: string
  score: number | null
  record?: string | null
  logoUrl?: string | null
  /** Picks the tile's colour where there is no logo. */
  teamId?: string
  note: string
  won: boolean
  alignEnd?: boolean
  /** One side per line rather than two across, on a phone. */
  stacked?: boolean
  /** Opens this side's team. Absent where there is no page to open. */
  onPress?: () => void
}): React.ReactElement {
  const {
    name,
    score,
    record,
    logoUrl,
    teamId,
    note,
    won,
    alignEnd = false,
    stacked = false,
    onPress
  } = props
  const styles = getStyles(useTheme())
  // Every side has a mark: its logo, or a tile of its initials in a colour of
  // its own where it has none, or where the logo will not load. With a mark
  // on one side only, the two names started at different places.
  //
  // Wrapped rather than the whole row made pressable: the row is laid out two
  // ways — the mark beside the name across the card, and the mark beside a
  // *column* holding the name and the record on a phone — so a press put
  // around the row would take in the record on one of them and not the other.
  // The mark and the name are the two things Paul named, and they are the two
  // things wrapped, in both.
  const emblem = (
    <Emblem
      uri={logoUrl}
      fallback={teamInitialsOf(name)}
      tint={teamTint(teamId ?? name)}
      size={2}
    />
  )
  const mark =
    onPress == null ? (
      emblem
    ) : (
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={name}
        onPress={onPress}
        style={styles.markPress}
      >
        {emblem}
      </Pressable>
    )
  /**
   * `Text`'s own `onPress`, not a `Pressable` around it.
   *
   * The name shrinks and truncates to one line inside a row that is measured
   * to the pixel; a wrapper is another box for the browser to size and the
   * ellipsis moved with it. `onPress` on the text itself changes no layout at
   * all, which on a card this tight is the whole point.
   */
  const nameText = (
    <Text
      style={styles.sideName}
      numberOfLines={1}
      onPress={onPress}
      accessibilityRole={onPress == null ? undefined : 'link'}
    >
      {name}
      {won ? ' ★' : ''}
    </Text>
  )

  // Stacked — a phone — each side is one line: the name at the left margin and
  // the score hard against the right, which is how a score is read.
  if (stacked) {
    return (
      <View style={styles.sideStacked}>
        {mark}
        <View style={styles.sideRowText}>
          {nameText}
          <Text style={styles.sideNote} numberOfLines={1}>
            {record == null || record === '' ? note : `${note} · ${record}`}
          </Text>
        </View>
        <Text
          style={[
            styles.sideScore,
            styles.sideScoreStacked,
            won && styles.sideScoreWon
          ]}
        >
          {score ?? '–'}
        </Text>
      </View>
    )
  }

  // Side by side — the two teams face each other across the card, so each is a
  // column: the mark and the name, the score under them, and the record last.
  return (
    <View style={[styles.side, alignEnd && styles.sideEnd]}>
      <View style={[styles.sideNameRow, alignEnd && styles.sideNameRowEnd]}>
        {mark}
        {nameText}
      </View>
      <Text style={[styles.sideScore, won && styles.sideScoreWon]}>
        {score ?? '–'}
      </Text>
      <Text style={styles.sideNote} numberOfLines={1}>
        {record == null || record === '' ? note : `${note} · ${record}`}
      </Text>
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  card: {
    backgroundColor: theme.cardBackgroundColor,
    borderRadius: theme.rem(theme.radiusRem),
    borderWidth: 1,
    borderColor: theme.defaultBorderColor,
    overflow: 'hidden',
    // Heavier than an ordinary card's. This one is the thing the screen is
    // about, and on the game screen the list passes underneath it — a shadow
    // is what says *underneath* rather than *cut off*.
    shadowColor: theme.shadowColor,
    shadowOpacity: 1,
    shadowRadius: theme.rem(0.75),
    shadowOffset: { width: 0, height: theme.rem(0.25) },
    elevation: elevationFor(theme.rem(0.75))
  },
  over: {
    gap: theme.rem(0.0625)
  },
  team: {
    color: '#ffffff',
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1.0625),
    fontWeight: '700'
  },
  status: {
    color: '#ffffff',
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.75),
    letterSpacing: theme.rem(0.04),
    opacity: 0.85
  },
  meta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.rem(theme.spaceSmRem),
    paddingHorizontal: theme.rem(theme.cardContentInsetRem),
    paddingTop: theme.rem(theme.cardContentInsetRem)
  },
  metaText: {
    flexShrink: 1,
    color: theme.secondaryTextColor,
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.6875),
    fontWeight: '700',
    letterSpacing: theme.rem(0.0625)
  },
  eventDate: {
    color: '#000000',
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.6875 * 1.25),
    lineHeight: theme.rem(0.6875 * 1.25 * 1.4),
    fontWeight: '700'
  },
  statusChip: {
    backgroundColor: theme.containerBackgroundColor,
    borderRadius: theme.radiusPill,
    paddingHorizontal: theme.rem(theme.spaceSmRem),
    paddingVertical: theme.rem(0.125)
  },
  pendingOverlay: {
    position: 'absolute',
    top: theme.rem(theme.spaceSmRem),
    right: theme.rem(theme.spaceSmRem),
    zIndex: 2
  },
  statusChipText: {
    color: theme.activeColor,
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.6875),
    fontWeight: '700',
    letterSpacing: theme.rem(0.04)
  },
  // Two sides across a 390px phone left `Lake Mu…` against `Badgers (…` —
  // both names cut, and the full ones legible in the line score directly
  // below. Stacked they each get the whole width, away over home, which is
  // the order every other list on the screen uses.
  plainStacked: {
    flexDirection: 'column',
    alignItems: 'stretch',
    gap: theme.rem(theme.spaceSmRem)
  },
  plain: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(theme.spaceMdRem),
    paddingHorizontal: theme.rem(theme.cardContentInsetRem),
    paddingVertical: theme.rem(theme.cardContentInsetRem)
  },
  sideText: {
    flexShrink: 1,
    gap: theme.rem(0.0625)
  },
  sideTextEnd: {
    alignItems: 'flex-end'
  },
  sideNote: {
    color: theme.secondaryTextColor,
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.75)
  },
  sideScoreWon: {
    color: theme.activeColor
  },
  plainStatus: {
    color: theme.secondaryTextColor,
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.75),
    letterSpacing: theme.rem(0.04)
  },
  // Across the card: the two sides share its width, each a column of the
  // mark and the name, the score, and the record.
  side: {
    flex: 1,
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: theme.rem(0.125)
  },
  sideEnd: {
    alignItems: 'flex-end'
  },
  // The mark is a fixed square and must stay one: a press around it inherits
  // the row's shrinking otherwise and the circle goes oval on a long name.
  markPress: {
    flexShrink: 0
  },
  sideNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(theme.spaceXsRem)
  },
  sideNameRowEnd: {
    flexDirection: 'row-reverse'
  },
  // Stacked, one side per line, and a style of its own rather than `side`
  // with overrides. `flex: 1` is a basis of 0, and React Native keeps that
  // basis even under a later `flexBasis: 'auto'`, which it reads as unset.
  // In the column of two sides that left each row 0 tall, clipped by the
  // card: the phone showed the date and half a logo, and nothing else. A
  // browser takes the override, so the web never showed it.
  sideStacked: {
    alignSelf: 'stretch',
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(theme.spaceSmRem)
  },
  // The name takes what the mark and the score leave, against the row's
  // definite width, and truncates.
  sideRowText: {
    flex: 1
  },
  sideScoreStacked: {
    flexShrink: 0
  },

  sideName: {
    color: theme.primaryTextColor,
    flexShrink: 1,
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1),
    fontWeight: '600'
  },
  sideScore: {
    color: theme.primaryTextColor,
    fontFamily: theme.boldTextFont,
    fontSize: theme.rem(2),
    lineHeight: theme.rem(2.25),
    fontWeight: '700'
  },
  line: {
    borderTopWidth: 1,
    borderTopColor: theme.defaultBorderColor,
    paddingHorizontal: theme.rem(theme.cardContentInsetRem),
    paddingVertical: theme.rem(theme.cardContentInsetRem),
    gap: theme.rem(0.125)
  },
  lineText: {
    color: theme.secondaryTextColor,
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.8125)
  },
  statLine: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.rem(theme.spaceSmRem)
  },
  statName: {
    // The numbers are the point of the line; the name is there to say which
    // side they belong to and gives way first.
    flexShrink: 1,
    maxWidth: '40%',
    color: theme.primaryTextColor,
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.8125),
    fontWeight: '600'
  },
  statValues: {
    flexGrow: 1,
    flexShrink: 0,
    textAlign: 'right',
    color: theme.secondaryTextColor,
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.8125)
  },
  statLabel: {
    color: theme.secondaryTextColor,
    fontFamily: theme.semiBoldTextFont,
    fontWeight: '700'
  },
  metaLines: {
    flexShrink: 1
  },
  metaVenue: {
    color: theme.secondaryTextColor,
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.6875),
    letterSpacing: theme.rem(0.04)
  }
}))
