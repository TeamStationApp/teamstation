import React from 'react'
import { Switch, Text, View } from 'react-native'

import { type Role, ROLE_FLAGS, type RoleFlag } from '../../common/roles'
import { lstrings, sprintf } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { adminLabel, flagDetail, flagLabel } from './roleLabels'

export function RoleSwitches({
  scopeKind,
  scopeName,
  admin,
  flags,
  inherited = {},
  busy = false,
  onChange
}: {
  scopeKind: 'team' | 'season' | 'league'
  scopeName: string
  admin: boolean
  flags: RoleFlag[]
  inherited?: Partial<Record<Role, string>>
  busy?: boolean
  onChange: (roles: { admin: boolean; flags: RoleFlag[] }) => void
}): React.ReactElement {
  const styles = getStyles(useTheme())
  const adminAbove = inherited.admin
  const isAdmin = admin || adminAbove != null
  const isScorekeeper =
    flags.includes('scorekeeper') || inherited.scorekeeper != null
  const rows = [
    {
      role: 'admin',
      label: adminLabel(scopeKind),
      detail: sprintf(lstrings.role_admin_detail, scopeName),
      on: isAdmin,
      fixedBy:
        adminAbove == null
          ? undefined
          : sprintf(lstrings.role_from, adminAbove),
      onChange: (next: boolean) => {
        onChange({ admin: next, flags })
      }
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
          onChange({
            admin,
            flags: ROLE_FLAGS.filter(item =>
              item === flag ? next : flags.includes(item)
            )
          })
        }
      }
    })
  ]
  return (
    <View>
      {rows.map(row => (
        <View key={row.role} style={styles.choice}>
          <View style={styles.words}>
            <Text style={styles.label}>{row.label}</Text>
            <Text style={styles.detail}>{row.detail}</Text>
            {row.fixedBy != null && (
              <Text style={styles.fixed}>{row.fixedBy}</Text>
            )}
          </View>
          <Switch
            accessibilityLabel={row.label}
            value={row.on}
            disabled={busy || row.fixedBy != null}
            onValueChange={value => {
              row.onChange(value)
            }}
          />
        </View>
      ))}
    </View>
  )
}
const getStyles = cacheStyles((theme: Theme) => ({
  choice: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: theme.rem(0.75),
    paddingVertical: theme.rem(0.5)
  },
  words: { flex: 1 },
  label: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1),
    color: theme.primaryTextColor
  },
  detail: { fontSize: theme.rem(0.8125), color: theme.secondaryTextColor },
  fixed: { fontSize: theme.rem(0.8125), color: theme.activeColor }
}))
