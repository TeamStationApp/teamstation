import React, { useState } from 'react'
import type { ImageStyle } from 'react-native'
import { Image, Pressable, Text, TextInput, View } from 'react-native'
import { cacheStyles } from 'react-native-patina'
import { useNavigate } from 'react-router-dom'

import { useTheme } from './ThemeContext'
import type { Theme } from './types'

const EventRegistration: React.FC = () => {
  const [eventId, setEventId] = useState('')
  const navigate = useNavigate()
  const theme = useTheme()
  const styles = getStyles(theme)

  const generateEventId = (): void => {
    // Generate a random unique event ID
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
    let result = ''
    for (let i = 0; i < 12; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length))
    }
    setEventId(result)
  }

  const handleContinue = (): void => {
    if (eventId.trim() !== '') {
      const trimmedId = eventId.trim()
      const result = navigate(`/links/${trimmedId}`)
      if (result instanceof Promise) {
        result.catch((err: unknown) => {
          console.error('Navigation error:', err)
        })
      }
    }
  }

  return (
    <View style={styles.container}>
      <View style={styles.card}>
        <Image
          source={{ uri: '/assets/images/gs_logo.png' }}
          style={styles.logo as ImageStyle}
          resizeMode="contain"
        />

        <Text style={styles.title}>Register an Event</Text>

        <Text style={styles.description}>
          Pick a unique eventId that you can share with other users and devices.
          This should be unique and not easily guessable. Or tap Generate Event
          Id
        </Text>

        <TextInput
          style={styles.input}
          placeholder="Enter an Event ID"
          placeholderTextColor={theme.placeholderTextColor}
          value={eventId}
          onChangeText={setEventId}
        />

        <Pressable style={styles.button} onPress={generateEventId}>
          <Text style={styles.buttonText}>Generate Event ID</Text>
        </Pressable>

        <Pressable
          style={[styles.button, styles.continueButton]}
          onPress={handleContinue}
        >
          <Text style={styles.buttonText}>Continue</Text>
        </Pressable>
      </View>
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  container: {
    flex: 1,
    minHeight: 600,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.backgroundColor
  },
  card: {
    alignItems: 'center',
    padding: theme.rem(2),
    backgroundColor: theme.cardBackgroundColor,
    borderRadius: theme.rem(1),
    shadowColor: theme.shadowColor,
    shadowOffset: { width: 0, height: theme.rem(1.25) },
    shadowOpacity: 0.1,
    shadowRadius: theme.rem(1.5),
    elevation: 10,
    width: '90%',
    maxWidth: 500,
    marginTop: theme.rem(2)
  },
  logo: {
    height: theme.rem(4),
    width: theme.rem(12.5),
    marginBottom: theme.rem(1.5)
  },
  title: {
    fontSize: theme.rem(1.75),
    fontWeight: '700',
    fontFamily: theme.boldTextFont,
    color: theme.secondaryTextColor,
    marginBottom: theme.rem(1)
  },
  description: {
    fontSize: theme.rem(1),
    fontFamily: theme.regularTextFont,
    color: theme.tertiaryTextColor,
    textAlign: 'center',
    marginBottom: theme.rem(1.5),
    lineHeight: theme.rem(1.5)
  },
  input: {
    width: '100%',
    paddingVertical: theme.rem(1),
    paddingHorizontal: theme.rem(1),
    borderRadius: theme.rem(0.5),
    borderWidth: 2,
    borderColor: theme.inputBorderColor,
    fontSize: theme.rem(1),
    marginBottom: theme.rem(1),
    backgroundColor: theme.inputBackgroundColor,
    color: theme.inputTextColor
  },
  button: {
    width: '100%',
    paddingVertical: theme.rem(1),
    paddingHorizontal: theme.rem(1.5),
    borderRadius: theme.rem(0.5),
    backgroundColor: theme.primaryButtonColor,
    marginBottom: theme.rem(0.75),
    alignItems: 'center'
  },
  continueButton: {
    backgroundColor: theme.secondaryButtonColor
  },
  buttonText: {
    color: theme.buttonTextColor,
    fontWeight: '600',
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1)
  }
}))

export default EventRegistration
