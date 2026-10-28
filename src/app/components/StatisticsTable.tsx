import React from 'react'
import { Pressable, Text } from 'react-native'

import type { StatColumn } from '../screens/statColumns'
import { useTheme } from '../theme/ThemeContext'
import { FrozenNameTable } from './FrozenNameTable'

export function StatisticsTable<
  T extends { userId: string | null; shortName?: string }
>({
  rows,
  columns,
  onOpen
}: {
  rows: T[]
  columns: Array<StatColumn<T>>
  /** Only a line that stands for somebody opens. */
  onOpen?: (row: T & { userId: string }) => void
}): React.ReactElement {
  const theme = useTheme()
  return (
    <FrozenNameTable
      heading="Player"
      rows={rows}
      columns={columns}
      rowKey={row => row.userId ?? `withdrawn ${rows.indexOf(row)}`}
      name={row => {
        // A withdrawn line stands for nobody, so there is no page to open.
        const { userId } = row
        const opens = onOpen != null && userId != null
        return (
          <Pressable
            accessibilityRole={opens ? 'button' : undefined}
            accessibilityLabel={
              opens ? `Open ${row.shortName ?? 'Unknown'}` : undefined
            }
            disabled={!opens}
            onPress={() => {
              if (opens) onOpen({ ...row, userId })
            }}
            style={{ flex: 1, minHeight: 44, justifyContent: 'center' }}
          >
            <Text
              numberOfLines={1}
              style={{
                fontFamily: theme.regularTextFont,
                fontSize: theme.rem(0.875),
                color: theme.primaryTextColor
              }}
            >
              {row.shortName ?? 'Unknown'}
            </Text>
          </Pressable>
        )
      }}
    />
  )
}
