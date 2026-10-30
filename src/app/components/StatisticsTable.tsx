import React from 'react'
import { Pressable, Text, View } from 'react-native'

import type { StatColumn } from '../screens/statColumns'
import { useTheme } from '../theme/ThemeContext'
import { FrozenNameTable } from './FrozenNameTable'

export function StatisticsTable<
  T extends { userId: string | null; shortName?: string; openable?: boolean }
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
        // A withdrawn line stands for nobody, and a pool player's page may be
        // one this viewer cannot open: no tap target for either.
        const { userId } = row
        const shown = row.shortName ?? 'Unknown'
        const text = (
          <Text
            numberOfLines={1}
            style={{
              fontFamily: theme.regularTextFont,
              fontSize: theme.rem(0.875),
              color: theme.primaryTextColor
            }}
          >
            {shown}
          </Text>
        )
        const cell = {
          flex: 1,
          minHeight: 44,
          justifyContent: 'center'
        } as const
        if (onOpen == null || userId == null || row.openable === false)
          return <View style={cell}>{text}</View>
        return (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Open ${shown}`}
            onPress={() => {
              onOpen({ ...row, userId })
            }}
            style={cell}
          >
            {text}
          </Pressable>
        )
      }}
    />
  )
}
