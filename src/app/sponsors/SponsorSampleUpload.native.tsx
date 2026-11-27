import React from 'react'
import { Text } from 'react-native'

import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import type { SponsorSampleUploadProps } from './sponsorSampleUploadProps'

export type { PickedSample } from './sponsorSampleUploadProps'

/**
 * On a phone or the TV the sample video is not uploaded here: a node
 * administrator uploads it from the web, where the file is at hand.
 */
export function SponsorSampleUpload(
  _props: SponsorSampleUploadProps
): React.ReactElement {
  const styles = getStyles(useTheme())
  return <Text style={styles.hint}>Upload the sample video from the web.</Text>
}

const getStyles = cacheStyles((theme: Theme) => ({
  hint: {
    color: theme.secondaryTextColor,
    fontSize: theme.rem(0.875),
    lineHeight: theme.rem(1.3)
  }
}))
