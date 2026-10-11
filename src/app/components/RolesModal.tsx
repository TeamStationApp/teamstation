import React, { useState } from 'react'
import { Modal, Pressable, Switch, Text, View } from 'react-native'

import { type Role, ROLE_FLAGS, type RoleFlag } from '../../common/roles'
import { lstrings, sprintf } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { Button } from './Button'

export interface RolesModalProps {
  /** Whose roles are being changed. */
  displayName: string
  /** The level this page administers, which is the only one on offer. */
  scopeKind: 'league' | 'season' | 'team'
  scopeName: string
  /** The roles set on this level itself, which are what Save changes. */
  held: Role[]
  /**
   * Roles this person holds from a level above, by the name of the level
   * that carries each one down. Shown on and fixed: this page cannot take
   * them away.
   */
  inherited?: Partial<Record<Role, string>>
  busy?: boolean
  onSave: (roles: { admin: boolean; flags: RoleFlag[] }) => void
  onClose: () => void
}

/**
 * Changing what one person may do at one level: six switches.
 *
 * Administrator, then the five flags, each with a line saying what it allows
 * here, because "scorekeeper" on its own does not say whose games. An
 * administrator already holds every flag, so with Admin on the flags show on
 * and fixed rather than inviting somebody to turn off what admin gives
 * anyway; Songkeeper shows the same way under Scorekeeper, which includes
 * it, and a flag set on a level above names that level. Save sends the
 * switches this level holds itself and nothing shown on only because of
 * another.
 *
 * The page they are on decides the level, and nothing here can reach
 * another: a team's page sets team roles and no others.
 */
export function RolesModal(props: RolesModalProps): React.ReactElement {
  const {
    displayName,
    scopeKind,
    scopeName,
    held,
    inherited = {},
    busy,
    onSave,
    onClose
  } = props
  const styles = getStyles(useTheme())
  const [admin, setAdmin] = useState(held.includes('admin'))
  const [flags, setFlags] = useState<RoleFlag[]>(
    ROLE_FLAGS.filter(flag => held.includes(flag))
  )

  const adminAbove = inherited.admin
  const isAdmin = admin || adminAbove != null
  // A scorekeeper keeps the songs too, so Songkeeper shows on and fixed while
  // Scorekeeper is, whether set here or above.
  const isScorekeeper =
    flags.includes('scorekeeper') || inherited.scorekeeper != null
  const changed =
    admin !== held.includes('admin') ||
    ROLE_FLAGS.some(flag => flags.includes(flag) !== held.includes(flag))

  const rows: Array<{
    role: Role
    label: string
    detail: string
    on: boolean
    /** Why the switch cannot be moved, when it cannot. */
    fixedBy?: string
    onChange: (next: boolean) => void
  }> = [
    {
      role: 'admin',
      label: adminLabel(scopeKind),
      detail: sprintf(lstrings.role_admin_detail, scopeName),
      on: isAdmin,
      fixedBy:
        adminAbove == null
          ? undefined
          : sprintf(lstrings.role_from, adminAbove),
      onChange: setAdmin
    },
    ...ROLE_FLAGS.map(flag => {
      const above = inherited[flag]
      const byScorekeeper = flag === 'songkeeper' && isScorekeeper
      return {
        role: flag,
        label: flagLabel(flag),
        detail: sprintf(flagDetail(flag), scopeName),
        on: isAdmin || byScorekeeper || above != null || flags.includes(flag),
        fixedBy: isAdmin
          ? lstrings.role_admin_all
          : byScorekeeper
            ? lstrings.role_scorekeeper_all
            : above == null
              ? undefined
              : sprintf(lstrings.role_from, above),
        onChange: (next: boolean) => {
          setFlags(now =>
            ROLE_FLAGS.filter(item =>
              item === flag ? next : now.includes(item)
            )
          )
        }
      }
    })
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

          {rows.map(row => (
            <View key={row.role} style={styles.choice}>
              <View style={styles.choiceText}>
                <Text style={styles.choiceLabel}>{row.label}</Text>
                <Text style={styles.detail}>{row.detail}</Text>
                {row.fixedBy != null && (
                  <Text style={styles.fixed}>{row.fixedBy}</Text>
                )}
              </View>
              <Switch
                accessibilityLabel={row.label}
                value={row.on}
                disabled={busy === true || row.fixedBy != null}
                onValueChange={next => {
                  row.onChange(next)
                }}
              />
            </View>
          ))}

          <Button
            label={lstrings.role_save}
            busy={busy}
            disabled={!changed}
            onPress={() => {
              onSave({ admin, flags })
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

/** `Coach`, `Assistant`, `Scorekeeper`, `Songkeeper`, `Videographer`. */
export function flagLabel(flag: RoleFlag): string {
  if (flag === 'coach') return lstrings.role_coach
  if (flag === 'assistant') return lstrings.role_assistant
  if (flag === 'scorekeeper') return lstrings.role_scorekeeper
  if (flag === 'songkeeper') return lstrings.role_songkeeper
  return lstrings.role_videographer
}

/** What a flag allows, with a `%s` for the level it is set on. */
function flagDetail(flag: RoleFlag): string {
  if (flag === 'coach') return lstrings.role_coach_detail
  if (flag === 'assistant') return lstrings.role_assistant_detail
  if (flag === 'scorekeeper') return lstrings.role_scorekeeper_detail
  if (flag === 'songkeeper') return lstrings.role_songkeeper_detail
  return lstrings.role_videographer_detail
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
    maxWidth: theme.rem(26),
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
  detail: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.8125),
    color: theme.secondaryTextColor
  },
  fixed: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.75),
    fontWeight: '600',
    color: theme.secondaryTextColor
  },
  choice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(theme.spaceSmRem),
    padding: theme.rem(theme.spaceSmRem),
    borderRadius: theme.rem(theme.radiusRem),
    borderWidth: 1,
    borderColor: theme.defaultBorderColor
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
