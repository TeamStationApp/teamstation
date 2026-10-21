import React, { useState } from 'react'
import { Pressable, Text, View } from 'react-native'

import { lstrings } from '../locales/strings'
import { ScoringSheet } from './ScoringSheet'
import { useScoringSheetTheme } from './scoringSheetTheme'

export function GameRosterHeader(): React.ReactElement {
  const theme = useScoringSheetTheme()
  const [helpOpen, setHelpOpen] = useState(false)
  const text = {
    color: theme.scoringSurface.text,
    fontFamily: theme.regularTextFont,
    fontSize: 15
  }
  return (
    <>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8
        }}
      >
        <Text style={{ ...text, flex: 1 }}>
          {lstrings.scoring_edit_roster_instruction}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Game roster information"
          onPress={() => {
            setHelpOpen(true)
          }}
          style={({ pressed }) => ({
            minHeight: 48,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: 6,
            opacity: pressed ? 0.6 : 1
          })}
        >
          <Text style={{ ...text, textAlign: 'right' }}>Game roster</Text>
          <View
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={{
              width: 16,
              height: 16,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: text.color,
              alignItems: 'center',
              justifyContent: 'center'
            }}
          >
            <Text style={{ ...text, fontSize: 12, lineHeight: 14 }}>i</Text>
          </View>
        </Pressable>
      </View>
      {helpOpen && (
        <ScoringSheet
          title="Game roster"
          placement="center"
          done
          onClose={() => {
            setHelpOpen(false)
          }}
        >
          <Text style={{ ...text, lineHeight: 23 }}>
            Toggle a player off to remove them from this current game's roster.
            This will prevent them from showing up as options in the batting
            lineup and defensive positions. This will not affect future games,
            where all players are rostered by default.
          </Text>
        </ScoringSheet>
      )}
    </>
  )
}
