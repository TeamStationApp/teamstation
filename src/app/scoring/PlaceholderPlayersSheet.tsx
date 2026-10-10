import React, { useRef, useState } from 'react'
import { View } from 'react-native'

import { Button } from '../components/Button'
import { PlayerCountPicker } from './PlayerCountPicker'
import { ScoringError, ScoringSheet } from './ScoringSheet'
import { useScoringSheetTheme } from './scoringSheetTheme'
export function PlaceholderPlayersSheet({
  onClose,
  onAdd
}: {
  onClose: () => void
  onAdd: (count: number) => void | Promise<void>
}): React.ReactElement {
  const theme = useScoringSheetTheme()
  const [count, setCount] = useState(1)
  const saving = useRef(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string>()
  const add = async (): Promise<void> => {
    if (saving.current) return
    saving.current = true
    setBusy(true)
    setProblem(undefined)
    let added = false
    try {
      await onAdd(count)
      added = true
      onClose()
    } catch {
      setProblem('Unable to add players. Please try again.')
    } finally {
      if (!added) saving.current = false
      setBusy(false)
    }
  }
  return (
    <ScoringSheet
      title="Select number of players to add."
      placement="center"
      textCancel
      onClose={onClose}
    >
      <PlayerCountPicker value={count} onChange={setCount} />
      <ScoringError message={problem} />
      <View style={{ alignSelf: 'center', minWidth: 100, marginVertical: 12 }}>
        <Button
          color={theme.scoringMenuActiveBackground}
          textColor={theme.scoringMenuActiveText}
          compact
          accessibilityLabel="Add"
          label="Add"
          disabled={busy}
          onPress={() => {
            add().catch(() => undefined)
          }}
        />
      </View>
    </ScoringSheet>
  )
}
