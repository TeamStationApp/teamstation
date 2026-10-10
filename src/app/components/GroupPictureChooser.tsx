import React, { useCallback, useEffect, useState } from 'react'
import { Image, Text, View } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import type { GroupPicture } from '../../common/groupCreation'
import type { AvailablePicture } from '../../common/pictureCatalog'
import { pickAccountPhoto } from '../platform/pickAccountPhoto'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { Button } from './Button'
import { Emblem } from './Emblem'
import { initialsOf } from './initials'
import { PhotoGrid } from './PhotoGrid'

export function GroupPictureChooser({
  client,
  name,
  allowCatalog = false,
  value,
  onChange,
  pickPhoto = pickAccountPhoto
}: {
  client: TeamStationClient
  name: string
  allowCatalog?: boolean
  value?: GroupPicture
  onChange: (picture: GroupPicture) => void
  pickPhoto?: typeof pickAccountPhoto
}): React.ReactElement {
  const styles = getStyles(useTheme())
  const [entries, setEntries] = useState<AvailablePicture[]>([])
  const [error, setError] = useState('')
  const load = useCallback(async (): Promise<void> => {
    if (!allowCatalog) return
    try {
      setEntries(await client.pictures())
      setError('')
    } catch {
      setError(
        'Sports pictures could not load. Retry, add a photo, or use initials.'
      )
    }
  }, [client, allowCatalog])
  useEffect(() => {
    load().catch(() => undefined)
  }, [load])
  const upload = async (): Promise<void> => {
    try {
      const image = await pickPhoto()
      if (image != null) {
        onChange({ image })
        setError('')
      }
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : 'The photo could not be read. Retry.'
      )
    }
  }
  return (
    <View style={styles.choice}>
      {error !== '' && (
        <>
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
          {allowCatalog && (
            <Button
              label="Retry pictures"
              kind="secondary"
              onPress={() => {
                load().catch(() => undefined)
              }}
            />
          )}
        </>
      )}
      {value?.image != null && (
        <>
          <Image
            accessibilityLabel="Your selected photo"
            source={{
              uri: `data:${value.image.contentType};base64,${value.image.base64}`
            }}
            style={styles.preview}
          />
          <Text style={styles.hint}>Your photo is selected.</Text>
        </>
      )}
      {allowCatalog ? (
        <PhotoGrid
          entries={entries}
          selectedId={value?.catalogId}
          onSelect={catalogId => {
            onChange({ catalogId })
          }}
          onUpload={() => {
            upload().catch(() => undefined)
          }}
        />
      ) : (
        <Button
          label="Add Photo"
          kind="secondary"
          onPress={() => {
            upload().catch(() => undefined)
          }}
        />
      )}
      <Button
        label="Use initials"
        kind="secondary"
        onPress={() => {
          onChange({ initials: true })
        }}
      />
      {value != null && value.catalogId == null && value.image == null && (
        <View
          style={styles.initials}
          accessibilityLabel={`Initials preview: ${initialsOf(name)}`}
        >
          <Emblem fallback={initialsOf(name)} size={6} />
          <Text style={styles.hint}>Initials selected.</Text>
        </View>
      )}
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  choice: { gap: theme.rem(1) },
  initials: { alignItems: 'center' as const, gap: theme.rem(0.5) },
  preview: {
    width: theme.rem(6),
    height: theme.rem(6),
    alignSelf: 'center' as const,
    borderRadius: theme.rem(1)
  },
  hint: { fontSize: theme.rem(0.875), color: theme.secondaryTextColor },
  error: { fontSize: theme.rem(0.875), color: theme.dangerColor }
}))
