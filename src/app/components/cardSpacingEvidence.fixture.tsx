import React, { useState } from 'react'
import { Pressable, Text, View } from 'react-native'

import { useTheme } from '../theme/ThemeContext'
import { ListCard } from './ListCard'
import { ListRow } from './ListRow'

const cases = [
  {
    label: 'Single line',
    title: 'One row, one text line',
    rows: 1,
    subtitle: false
  },
  {
    label: 'Two lines',
    title: 'One row, two text lines',
    rows: 1,
    subtitle: true
  },
  {
    label: 'One-line list',
    title: 'Four rows, one text line each',
    rows: 4,
    subtitle: false
  },
  {
    label: 'Two-line list',
    title: 'Four rows, two text lines each',
    rows: 4,
    subtitle: true
  }
] as const

/** A complete card stays in view so its first/last row and borders can be compared. */
export function CardSpacingEvidence(): React.ReactElement {
  const theme = useTheme()
  const [selected, setSelected] = useState(0)
  const [pressed, setPressed] = useState('')
  const example = cases[selected]
  const text = { color: theme.primaryTextColor, fontSize: theme.rem(1) }
  return (
    <View
      style={{
        width: '100%',
        maxWidth: theme.rem(60),
        alignSelf: 'center',
        padding: 16,
        gap: 16
      }}
    >
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {cases.map((item, index) => (
          <Pressable
            key={item.label}
            accessibilityRole="button"
            accessibilityLabel={item.label}
            onPress={() => {
              setSelected(index)
              setPressed('')
            }}
            style={{
              padding: 8,
              backgroundColor: theme.containerBackgroundColor
            }}
          >
            <Text style={{ ...text, fontSize: 14 }}>{item.label}</Text>
          </Pressable>
        ))}
      </View>
      <Text style={text}>{example.title}</Text>
      <View testID="spacing-evidence-card">
        <ListCard>
          {Array.from({ length: example.rows }, (_, index) => {
            const title =
              example.rows === 1
                ? 'Single row'
                : index === 0
                  ? 'First row'
                  : index === example.rows - 1
                    ? 'Final row'
                    : `Row ${index + 1}`
            return (
              <ListRow
                key={index}
                title={title}
                subtitle={example.subtitle ? 'Second text line' : undefined}
                emblem={String(index + 1)}
                onPress={() => {
                  setPressed(title)
                }}
              />
            )
          })}
        </ListCard>
      </View>
      <Text style={{ ...text, fontSize: 14 }}>
        {example.rows === 1
          ? 'All four card edges are visible.'
          : 'First row, every divider, and final row are visible.'}
      </Text>
      {pressed !== '' && <Text style={text}>{pressed} opened</Text>}
    </View>
  )
}
