import React, { useState } from 'react'
import type { ImageStyle } from 'react-native'
import { Image, Pressable, Text, TextInput, View } from 'react-native'
import { useParams } from 'react-router-dom'

import { cacheStyles, useTheme } from './ThemeContext'
import type { Theme } from './types'

const EventLinks: React.FC = () => {
  const { eventId } = useParams<{ eventId: string }>()
  const [copiedDashboard, setCopiedDashboard] = useState(false)
  const [copiedScoreboard, setCopiedScoreboard] = useState(false)
  const theme = useTheme()
  const styles = getStyles(theme)

  const dashboardLink = `${window.location.origin}/dashboard/${eventId ?? ''}`
  const scoreboardLink = `${window.location.origin}/scoreboard/${eventId ?? ''}`

  const copyToClipboard = async (
    text: string,
    type: 'dashboard' | 'scoreboard'
  ): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      if (type === 'dashboard') {
        setCopiedDashboard(true)
        setTimeout(() => {
          setCopiedDashboard(false)
        }, 2000)
      } else {
        setCopiedScoreboard(true)
        setTimeout(() => {
          setCopiedScoreboard(false)
        }, 2000)
      }
    } catch (err) {
      console.error('Failed to copy:', err)
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

        <Text style={styles.title}>Event Links</Text>

        <Text style={styles.eventIdText}>Event ID: {eventId}</Text>

        <View style={styles.linkSection}>
          <Text style={styles.linkLabel}>Dashboard Link:</Text>
          <View style={styles.linkRow}>
            <TextInput
              style={styles.linkInput}
              value={dashboardLink}
              editable={false}
              selectTextOnFocus
            />
            <Pressable
              style={styles.copyButton}
              onPress={() => {
                copyToClipboard(dashboardLink, 'dashboard').catch(
                  (err: unknown) => {
                    console.error('Failed to copy:', err)
                  }
                )
              }}
            >
              <Text style={styles.copyButtonText}>
                {copiedDashboard ? '✓' : 'Copy'}
              </Text>
            </Pressable>
          </View>
        </View>

        <View style={styles.linkSection}>
          <Text style={styles.linkLabel}>Scoreboard Link:</Text>
          <View style={styles.linkRow}>
            <TextInput
              style={styles.linkInput}
              value={scoreboardLink}
              editable={false}
              selectTextOnFocus
            />
            <Pressable
              style={styles.copyButton}
              onPress={() => {
                copyToClipboard(scoreboardLink, 'scoreboard').catch(
                  (err: unknown) => {
                    console.error('Failed to copy:', err)
                  }
                )
              }}
            >
              <Text style={styles.copyButtonText}>
                {copiedScoreboard ? '✓' : 'Copy'}
              </Text>
            </Pressable>
          </View>
        </View>

        <View style={styles.buttonRow}>
          <Pressable
            style={[styles.navButton, styles.dashboardButton]}
            onPress={() => {
              window.location.href = dashboardLink
            }}
          >
            <Text style={styles.navButtonText}>Go to Dashboard</Text>
          </Pressable>

          <Pressable
            style={[styles.navButton, styles.scoreboardButton]}
            onPress={() => {
              window.location.href = scoreboardLink
            }}
          >
            <Text style={styles.navButtonText}>Go to Scoreboard</Text>
          </Pressable>
        </View>
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
    backgroundColor: theme.primaryButtonColor
  },
  card: {
    alignItems: 'center',
    padding: 32,
    backgroundColor: theme.cardBackgroundColor,
    borderRadius: 16,
    shadowColor: theme.shadowColor,
    shadowOffset: { width: 0, height: 20 },
    shadowOpacity: 0.1,
    shadowRadius: 25,
    elevation: 10,
    width: '90%',
    maxWidth: 600
  },
  logo: {
    height: 64,
    width: 200,
    marginBottom: 24
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    fontFamily: theme.boldTextFont,
    color: theme.secondaryTextColor,
    marginBottom: 16
  },
  eventIdText: {
    fontSize: 18,
    color: theme.primaryButtonColor,
    fontWeight: '600',
    fontFamily: theme.semiBoldTextFont,
    marginBottom: 24
  },
  linkSection: {
    width: '100%',
    marginBottom: 20
  },
  linkLabel: {
    fontSize: 16,
    fontWeight: '600',
    fontFamily: theme.semiBoldTextFont,
    color: theme.secondaryTextColor,
    marginBottom: 8
  },
  linkRow: {
    flexDirection: 'row',
    width: '100%',
    gap: 8
  },
  linkInput: {
    flex: 1,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: theme.inputBorderColor,
    fontSize: 14,
    backgroundColor: theme.inputBackgroundColor,
    color: theme.inputTextColor
  },
  copyButton: {
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 8,
    backgroundColor: theme.primaryButtonColor,
    alignItems: 'center',
    justifyContent: 'center'
  },
  copyButtonText: {
    color: theme.buttonTextColor,
    fontWeight: '600',
    fontFamily: theme.semiBoldTextFont,
    fontSize: 14
  },
  buttonRow: {
    flexDirection: 'row',
    width: '100%',
    gap: 12,
    marginTop: 12
  },
  navButton: {
    flex: 1,
    paddingVertical: 14,
    paddingHorizontal: 24,
    borderRadius: 8,
    alignItems: 'center'
  },
  dashboardButton: {
    backgroundColor: theme.primaryButtonColor
  },
  scoreboardButton: {
    backgroundColor: theme.secondaryButtonColor
  },
  navButtonText: {
    color: theme.buttonTextColor,
    fontWeight: '600',
    fontFamily: theme.semiBoldTextFont,
    fontSize: 16
  }
}))

export default EventLinks
