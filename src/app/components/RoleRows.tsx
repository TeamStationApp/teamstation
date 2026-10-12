import React from 'react'
import { Text, View } from 'react-native'

import type { ProfileSection } from '../../common/api'
import { impliedRoles, type Role, ROLES } from '../../common/roles'
import { lstrings, sprintf } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { Button } from './Button'
import { Card } from './Card'
import { flagLabel } from './RolesModal'

/** What a row of a person's roles can be given or lose. */
export type RoleRowKind = Role | 'member'

export interface RoleRowsProps {
  section: ProfileSection
  /** Whether they can hold a role at all: an account that signs in. */
  canHoldRoles: boolean
  viewer: { manages: boolean; admin: boolean }
  /**
   * A player's own rows, on their Settings: while they are on the team, the
   * Member row reads Player with no button, as a player's place on the team
   * is the roster's to change.
   */
  player?: boolean
  busy?: boolean
  onAdd: (role: RoleRowKind) => void
  onRemove: (role: RoleRowKind) => void
}

/** `Admin`, `Coach`, … `Member`, `Follower`: one row each, in this order. */
const ROWS: ReadonlyArray<RoleRowKind | 'follower'> = [
  ...ROLES,
  'member',
  'follower'
]

/**
 * One level of what a person holds: Admin, the five staff roles, Member and
 * Follower, a row each.
 *
 * On the level being managed, a role they hold has a red **Remove** and one
 * they lack a green **Add**, for a viewer who manages its people; the Admin
 * row only for an administrator, and Remove on Member (which takes every role
 * here with it) not for an administrator's membership unless the viewer is
 * one. Follower is only ever a status: following is the person's own. A
 * role another of theirs brings with it at this level (`impliedRoles`: every
 * staff role with Admin, Songkeeper with Scorekeeper) reads "With Admin" or
 * "With Scorekeeper", with no button. Any other level, and any viewer who
 * does not manage, reads the rows only.
 */
export function RoleRows(props: RoleRowsProps): React.ReactElement {
  const {
    section,
    canHoldRoles,
    viewer,
    player = false,
    busy = false,
    onAdd,
    onRemove
  } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const holdsAdmin = section.roles.includes('admin')
  const implied = impliedRoles(section.roles)
  return (
    <Card style={styles.card}>
      {ROWS.map((row, index) => {
        const held =
          row === 'follower'
            ? section.follower
            : row === 'member'
              ? section.member
              : section.roles.includes(row)
        const impliedBy =
          row === 'follower' || row === 'member' || row === 'admin'
            ? undefined
            : implied.get(row)
        // Read as Player only while they are on the team; anybody else's
        // Member row is the usual one.
        const playerRow = player && row === 'member' && section.member
        const changeable =
          impliedBy == null &&
          !playerRow &&
          section.editable &&
          viewer.manages &&
          (row !== 'admin' || viewer.admin) &&
          (row !== 'member' || !held || !holdsAdmin || viewer.admin) &&
          (row === 'member' || held || canHoldRoles)
        const label = labelOf(row)
        return (
          <View
            key={row}
            testID={`role-${section.level}-${row}`}
            style={[styles.row, index > 0 && styles.divided]}
          >
            <Text style={styles.label}>{label}</Text>
            {changeable && row !== 'follower' ? (
              <Button
                compact
                label={held ? lstrings.profile_remove : lstrings.profile_add}
                accessibilityLabel={`${held ? lstrings.profile_remove : lstrings.profile_add} ${label}`}
                color={held ? theme.dangerColor : theme.successColor}
                textColor={theme.buttonTextColor}
                disabled={busy}
                onPress={() => {
                  if (held) onRemove(row)
                  else onAdd(row)
                }}
              />
            ) : (
              <Text
                style={
                  held || impliedBy != null || playerRow
                    ? styles.held
                    : styles.notHeld
                }
              >
                {impliedBy != null
                  ? sprintf(lstrings.profile_with, labelOf(impliedBy))
                  : playerRow
                    ? lstrings.profile_player
                    : row === 'follower'
                      ? held
                        ? lstrings.profile_following
                        : lstrings.profile_not_following
                      : held
                        ? lstrings.profile_held
                        : lstrings.profile_not_held}
              </Text>
            )}
          </View>
        )
      })}
    </Card>
  )
}

function labelOf(row: RoleRowKind | 'follower'): string {
  if (row === 'admin') return lstrings.profile_admin
  if (row === 'member') return lstrings.profile_member
  if (row === 'follower') return lstrings.profile_follower
  return flagLabel(row)
}

const getStyles = cacheStyles((theme: Theme) => ({
  card: { paddingVertical: theme.rem(theme.spaceXsRem) },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.rem(theme.spaceSmRem),
    minHeight: theme.rem(3),
    paddingVertical: theme.rem(theme.spaceXsRem)
  },
  divided: {
    borderTopWidth: 1,
    borderTopColor: theme.defaultBorderColor
  },
  label: {
    flex: 1,
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1),
    fontWeight: '600',
    color: theme.primaryTextColor
  },
  held: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.875),
    fontWeight: '600',
    color: theme.successColor
  },
  notHeld: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875),
    color: theme.secondaryTextColor
  }
}))
