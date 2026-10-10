import React, { useCallback, useEffect, useState } from 'react'
import { Image, Text, TextInput, View } from 'react-native'

import type { AccountPicture } from '../../common/accountSettings'
import type { TeamStationClient } from '../../common/api'
import type { Onboarding } from '../../common/onboarding'
import type { AvailablePicture } from '../../common/pictureCatalog'
import { Button, Card, Screen } from '../components'
import { PhotoGrid } from '../components/PhotoGrid'
import { pickAccountPhoto } from '../platform/pickAccountPhoto'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

export interface OnboardingScreenProps {
  client: TeamStationClient
  initialName: string
  initialState: Onboarding
  onComplete: () => Promise<void>
}

export function OnboardingScreen({
  client,
  initialName,
  initialState,
  onComplete
}: OnboardingScreenProps): React.ReactElement {
  const styles = getStyles(useTheme())
  const [step, setStep] = useState(initialState.step)
  const [name, setName] = useState(
    initialName === 'New account' ? '' : initialName
  )
  const [pictures, setPictures] = useState<AvailablePicture[]>([])
  const [catalogId, setCatalogId] = useState<string | undefined>()
  const [image, setImage] = useState<AccountPicture | undefined>()
  const [error, setError] = useState('')
  const [catalogError, setCatalogError] = useState('')
  const [busy, setBusy] = useState(false)
  const loadPictures = useCallback(async (): Promise<void> => {
    try {
      setPictures(await client.pictures())
      setCatalogError('')
    } catch {
      setCatalogError(
        'Sports pictures could not load. Retry, add a photo, or use your initials.'
      )
    }
  }, [client])
  useEffect(() => {
    loadPictures().catch(() => undefined)
  }, [loadPictures])
  const saveName = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const saved = await client.saveOnboardingName(name)
      setName(saved.displayName)
      setStep(saved.onboarding.step)
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : 'Your name could not be saved. Retry.'
      )
    } finally {
      setBusy(false)
    }
  }
  const upload = async (): Promise<void> => {
    setError('')
    try {
      const selected = await pickAccountPhoto()
      if (selected != null) {
        setImage(selected)
        setCatalogId(undefined)
      }
    } catch (error) {
      setError(
        error instanceof Error ? error.message : 'The photo could not be read.'
      )
    }
  }
  const complete = async (initials = false): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await client.finishOnboarding(
        initials
          ? { initials: true }
          : image != null
            ? { image }
            : { catalogId }
      )
      await onComplete()
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : 'Your picture could not be saved. Retry.'
      )
    } finally {
      setBusy(false)
    }
  }
  return (
    <Screen>
      <View style={styles.center}>
        <Card>
          <Text style={styles.title}>
            {step === 'name' ? 'What is your name?' : 'Choose your photo'}
          </Text>
          <Text style={styles.subtitle}>
            {step === 'name'
              ? 'Add the name your teams will recognize.'
              : 'Choose a sports picture or add one from your photo album.'}
          </Text>
          {step === 'name' ? (
            <>
              <TextInput
                accessibilityLabel="Name"
                placeholder="Name"
                autoFocus
                value={name}
                onChangeText={setName}
                maxLength={120}
                style={styles.input}
              />
              <Button
                label="Continue"
                block
                busy={busy}
                disabled={name.trim() === ''}
                onPress={() => {
                  saveName().catch(() => undefined)
                }}
              />
            </>
          ) : (
            <>
              <PhotoGrid
                entries={pictures}
                selectedId={catalogId}
                onSelect={id => {
                  setCatalogId(id)
                  setImage(undefined)
                }}
                onUpload={() => {
                  upload().catch(() => undefined)
                }}
              />
              {image != null && (
                <Image
                  accessibilityLabel="Selected profile photo"
                  source={{
                    uri: `data:${image.contentType};base64,${image.base64}`
                  }}
                  style={styles.preview}
                />
              )}
              {catalogError !== '' && (
                <>
                  <Text style={styles.error}>{catalogError}</Text>
                  <Button
                    label="Retry pictures"
                    kind="text"
                    onPress={() => {
                      loadPictures().catch(() => undefined)
                    }}
                  />
                </>
              )}
              <Button
                label="Continue"
                block
                busy={busy}
                disabled={image == null && catalogId == null}
                onPress={() => {
                  complete().catch(() => undefined)
                }}
              />
              <Button
                label="Use my initials"
                kind="text"
                disabled={busy}
                onPress={() => {
                  complete(true).catch(() => undefined)
                }}
              />
            </>
          )}
          {error !== '' && (
            <Text accessibilityLiveRegion="polite" style={styles.error}>
              {error}
            </Text>
          )}
        </Card>
      </View>
    </Screen>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  center: {
    width: '100%' as const,
    maxWidth: 470,
    alignSelf: 'center' as const,
    marginTop: 24
  },
  title: {
    fontSize: 24,
    fontWeight: '600' as const,
    color: theme.primaryTextColor,
    marginBottom: 12
  },
  subtitle: {
    fontSize: 15,
    color: theme.secondaryTextColor,
    marginBottom: 20,
    lineHeight: 22
  },
  input: {
    fontSize: 18,
    color: theme.inputTextColor,
    borderWidth: 1,
    borderColor: theme.inputBorderColor,
    backgroundColor: theme.inputBackgroundColor,
    borderRadius: 12,
    padding: 14,
    marginBottom: 20
  },
  error: { color: theme.dangerColor, marginTop: 12 },
  preview: {
    width: 96,
    height: 96,
    alignSelf: 'center' as const,
    marginVertical: 12
  }
}))
