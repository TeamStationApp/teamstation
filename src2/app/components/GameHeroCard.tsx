import React from 'react'
import { Text, View } from 'react-native'

import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { Emblem } from './Emblem'
import { initialsOf } from './initials'
import { useBreakpoint } from './useBreakpoint'
import { VideoPoster } from './VideoPoster'

export interface GameHeroCardProps {
  awayName: string
  homeName: string
  awayScore: number | null
  homeScore: number | null
  /** `FINAL`, `TOP 3RD`, `SAT 10:00 AM`. */
  status: string
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
  /** `VALE FIELD`, under the date, where we know it. */
  venue?: string
  /** `12–3`, under each team's name. */
  awayRecord?: string | null
  homeRecord?: string | null
  /** Each side's mark, beside its name. */
  awayLogoUrl?: string | null
  homeLogoUrl?: string | null
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
    awayScore,
    homeScore,
    status,
    winner,
    posterUrl,
    videoUrl,
    compact = false,
    teamStats,
    date,
    venue,
    awayRecord,
    homeRecord,
    awayLogoUrl,
    homeLogoUrl
  } = props
  const styles = getStyles(useTheme())
  const narrow = useBreakpoint() === 'phone'
  const hasMeta =
    (date != null && date !== '') || (venue != null && venue !== '')

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
      <View style={styles.card}>
        {hasMeta && (
          <View style={styles.meta}>
            {/*
              The date on its own line above the ground, rather than the two
              run together with a dot between them: a long field name on a
              phone truncated the date off the end of the line, which is the
              half somebody is actually looking for.
            */}
            <View style={styles.metaLines}>
              {date != null && date !== '' && (
                <Text style={styles.metaText} numberOfLines={1}>
                  {date.toUpperCase()}
                </Text>
              )}
              {venue != null && venue !== '' && (
                <Text style={styles.metaVenue} numberOfLines={1}>
                  {venue.toUpperCase()}
                </Text>
              )}
            </View>
            <View style={styles.statusChip}>
              <Text style={styles.statusChipText}>{status}</Text>
            </View>
          </View>
        )}
        <View style={[styles.plain, narrow && styles.plainStacked]}>
          <ScoreLine
            name={awayName}
            score={awayScore}
            record={awayRecord}
            logoUrl={awayLogoUrl}
            note="Away"
            won={winner === 'away'}
            stacked={narrow}
          />
          {!hasMeta && <Text style={styles.plainStatus}>{status}</Text>}
          <ScoreLine
            name={homeName}
            score={homeScore}
            record={homeRecord}
            logoUrl={homeLogoUrl}
            note="Home"
            won={winner === 'home'}
            alignEnd={!narrow}
            stacked={narrow}
          />
        </View>
        {line}
      </View>
    )
  }

  return (
    <View style={styles.card}>
      <VideoPoster uri={posterUrl} videoUrl={videoUrl} size="hero">
        <View style={styles.over}>
          <Text style={styles.team} numberOfLines={1}>
            {`${awayName} ${awayScore ?? ''}`.trim()}
          </Text>
          <Text style={styles.team} numberOfLines={1}>
            {`${homeName} ${homeScore ?? ''}`.trim()}
          </Text>
          <Text style={styles.status}>{status}</Text>
        </View>
      </VideoPoster>
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
  note: string
  won: boolean
  alignEnd?: boolean
  /** One side per line rather than two across, on a phone. */
  stacked?: boolean
}): React.ReactElement {
  const {
    name,
    score,
    record,
    logoUrl,
    note,
    won,
    alignEnd = false,
    stacked = false
  } = props
  const styles = getStyles(useTheme())
  // Only where there is a picture. A circle of initials beside a name that is
  // written out in full next to it says the same thing twice, in the place a
  // photograph would have gone.
  const mark =
    logoUrl == null || logoUrl === '' ? null : (
      <Emblem uri={logoUrl} fallback={initialsOf(name)} size={2} />
    )

  // Stacked — a phone — each side is one line: the name at the left margin and
  // the score hard against the right, which is how a score is read.
  if (stacked) {
    return (
      <View style={[styles.side, styles.sideStacked, styles.sideRow]}>
        {mark}
        <View style={styles.sideRowText}>
          <Text style={styles.sideName} numberOfLines={1}>
            {name}
            {won ? ' ★' : ''}
          </Text>
          <Text style={styles.sideNote} numberOfLines={1}>
            {record == null || record === '' ? note : `${note} · ${record}`}
          </Text>
        </View>
        <Text style={[styles.sideScore, won && styles.sideScoreWon]}>
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
        <Text style={styles.sideName} numberOfLines={1}>
          {name}
          {won ? ' ★' : ''}
        </Text>
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
    shadowOffset: { width: 0, height: theme.rem(0.25) }
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
    paddingHorizontal: theme.rem(theme.spaceMdRem),
    paddingTop: theme.rem(theme.spaceMdRem)
  },
  metaText: {
    flexShrink: 1,
    color: theme.secondaryTextColor,
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.6875),
    fontWeight: '700',
    letterSpacing: theme.rem(0.0625)
  },
  statusChip: {
    backgroundColor: theme.containerBackgroundColor,
    borderRadius: theme.radiusPill,
    paddingHorizontal: theme.rem(theme.spaceSmRem),
    paddingVertical: theme.rem(0.125)
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
    paddingHorizontal: theme.rem(theme.spaceMdRem),
    paddingVertical: theme.rem(theme.spaceMdRem)
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
  side: {
    flex: 1,
    // A column now: the score on top, the name and the record under it.
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: theme.rem(0.125)
  },
  sideEnd: {
    alignItems: 'flex-end'
  },
  sideNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(theme.spaceXsRem)
  },
  sideNameRowEnd: {
    flexDirection: 'row-reverse'
  },
  // `flex: 1` is flex-basis 0 as well, and in a column that measures the
  // *height*: the side would collapse to the height of the score and the name
  // would overflow it. Stacked, each side is simply as tall as it is.
  sideRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(theme.spaceSmRem)
  },
  sideRowText: {
    flexShrink: 1,
    flexGrow: 1
  },
  sideStacked: {
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: 'auto'
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
    paddingHorizontal: theme.rem(theme.spaceMdRem),
    paddingVertical: theme.rem(theme.spaceSmRem),
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
