import React, { useRef, useState } from 'react'
import { Text, View } from 'react-native'

import type { StreamAccess, TeamStationClient } from '../../common/api'
import { Icon } from '../components/Icon'
import { lstrings } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { StreamPill } from './StreamPill'

export interface StreamEmptyStateProps {
  client: TeamStationClient
  /** Null when `streamAccess` failed, or nobody is signed in: no action. */
  access: StreamAccess | null
  onRecord: () => void
}

/**
 * The Videos tab of a game with no videos and no cameras: the camera icon and
 * "No videos", with Record Video for somebody who can film, or Request access
 * for a team member who cannot, which goes to the people who can approve it.
 */
export function StreamEmptyState(
  props: StreamEmptyStateProps
): React.ReactElement {
  const { client, access, onRecord } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const [requested, setRequested] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  /** One key for this ask, so a retry cannot leave two requests. */
  const key = useRef<string | undefined>(undefined)

  const request = (teamId: string): void => {
    if (busy) return
    key.current ??= `videographer-${Date.now()}-${Math.random().toString(36).slice(2)}`
    setBusy(true)
    setError(undefined)
    client
      .inviteRelationship({
        kind: 'videographer',
        teamId,
        idempotencyKey: key.current
      })
      .then(
        () => {
          setBusy(false)
          setRequested(true)
        },
        (caught: unknown) => {
          setBusy(false)
          setError(
            caught instanceof Error ? caught.message : lstrings.common_retry
          )
        }
      )
  }

  const asked = requested || access?.requested === true
  return (
    <View style={styles.empty} testID="stream-empty-state">
      <Icon name="videocam" size={4.5} color={theme.secondaryTextColor} />
      <Text style={styles.title}>{lstrings.stream_empty_title}</Text>
      {access?.canFilm === true && (
        <>
          <Text style={styles.detail}>{lstrings.stream_empty_can_film}</Text>
          <StreamPill
            label={lstrings.stream_record_video}
            testID="record-video"
            onPress={onRecord}
          />
        </>
      )}
      {access?.canFilm !== true && access?.canRequest === true && (
        <>
          <Text style={styles.detail}>{lstrings.stream_empty_can_request}</Text>
          <StreamPill
            label={
              asked
                ? lstrings.stream_request_sent
                : lstrings.stream_request_access
            }
            disabled={asked}
            busy={busy}
            testID="request-access"
            onPress={() => {
              request(access.teamId)
            }}
          />
          {error != null && <Text style={styles.error}>{error}</Text>}
        </>
      )}
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  empty: {
    alignItems: 'center',
    gap: theme.rem(theme.spaceMdRem),
    paddingTop: theme.rem(3),
    paddingBottom: theme.rem(2),
    paddingHorizontal: theme.rem(theme.spaceMdRem)
  },
  title: {
    fontFamily: theme.boldTextFont,
    fontSize: theme.rem(1.25),
    fontWeight: '700',
    color: theme.primaryTextColor,
    textAlign: 'center'
  },
  detail: {
    maxWidth: theme.rem(24),
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875),
    color: theme.secondaryTextColor,
    textAlign: 'center'
  },
  error: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875),
    color: theme.dangerColor,
    textAlign: 'center'
  }
}))
