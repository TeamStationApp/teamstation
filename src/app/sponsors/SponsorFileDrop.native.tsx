import React from 'react'
import { Text, View } from 'react-native'
import { launchImageLibrary } from 'react-native-image-picker'

import { Button } from '../components'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { type LaunchLibrary, pickFromLibrary } from './pickedFiles.native'
import type { PickedFile } from './sponsorTypes'

export interface SponsorFileDropProps {
  /** What the button is for, e.g. "Add Logo"; also its accessible name. */
  label: string
  /** The web's drop-zone line; a phone shows its own. */
  prompt?: string
  /** The web chooser's `accept`; a video type opens the album's videos. */
  accept: string
  onPick: (picked: PickedFile) => void
  /** The sentence under the button, for a file that was refused. */
  error?: string | null
  testID?: string
  /** The album, which a test stands in for. */
  launch?: LaunchLibrary
}

/**
 * A phone's file choice for the sponsor screens: a "Choose from Photos"
 * button that opens the photo album for one picture, or one video when
 * `accept` names video. The picked file is handed on as a `PickedFile`; the
 * screen checks it. A cancelled pick does nothing.
 */
export function SponsorFileDrop({
  label,
  // The web's line about dropping a file; a phone has no drop zone.
  prompt: _webPrompt,
  accept,
  onPick,
  error,
  testID = 'sponsor-drop-zone',
  launch = launchImageLibrary
}: SponsorFileDropProps): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  const [albumError, setAlbumError] = React.useState<string | null>(null)
  const kind = accept.startsWith('video/') ? 'video' : 'photo'
  const shown = albumError ?? error
  return (
    <View style={styles.wrap}>
      <View testID={testID} accessibilityLabel={label} style={styles.zone}>
        <Text style={styles.label}>{label}</Text>
        <Button
          color={theme.scoreActionColor}
          label="Choose from Photos"
          accessibilityLabel={`Choose from Photos: ${label}`}
          onPress={() => {
            setAlbumError(null)
            pickFromLibrary(launch, kind)
              .then(picked => {
                if (picked != null) onPick(picked)
              })
              .catch((caught: unknown) => {
                setAlbumError(
                  caught instanceof Error ? caught.message : String(caught)
                )
              })
          }}
        />
      </View>
      {shown != null && shown !== '' && (
        <Text accessibilityRole="alert" style={styles.error}>
          {shown}
        </Text>
      )}
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  wrap: { gap: theme.rem(0.5) },
  zone: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.rem(0.5),
    padding: theme.rem(1),
    borderRadius: theme.rem(0.75),
    borderWidth: 1,
    borderColor: theme.defaultBorderColor,
    backgroundColor: theme.cardBackgroundColor
  },
  label: {
    color: theme.primaryTextColor,
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1)
  },
  error: {
    color: theme.dangerColor,
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.9375)
  }
}))
