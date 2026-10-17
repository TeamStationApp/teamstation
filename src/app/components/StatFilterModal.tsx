import React, { useState } from 'react'
import { Modal, Pressable, ScrollView, Text, View } from 'react-native'

import type { PlayerStats } from '../../common/api'
import { lstrings } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { Button } from './Button'
import { CancelAction } from './CancelAction'
import { RadioMark } from './RadioMark'

/** What a player's figures are narrowed to. Everything unset is a career. */
export interface StatFilter {
  seasonId?: string
  teamId?: string
  year?: number
}

export interface StatFilterModalProps {
  /** The seasons, teams and years this player actually has figures for. */
  options: PlayerStats['options']
  filter: StatFilter
  onApply: (filter: StatFilter) => void
  onClose: () => void
}

/**
 * Which games a player's figures are added up from.
 *
 * A tall list of single choices rather than a row of controls, because the four
 * are alternatives and not settings: a career, or one season, or one team, or
 * one year. Choosing a season and a team at once would mean explaining what the
 * combination does, and nobody wants an explanation on a stats page.
 *
 * Only what this player has is offered. A season they never played in is not a
 * filter that returns nothing — it is not there.
 */
export function StatFilterModal(
  props: StatFilterModalProps
): React.ReactElement {
  const { options, filter, onApply, onClose } = props
  const styles = getStyles(useTheme())
  const [chosen, setChosen] = useState<StatFilter>(filter)

  const isCareer =
    chosen.seasonId == null && chosen.teamId == null && chosen.year == null

  const choose = (next: StatFilter): void => {
    setChosen(next)
  }

  return (
    <Modal transparent animationType="fade" visible onRequestClose={onClose}>
      <View style={styles.scrim}>
        {/* A sibling of the sheet, never its parent: a pressable inside a
            pressable is invalid on the web build. */}
        <Pressable
          style={styles.behind}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel={lstrings.player_filter_cancel}
        />
        <View style={styles.sheet}>
          <Text style={styles.title}>{lstrings.player_filter_title}</Text>

          <ScrollView
            style={styles.list}
            contentContainerStyle={styles.listBody}
          >
            <Choice
              label={lstrings.player_filter_career}
              detail={lstrings.player_filter_career_detail}
              on={isCareer}
              onPress={() => {
                choose({})
              }}
            />

            {options.seasons.length > 0 && (
              <Text style={styles.group}>
                {lstrings.player_filter_by_season}
              </Text>
            )}
            {options.seasons.map(season => (
              <Choice
                key={season.seasonId}
                label={season.name}
                detail={season.year == null ? undefined : String(season.year)}
                on={chosen.seasonId === season.seasonId}
                onPress={() => {
                  choose({ seasonId: season.seasonId })
                }}
              />
            ))}

            {options.teams.length > 0 && (
              <Text style={styles.group}>{lstrings.player_filter_by_team}</Text>
            )}
            {options.teams.map(team => (
              <Choice
                key={team.teamId}
                label={team.name}
                on={chosen.teamId === team.teamId}
                onPress={() => {
                  choose({ teamId: team.teamId })
                }}
              />
            ))}

            {options.years.length > 0 && (
              <Text style={styles.group}>{lstrings.player_filter_by_year}</Text>
            )}
            {options.years.map(year => (
              <Choice
                key={year}
                label={String(year)}
                on={chosen.year === year}
                onPress={() => {
                  choose({ year })
                }}
              />
            ))}
          </ScrollView>

          <Button
            label={lstrings.player_filter_apply}
            onPress={() => {
              onApply(chosen)
            }}
          />
          <CancelAction
            label={lstrings.player_filter_cancel}
            onPress={onClose}
          />
        </View>
      </View>
    </Modal>
  )
}

function Choice(props: {
  label: string
  detail?: string
  on: boolean
  onPress: () => void
}): React.ReactElement {
  const { label, detail, on, onPress } = props
  const styles = getStyles(useTheme())
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected: on }}
      style={[styles.choice, on && styles.choiceOn]}
      onPress={onPress}
    >
      <RadioMark on={on} />
      <View style={styles.choiceText}>
        <Text style={styles.choiceLabel}>{label}</Text>
        {detail != null && <Text style={styles.detail}>{detail}</Text>}
      </View>
    </Pressable>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  scrim: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: theme.rem(theme.spaceMdRem)
  },
  behind: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: theme.overlayBackgroundColor
  },
  sheet: {
    width: '100%',
    maxWidth: theme.rem(24),
    maxHeight: '90%',
    backgroundColor: theme.cardBackgroundColor,
    borderRadius: theme.rem(theme.radiusLargeRem),
    borderWidth: 1,
    borderColor: theme.defaultBorderColor,
    padding: theme.rem(theme.spaceMdRem),
    gap: theme.rem(theme.spaceSmRem)
  },
  title: {
    fontFamily: theme.boldTextFont,
    fontSize: theme.rem(1.125),
    fontWeight: '700',
    color: theme.primaryTextColor
  },
  list: {
    flexGrow: 0
  },
  listBody: {
    gap: theme.rem(theme.spaceSmRem)
  },
  group: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.75),
    fontWeight: '600',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: theme.secondaryTextColor,
    marginTop: theme.rem(theme.spaceSmRem)
  },
  detail: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.8125),
    color: theme.secondaryTextColor
  },
  choice: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.rem(theme.spaceSmRem),
    padding: theme.rem(theme.spaceSmRem),
    borderRadius: theme.rem(theme.radiusRem),
    borderWidth: 1,
    borderColor: theme.defaultBorderColor
  },
  choiceOn: {
    borderColor: theme.activeColor,
    backgroundColor: theme.containerBackgroundColor
  },
  choiceText: {
    flex: 1,
    gap: theme.rem(theme.spaceXsRem)
  },
  choiceLabel: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1),
    fontWeight: '600',
    color: theme.primaryTextColor
  }
}))
