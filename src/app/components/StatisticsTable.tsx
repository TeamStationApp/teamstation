import React from 'react'
import { Pressable, Text } from 'react-native'

import type { StatColumn } from '../screens/statColumns'
import { useTheme } from '../theme/ThemeContext'
import { FrozenNameTable } from './FrozenNameTable'

export function StatisticsTable<
  T extends { userId: number; shortName?: string }
>({
  rows,
  columns,
  onOpen
}: {
  rows: T[]
  columns: Array<StatColumn<T>>
  onOpen?: (row: T) => void
}): React.ReactElement {
  const theme = useTheme()
  return (
    <FrozenNameTable
      heading="Player"
      rows={rows}
      columns={columns}
      rowKey={row => row.userId}
      name={row => (
        <Pressable
          accessibilityRole={onOpen == null ? undefined : 'button'}
          accessibilityLabel={
            onOpen == null ? undefined : `Open ${row.shortName ?? 'Unknown'}`
          }
          disabled={onOpen == null}
          onPress={() => onOpen?.(row)}
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
      )}
    />
  )
}
