import React, { useState } from 'react'
import { View } from 'react-native'

import { ScoringPlayerCard } from './ScoringPlayerCard'
import { ScoringButton } from './ScoringSheet'
export function ScoringChoice({
  label,
  value,
  options,
  onChange
}: {
  label: string
  value: number | null
  options: Array<{ id: number | null; name: string }>
  onChange: (value: number | null) => void
}): React.ReactElement {
  const [open, setOpen] = useState(false)
  return (
    <View style={{ gap: 4 }}>
      <ScoringButton
        label={label}
        text={`${label}: ${options.find(option => option.id === value)?.name ?? 'Choose player'}`}
        onPress={() => {
          setOpen(previous => !previous)
        }}
      />
      {open &&
        options.map(option => (
          <ScoringPlayerCard
            key={option.id ?? 'none'}
            label={`Choose ${label} ${option.name}`}
            name={option.name}
            selected={option.id === value}
            onPress={() => {
              onChange(option.id)
              setOpen(false)
            }}
          />
        ))}
    </View>
  )
}
