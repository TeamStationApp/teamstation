import React, { useRef, useState } from 'react'
import { View } from 'react-native'

import { PlayerCountPicker } from './PlayerCountPicker'
import { ScoringButton, ScoringSheet } from './ScoringSheet'
export function PlaceholderPlayersSheet({
  onClose,
  onAdd
}: {
  onClose: () => void
  onAdd: (count: number) => void
}): React.ReactElement {
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
        <ScoringButton
          shape="pill"
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
