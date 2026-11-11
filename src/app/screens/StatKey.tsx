import React from 'react'
import { Text, View } from 'react-native'

import { useTheme } from '../theme/ThemeContext'
import { battingColumns, pitchingColumns } from './statColumns'

/** The table's vocabulary, read down the left column and then the right. */
export function StatKey({
  kind
}: {
  kind: 'batting' | 'pitching'
}): React.ReactElement {
  const theme = useTheme()
  const columns = kind === 'batting' ? battingColumns : pitchingColumns
  const half = columns.length / 2
  const text = {
    color: theme.primaryTextColor,
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875),
    lineHeight: theme.rem(1.25)
  }
  return (
    <View
      testID={`${kind}-stat-key`}
      style={{ flexDirection: 'row', gap: theme.rem(1), padding: theme.rem(1) }}
    >
      {[columns.slice(0, half), columns.slice(half)].map((entries, index) => (
        <View
          key={index}
          testID={`${kind}-stat-key-column-${index}`}
          style={{ flex: 1, minWidth: 0, gap: theme.rem(0.5) }}
        >
          {entries.map(column => (
            <View
              key={column.label}
              style={{ flexDirection: 'row', alignItems: 'flex-start' }}
            >
              <Text style={text}>
                <Text
                  style={{ fontFamily: theme.boldTextFont, fontWeight: '700' }}
                >
                  {column.label}
                </Text>
                {' - '}
              </Text>
              <Text style={[text, { flex: 1, minWidth: 0 }]}>
                {column.meaning}
              </Text>
            </View>
          ))}
        </View>
      ))}
    </View>
  )
}
