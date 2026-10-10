import React from 'react'
import { Pressable, Switch, Text, View } from 'react-native'

import type { PublicGroup } from '../../common/publicGroups'
import { seasonPeriodLabel } from '../../common/seasonTimeFrames'
import { Emblem, initialsOf, SectionHeader } from '../components'
import { RadioMark } from '../components/RadioMark'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

export interface ParentChoice {
  leagueId?: string
  seasonIds: string[]
}

/**
 * Whether a season can join the seasons and league already chosen. A team's
 * parent seasons must all sit in one league, and in the chosen league when
 * there is one; a season with no league can only be a team's only one.
 */
export function seasonAllowed(
  season: PublicGroup,
  choice: ParentChoice,
  seasons: PublicGroup[]
): boolean {
  if (choice.leagueId != null) return season.leagueId === choice.leagueId
  const chosen = seasons.filter(
    other => choice.seasonIds.includes(other.id) && other.id !== season.id
  )
  if (chosen.length === 0) return true
  return (
    season.leagueId != null &&
    chosen.every(other => other.leagueId === season.leagueId)
  )
}

/**
 * The last step of creating a team (or a season) for somebody who already
 * administers a league or a season: which of those take it in. One league,
 * by radio; any number of seasons, by switch. Choosing nothing is fine.
 */
export function ParentChooser(props: {
  kind: 'team' | 'season'
  leagues: PublicGroup[]
  seasons: PublicGroup[]
  choice: ParentChoice
  onChange: (choice: ParentChoice) => void
}): React.ReactElement {
  const { kind, leagues, seasons, choice, onChange } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const chooseLeague = (id: string): void => {
    const leagueId = choice.leagueId === id ? undefined : id
    onChange({
      leagueId,
      // Seasons outside the newly chosen league cannot stay chosen.
      seasonIds:
        leagueId == null
          ? choice.seasonIds
          : choice.seasonIds.filter(
              seasonId =>
                seasons.find(season => season.id === seasonId)?.leagueId ===
                leagueId
            )
    })
  }
  const toggleSeason = (id: string, on: boolean): void => {
    onChange({
      ...choice,
      seasonIds: on
        ? [...choice.seasonIds, id]
        : choice.seasonIds.filter(seasonId => seasonId !== id)
    })
  }
  return (
    <View style={styles.page}>
      <Text style={styles.hint}>
        {kind === 'team'
          ? 'Optional. A league or season you choose manages this team with you. A team’s seasons all belong to one league.'
          : 'Optional. A league you choose manages this season with you.'}
      </Text>
      {leagues.length > 0 && (
        <View style={styles.section}>
          <SectionHeader title="Leagues" />
          {leagues.map(league => {
            const on = choice.leagueId === league.id
            return (
              <Pressable
                key={league.id}
                accessibilityRole="radio"
                accessibilityState={{ checked: on }}
                accessibilityLabel={league.name}
                onPress={() => {
                  chooseLeague(league.id)
                }}
                style={({ pressed }) => [styles.row, pressed && styles.pressed]}
              >
                <Emblem
                  uri={league.imageUrl}
                  fallback={initialsOf(league.name)}
                />
                <Text style={styles.name}>{league.name}</Text>
                <RadioMark on={on} />
              </Pressable>
            )
          })}
        </View>
      )}
      {kind === 'team' && seasons.length > 0 && (
        <View style={styles.section}>
          <SectionHeader title="Seasons" />
          {seasons.map(season => {
            const on = choice.seasonIds.includes(season.id)
            const allowed = on || seasonAllowed(season, choice, seasons)
            return (
              <Pressable
                key={season.id}
                accessibilityRole="switch"
                accessibilityState={{ checked: on, disabled: !allowed }}
                accessibilityLabel={season.name}
                disabled={!allowed}
                onPress={() => {
                  toggleSeason(season.id, !on)
                }}
                style={({ pressed }) => [
                  styles.row,
                  !allowed && styles.unavailable,
                  pressed && styles.pressed
                ]}
              >
                <Emblem
                  uri={season.imageUrl}
                  fallback={initialsOf(season.name)}
                />
                <View style={styles.text}>
                  <Text style={styles.name}>{season.name}</Text>
                  <Text style={styles.hint}>
                    {allowed
                      ? seasonPeriodLabel(season.startsOn, season.endsOn)
                      : 'In a different league from your other choices'}
                  </Text>
                </View>
                {/* The whole row is the switch; this one only shows it. */}
                <View
                  style={styles.passive}
                  accessibilityElementsHidden
                  importantForAccessibility="no-hide-descendants"
                >
                  <Switch
                    value={on}
                    disabled={!allowed}
                    trackColor={{
                      true: theme.activeColor,
                      false: theme.defaultBorderColor
                    }}
                  />
                </View>
              </Pressable>
            )
          })}
        </View>
      )}
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  page: { gap: theme.rem(1) },
  section: { gap: theme.rem(theme.spaceSmRem) },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(theme.spaceMdRem),
    padding: theme.rem(theme.spaceMdRem),
    borderRadius: theme.rem(theme.radiusRem),
    borderWidth: 1,
    borderColor: theme.defaultBorderColor,
    backgroundColor: theme.cardBackgroundColor
  },
  unavailable: { opacity: 0.5 },
  passive: { pointerEvents: 'none' },
  text: { flex: 1, gap: theme.rem(0.125) },
  name: {
    flex: 1,
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1),
    fontWeight: '600',
    color: theme.primaryTextColor
  },
  hint: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875),
    lineHeight: theme.rem(1.35),
    color: theme.secondaryTextColor
  },
  pressed: { opacity: 0.6 }
}))
