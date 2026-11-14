import React, { memo } from 'react'
import { Text, View } from 'react-native'

import { type ActivityRow, localMinute } from '../../common/userManagement'
import { Card } from '../components'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

/** What the first column of an activity list holds. */
export type ActivityKind = 'logins' | 'sessions'

/** A cell with no time in it. */
const NONE = '—'

/** Each column's share of a wide row, in the order they are drawn. */
const COLUMNS = [
  { key: 'at', flex: 1.1 },
  { key: 'lastActive', flex: 1.1 },
  { key: 'name', flex: 1.2 },
  { key: 'email', flex: 1.6 },
  { key: 'device', flex: 1.1 },
  { key: 'app', flex: 0.7 }
] as const
type Column = (typeof COLUMNS)[number]['key']

function headings(kind: ActivityKind): Record<Column, string> {
  return {
    at: kind === 'logins' ? 'Login time' : 'Session start',
    lastActive: 'Last active',
    name: 'Name',
    email: 'Email',
    device: 'Device',
    app: 'App'
  }
}

/** The column titles above a wide list. A phone's rows name their own. */
export function ActivityHeader(props: {
  kind: ActivityKind
}): React.ReactElement {
  const styles = getStyles(useTheme())
  const titles = headings(props.kind)
  return (
    <View style={[styles.wide, styles.header]} accessibilityRole="header">
      {COLUMNS.map(column => (
        <Text
          key={column.key}
          numberOfLines={1}
          style={[styles.heading, { flex: column.flex }]}
        >
          {titles[column.key]}
        </Text>
      ))}
    </View>
  )
}

/**
 * One login or session, on its own card: a row of columns on a wide window,
 * and on a phone the name and time, then the address, then the device, app
 * and last activity, every line cut short rather than wrapped.
 */
export const ActivityRowView = memo(function ActivityRowView(props: {
  row: ActivityRow
  kind: ActivityKind
  narrow: boolean
}): React.ReactElement {
  const { row, kind, narrow } = props
  const styles = getStyles(useTheme())
  const at = localMinute(row.at)
  const lastActive = localMinute(row.lastActiveAt)
  const email = row.email ?? NONE
  const label = `${headings(kind).at} ${at}, ${row.displayName}`
  if (!narrow) {
    const cells: Record<Column, string> = {
      at,
      lastActive: lastActive === '' ? NONE : lastActive,
      name: row.displayName,
      email,
      device: row.device,
      app: row.appType
    }
    return (
      <View style={styles.cell}>
        <Card>
          <View style={styles.wide} accessibilityLabel={label}>
            {COLUMNS.map(column => (
              <Text
                key={column.key}
                numberOfLines={1}
                style={[
                  column.key === 'name' ? styles.name : styles.value,
                  { flex: column.flex }
                ]}
              >
                {cells[column.key]}
              </Text>
            ))}
          </View>
        </Card>
      </View>
    )
  }
  return (
    <View style={styles.cell}>
      <Card>
        <View style={styles.stack} accessibilityLabel={label}>
          <View style={styles.line}>
            <Text numberOfLines={1} style={[styles.name, styles.grow]}>
              {row.displayName}
            </Text>
            <Text numberOfLines={1} style={styles.value}>
              {at}
            </Text>
          </View>
          <Text numberOfLines={1} style={styles.value}>
            {email}
          </Text>
          <Text numberOfLines={1} style={styles.quiet}>
            {`${row.device} · ${row.appType} · Last active ${lastActive === '' ? NONE : lastActive}`}
          </Text>
        </View>
      </Card>
    </View>
  )
})

const getStyles = cacheStyles((theme: Theme) => ({
  cell: { paddingBottom: theme.rem(theme.spaceSmRem) },
  wide: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: theme.rem(0.75)
  },
  header: {
    paddingHorizontal: theme.rem(theme.cardContentInsetRem),
    paddingBottom: theme.rem(0.5)
  },
  heading: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.8125),
    color: theme.secondaryTextColor,
    minWidth: 0
  },
  stack: { gap: theme.rem(0.25) },
  line: {
    flexDirection: 'row' as const,
    alignItems: 'baseline' as const,
    gap: theme.rem(0.75)
  },
  grow: { flex: 1 },
  name: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.9375),
    color: theme.primaryTextColor,
    minWidth: 0
  },
  value: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.9375),
    color: theme.primaryTextColor,
    minWidth: 0
  },
  quiet: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875),
    color: theme.secondaryTextColor
  }
}))
