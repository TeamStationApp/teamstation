import React, { useRef, useState } from 'react'
import { View } from 'react-native'

import { Button } from '../components/Button'
import { useTheme } from '../theme/ThemeContext'
import { PlayerCountPicker } from './PlayerCountPicker'
import { ScoringSheet } from './ScoringSheet'
export function PlaceholderPlayersSheet({
  onClose,
  onAdd
}: {
  onClose: () => void
  onAdd: (count: number) => void
}): React.ReactElement {
  const theme = useTheme()
  const [count, setCount] = useState(1)
  const saving = useRef(false)
  return (
    <ScoringSheet
      title="Select number of players to add."
      textCancel
      onClose={onClose}
    >
      <PlayerCountPicker value={count} onChange={setCount} />
      <View style={{ alignSelf: 'center', minWidth: 100, marginVertical: 12 }}>
        <Button
          color={theme.scoringMenuActiveBackground}
          textColor={theme.scoringMenuActiveText}
          compact
          accessibilityLabel="Add"
          label="Add"
          onPress={() => {
            if (saving.current) return
            saving.current = true
            onAdd(count)
            onClose()
          }}
        />
      </View>
    </ScoringSheet>
  )
}
