import React, { useState } from 'react'
import { Modal, Pressable, Text, View } from 'react-native'

import { lstrings, sprintf } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { Button } from './Button'
import { RadioMark } from './RadioMark'

export interface RoleModalProps {
  /** Whose role is being changed. */
  displayName: string
  /** The level this page administers, which is the only one on offer. */
  scopeKind: 'league' | 'season' | 'team'
  scopeName: string
  role: 'admin' | 'member'
  busy?: boolean
  onSave: (role: 'admin' | 'member') => void
  onClose: () => void
}

/**
 * Changing what one person is at one level.
 *
 * The two choices are spelled out in full — "Team admin", "Team member", and
 * the same at the other two heights — because "admin" on its own is the word
 * that makes somebody think they have just given away the league. The page
 * they are on decides the level, and nothing here can reach another: a team's
 * page offers team roles and no others.
 */
export function RoleModal(props: RoleModalProps): React.ReactElement {
  const { displayName, scopeKind, scopeName, role, busy, onSave, onClose } =
    props
  const styles = getStyles(useTheme())
  const [chosen, setChosen] = useState<'admin' | 'member'>(role)

  const choices: Array<{
    value: 'admin' | 'member'
    label: string
    detail: string
  }> = [
    {
      value: 'admin',
      label: adminLabel(scopeKind),
      detail: sprintf(lstrings.role_admin_detail, scopeName)
    },
    {
      value: 'member',
      label: memberLabel(scopeKind),
      detail: sprintf(lstrings.role_member_detail, scopeName)
    }
  ]

  return (
    <Modal transparent animationType="fade" visible onRequestClose={onClose}>
      <View style={styles.scrim}>
        {/* A sibling of the sheet, never its parent: a pressable inside a
            pressable is invalid on the web build. */}
        <Pressable
          style={styles.behind}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel={lstrings.role_cancel}
        />
        <View style={styles.sheet}>
          <Text style={styles.title}>
            {sprintf(lstrings.role_title, displayName)}
          </Text>
          <Text style={styles.detail}>
            {sprintf(lstrings.role_scope, scopeName)}
          </Text>

          {choices.map(choice => (
            <Pressable
              key={choice.value}
              accessibilityRole="radio"
              accessibilityState={{ selected: chosen === choice.value }}
              style={[
                styles.choice,
                chosen === choice.value && styles.choiceOn
              ]}
              onPress={() => {
                setChosen(choice.value)
              }}
            >
              <RadioMark on={chosen === choice.value} />
              <View style={styles.choiceText}>
                <Text style={styles.choiceLabel}>{choice.label}</Text>
                <Text style={styles.detail}>{choice.detail}</Text>
              </View>
            </Pressable>
          ))}

          <Button
            label={lstrings.role_save}
            busy={busy}
            disabled={chosen === role}
            onPress={() => {
              onSave(chosen)
            }}
          />
          <Button label={lstrings.role_cancel} kind="text" onPress={onClose} />
        </View>
      </View>
    </Modal>
  )
}

/** `Team admin`, `Season admin`, `League admin`. */
export function adminLabel(scopeKind: 'league' | 'season' | 'team'): string {
  if (scopeKind === 'team') return lstrings.role_team_admin
  if (scopeKind === 'season') return lstrings.role_season_admin
  return lstrings.role_league_admin
}

export function memberLabel(scopeKind: 'league' | 'season' | 'team'): string {
  if (scopeKind === 'team') return lstrings.role_team_member
  if (scopeKind === 'season') return lstrings.role_season_member
  return lstrings.role_league_member
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
    backgroundColor: theme.cardBackgroundColor,
    borderRadius: theme.rem(theme.radiusLargeRem),
    borderWidth: 1,
    borderColor: theme.defaultBorderColor,
    padding: theme.rem(theme.spaceMdRem),
    gap: theme.rem(theme.spaceMdRem)
  },
  title: {
    fontFamily: theme.boldTextFont,
    fontSize: theme.rem(1.125),
    fontWeight: '700',
    color: theme.primaryTextColor
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
