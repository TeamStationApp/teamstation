import React from 'react'
import { StyleSheet, Text } from 'react-native'

import { CHROME_BLACK, NAME_BADGE, WHITE } from './overlayTheme'

export interface NameBadgeProps {
  /** The camera angle's name, which stands where Cameraman shows the camera's. */
  name: string
}

/** The angle's name, white on black at 45 %, beside the gear. */
export function NameBadge(props: NameBadgeProps): React.ReactElement {
  return (
    <Text testID="camera-name" style={styles.badge} numberOfLines={1}>
      {props.name}
    </Text>
  )
}

const styles = StyleSheet.create({
  badge: {
    flexShrink: 1,
    fontSize: NAME_BADGE.fontSize,
    fontWeight: NAME_BADGE.fontWeight,
    color: WHITE,
    backgroundColor: CHROME_BLACK,
    paddingHorizontal: NAME_BADGE.paddingHorizontal,
    paddingVertical: NAME_BADGE.paddingVertical,
    borderRadius: NAME_BADGE.radius,
    overflow: 'hidden'
  }
})
