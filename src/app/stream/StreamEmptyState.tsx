import React, { useEffect, useRef, useState } from 'react'
import { Text, View } from 'react-native'

import type { StreamAccess, TeamStationClient } from '../../common/api'
import { Icon } from '../components/Icon'
import { lstrings } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { StreamPill } from './StreamPill'

/** A fresh key for one ask to film. */
const askKey = (): string =>
  `videographer-${Date.now()}-${Math.random().toString(36).slice(2)}`

export interface StreamEmptyStateProps {
  client: TeamStationClient
  /** Null when `streamAccess` failed, or nobody is signed in: no action. */
  access: StreamAccess | null
  onRecord: () => void
  /** The request to film went: `access` should say so from here on. */
  onRequested: () => void
}

/**
 * The Videos tab of a game with no videos and no cameras: the camera icon and
 * "No videos", with Record Video for somebody who can film, or Request access
 * for a team member who cannot, which goes to the people who can approve it.
 */
export function StreamEmptyState(
  props: StreamEmptyStateProps
): React.ReactElement {
  const { client, access, onRecord, onRequested } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  /**
   * One key per ask: a tap whose send failed is retried under the same key,
   * so the server answers that ask once, as the request route's retry key
   * promises. That holds whatever the server also does to find a request
   * already waiting, which is its own rule and could change. The ask is over
   * once the server has it waiting, whether its answer came or was lost; from
   * then on the next tap is a new ask, which the server would otherwise answer
   * with the old one once a coach declined it.
   */
  const key = useRef<string | undefined>(undefined)
  const asked = access?.requested === true
  useEffect(() => {
    if (asked) key.current = undefined
    // Whichever way it moved, what the last send said is out of date.
    setError(undefined)
  }, [asked])

  /**
   * Sends the ask under its key. A key whose answer was lost and whose request
   * a coach has since decided gets that request back, neither waiting nor
   * approved: the ask is over, and it is sent once more under a fresh key.
   */
  const ask = async (teamId: string): Promise<void> => {
    for (let tries = 0; tries < 2; tries += 1) {
      key.current ??= askKey()
      const answer = await client.inviteRelationship({
        kind: 'videographer',
        teamId,
        idempotencyKey: key.current
      })
      key.current = undefined
      if (answer.status === 'pending' || answer.status === 'accepted') return
    }
  }

  const request = (teamId: string): void => {
    if (busy) return
    setBusy(true)
    setError(undefined)
    ask(teamId).then(
      () => {
        setBusy(false)
        onRequested()
      },
      (caught: unknown) => {
        setBusy(false)
        setError(
          caught instanceof Error ? caught.message : lstrings.common_retry
        )
      }
    )
  }

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
          {error != null && !asked && <Text style={styles.error}>{error}</Text>}
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
