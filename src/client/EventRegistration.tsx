import React, { useState } from 'react'
import type { ImageStyle } from 'react-native'
import {
  Image,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View
} from 'react-native'
import { useNavigate } from 'react-router-dom'

const EventRegistration: React.FC = () => {
  const [eventId, setEventId] = useState('')
  const navigate = useNavigate()

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
          source={{ uri: '/assets/images/edge_logo.png' }}
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
          placeholderTextColor="#999"
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

const styles = StyleSheet.create({
  container: {
    flex: 1,
    minHeight: 600,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#667eea'
  },
  card: {
    alignItems: 'center',
    padding: 32,
    backgroundColor: 'white',
    borderRadius: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 20 },
    shadowOpacity: 0.1,
    shadowRadius: 25,
    elevation: 10,
    width: '90%',
    maxWidth: 500
  },
  logo: {
    height: 64,
    width: 200,
    marginBottom: 24
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: '#333',
    marginBottom: 16
  },
  description: {
    fontSize: 16,
    color: '#666',
    textAlign: 'center',
    marginBottom: 24,
    lineHeight: 24
  },
  input: {
    width: '100%',
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: '#ddd',
    fontSize: 16,
    marginBottom: 16,
    backgroundColor: '#f9f9f9',
    color: '#333'
  },
  button: {
    width: '100%',
    paddingVertical: 14,
    paddingHorizontal: 24,
    borderRadius: 8,
    backgroundColor: '#667eea',
    marginBottom: 12,
    alignItems: 'center'
  },
  continueButton: {
    backgroundColor: '#22c55e'
  },
  buttonText: {
    color: 'white',
    fontWeight: '600',
    fontSize: 16
  }
})

export default EventRegistration
