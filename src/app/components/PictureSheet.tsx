import React, { useRef, useState } from 'react'
import { Modal, Pressable, ScrollView, Text, View } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import type { GroupPicture } from '../../common/groupCreation'
import type { pickAccountPhoto } from '../platform/pickAccountPhoto'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { Button } from './Button'
import { DangerText } from './DangerText'
import { GroupPictureChooser } from './GroupPictureChooser'

export function PictureSheet({
  client,
  name,
  team = false,
  fitInitials = false,
  allowCatalog = false,
  pickPhoto,
  onSave,
  onClose
}: {
  client: TeamStationClient
  name: string
  team?: boolean
  fitInitials?: boolean
  allowCatalog?: boolean
  pickPhoto?: typeof pickAccountPhoto
  onSave: (choice: GroupPicture) => Promise<void>
  onClose: () => void
}): React.ReactElement {
  const styles = getStyles(useTheme())
  const [choice, setChoice] = useState<GroupPicture>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const working = useRef(false)
  const close = (): void => {
    if (!working.current) onClose()
  }
  const save = async (): Promise<void> => {
    if (working.current || choice == null) return
    working.current = true
    setBusy(true)
    setError('')
    try {
      await onSave(choice)
      onClose()
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : 'Photo could not be saved. Try again.'
      )
    } finally {
      working.current = false
      setBusy(false)
    }
  }
  return (
    <Modal transparent visible animationType="slide" onRequestClose={close}>
      <View style={styles.scrim}>
        <Pressable
          accessibilityLabel="Dismiss photo chooser"
          style={styles.behind}
          disabled={busy}
          onPress={close}
        />
        <View style={styles.sheet}>
          <View style={styles.grip} />
          <Text accessibilityRole="header" style={styles.title}>
            Photo
          </Text>
          <ScrollView keyboardShouldPersistTaps="handled" style={styles.body}>
            <GroupPictureChooser
              client={client}
              name={name}
              team={team}
              fitInitials={fitInitials}
              allowCatalog={allowCatalog}
              pickPhoto={pickPhoto}
              value={choice}
              onChange={next => {
                if (working.current) return
                setChoice(next)
                setError('')
              }}
            />
            <Text style={styles.hint}>JPEG, PNG or WebP, up to 10 MB.</Text>
          </ScrollView>
          {error !== '' && (
            <Text accessibilityRole="alert" style={styles.error}>
              {error}
            </Text>
          )}
          <Button
            label="Save photo"
            block
            busy={busy}
            disabled={choice == null}
            onPress={() => {
              save().catch(() => undefined)
            }}
          />
          <DangerText label="Cancel" disabled={busy} onPress={close} />
        </View>
      </View>
    </Modal>
  )
}
const getStyles = cacheStyles((theme: Theme) => ({
  scrim: {
    flex: 1,
    justifyContent: 'flex-end' as const,
    backgroundColor: 'rgba(0,0,0,0.35)'
  },
  behind: {
    position: 'absolute' as const,
    top: 0,
    bottom: 0,
    left: 0,
    right: 0
  },
  sheet: {
    backgroundColor: theme.cardBackgroundColor,
    maxHeight: '90%' as const,
    padding: theme.rem(1.25),
    gap: theme.rem(0.75),
    borderTopLeftRadius: theme.rem(1.5),
    borderTopRightRadius: theme.rem(1.5)
  },
  grip: {
    width: theme.rem(2.5),
    height: theme.rem(0.25),
    backgroundColor: theme.defaultBorderColor,
    borderRadius: theme.radiusPill,
    alignSelf: 'center' as const
  },
  body: { flexShrink: 1 },
  title: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1.25),
    color: theme.primaryTextColor
  },
  hint: {
    marginTop: theme.rem(0.75),
    fontSize: theme.rem(0.875),
    color: theme.secondaryTextColor
  },
  error: { fontSize: theme.rem(0.875), color: theme.dangerColor }
}))
