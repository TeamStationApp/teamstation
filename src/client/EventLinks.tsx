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
          source={{ uri: '/assets/images/gs_logo.png' }}
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
    maxWidth: 600,
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
  eventIdText: {
    fontSize: theme.rem(1.25),
    color: theme.primaryButtonColor,
    fontWeight: '600',
    fontFamily: theme.semiBoldTextFont,
    marginBottom: theme.rem(1.5)
  },
  linkSection: {
    width: '100%',
    marginBottom: theme.rem(1.25)
  },
  linkLabel: {
    fontSize: theme.rem(1),
    fontWeight: '600',
    fontFamily: theme.semiBoldTextFont,
    color: theme.secondaryTextColor,
    marginBottom: theme.rem(0.5)
  },
  linkRow: {
    flexDirection: 'row',
    width: '100%',
    gap: theme.rem(0.5),
    alignItems: 'center'
  },
  linkInput: {
    flex: 1,
    minWidth: 0,
    flexShrink: 1,
    paddingVertical: theme.rem(0.75),
    paddingHorizontal: theme.rem(1),
    borderRadius: theme.rem(0.5),
    borderWidth: 2,
    borderColor: theme.inputBorderColor,
    fontSize: theme.rem(1),
    backgroundColor: theme.inputBackgroundColor,
    color: theme.inputTextColor
  },
  copyButton: {
    paddingVertical: theme.rem(0.75),
    paddingHorizontal: theme.rem(1.25),
    borderRadius: theme.rem(0.5),
    backgroundColor: theme.primaryButtonColor,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0
  },
  copyButtonText: {
    color: theme.buttonTextColor,
    fontWeight: '600',
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1)
  },
  buttonRow: {
    flexDirection: 'row',
    width: '100%',
    gap: theme.rem(0.75),
    marginTop: theme.rem(0.75)
  },
  navButton: {
    flex: 1,
    paddingVertical: theme.rem(1),
    paddingHorizontal: theme.rem(1.5),
    borderRadius: theme.rem(0.5),
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
    fontSize: theme.rem(1)
  }
}))

export default EventLinks
