import React from 'react'
import { Text, View } from 'react-native'

import type { UmpireGameBlock } from '../../common/umpireSchedule'
import { Button, SectionHeader } from '../components'
import { useUmpireStyles } from './shared'
export function GameUmpires({
  umpires
}: {
  umpires: UmpireGameBlock | null
}): React.ReactElement | null {
  const s = useUmpireStyles()
  if (umpires == null) return null
  return (
    <View style={s.page} testID="game-umpires">
      <SectionHeader title="Umpires" />
      {umpires.plateNeeded &&
        (umpires.plate == null ? (
          <Button
            label="Plate umpire"
            disabled
            kind="secondary"
            color="#EEEEEE"
            textColor="#616161"
            onPress={() => undefined}
          />
        ) : (
          <Text style={s.text}>Plate umpire: {umpires.plate.name}</Text>
        ))}
      {umpires.field.map((p, i) =>
        p == null ? (
          <Button
            key={i}
            label={`Field ump ${i + 1}`}
            disabled
            kind="secondary"
            color="#EEEEEE"
            textColor="#616161"
            onPress={() => undefined}
          />
        ) : (
          <Text key={i} style={s.text}>
            Field ump {i + 1}: {p.name}
          </Text>
        )
      )}
    </View>
  )
}
