import React from 'react'
import { StyleSheet, Text, View } from 'react-native'

import { SETTINGS } from './settingsTheme'

export interface SettingsCardProps {
  title: string
  testID?: string
  children: React.ReactNode
}

/**
 * One of the sheet's cards, as TS Cameraman's `settingsCard` draws it: the
 * title above in uppercase footnote semibold green, and the rows on the
 * grouped secondary background with a 16 radius.
 */
export function SettingsCard(props: SettingsCardProps): React.ReactElement {
  const { title, testID, children } = props
  return (
    <View style={styles.card} testID={testID}>
      <Text style={styles.title}>{title.toUpperCase()}</Text>
      <View style={styles.body}>{children}</View>
    </View>
  )
}

const styles = StyleSheet.create({
  card: {
    gap: 6
  },
  title: {
    color: SETTINGS.green,
    fontSize: SETTINGS.footnote,
    fontWeight: '600',
    paddingHorizontal: SETTINGS.rowInset
  },
  body: {
    backgroundColor: SETTINGS.card,
    borderRadius: SETTINGS.cardRadius,
    overflow: 'hidden'
  }
})
