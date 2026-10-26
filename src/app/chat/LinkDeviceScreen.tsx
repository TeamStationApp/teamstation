import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Text, View } from 'react-native'

import { HttpError } from '../../common/errors'
import { Button, Card, Screen } from '../components'
import { lstrings, sprintf } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import {
  type ChatKeysClient,
  ensureEnrolled,
  pollLink,
  reasonOf,
  resetIdentity,
  spacedCode,
  startLink
} from './engine/links'
import type { ChatKeyRecord, ChatKeyStore } from './keyRecord'
import { keyStore } from './keyStore'
import { thisDevice } from './thisDevice'

/** How often a waiting device asks whether it was approved. */
export const LINK_POLL_MS = 2000

export interface LinkDeviceScreenProps {
  client: ChatKeysClient
  userId: string
  /** This device's key store; the platform's own by default. */
  store?: ChatKeyStore
  /** How this device names itself; read from the platform by default. */
  device?: { name: string; platform: 'web' | 'ios' | 'android' }
  /** Linked, reset, or linked already: on to Chat devices. */
  onDone: () => void
  pollMs?: number
}

type Step =
  | { kind: 'loading' }
  | { kind: 'linked' }
  | { kind: 'code'; record: ChatKeyRecord; code: string }
  | { kind: 'expired'; record: ChatKeyRecord }
  | { kind: 'reset'; record: ChatKeyRecord; fromLink: boolean }
  | { kind: 'failed' }

/**
 * A new device, for a user who already uses chat elsewhere. It asks the
 * user's linked devices for the keys and shows six digits; the person
 * approves it on Chat devices of another device showing the same six. When
 * none of those can be reached, **I can't reach my other devices** leads to
 * a reset, after a warning; a user with no active device left goes straight
 * there.
 *
 * Kept through a change of user, it starts again for the one signed in now.
 */
export function LinkDeviceScreen(
  props: LinkDeviceScreenProps
): React.ReactElement {
  return <LinkDevice key={props.userId} {...props} />
}

/** A poll that failed this way may get through next time. */
const passing = (error: unknown): boolean =>
  error instanceof HttpError &&
  ['offline', 'unavailable', 'rateLimited'].includes(error.code)

function LinkDevice(props: LinkDeviceScreenProps): React.ReactElement {
  const { client, userId, onDone } = props
  const store = props.store ?? keyStore
  const pollMs = props.pollMs ?? LINK_POLL_MS
  const styles = getStyles(useTheme())
  const [step, setStep] = useState<Step>({ kind: 'loading' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [round, setRound] = useState(0)
  // The shell makes a new callback every render; the poll keeps its timer.
  const done = useRef(onDone)
  done.current = onDone
  const setup = useRef({
    client,
    store,
    userId,
    device: props.device ?? thisDevice()
  }).current

  const ask = useCallback(
    async (record: ChatKeyRecord): Promise<Step> => {
      try {
        const asked = await startLink(setup, record)
        return { kind: 'code', record: asked.record, code: asked.code }
      } catch (caught) {
        // The last linked device went while this one was asking.
        if (reasonOf(caught) === 'noLinkedDevice') {
          return { kind: 'reset', record, fromLink: false }
        }
        throw caught
      }
    },
    [setup]
  )

  useEffect(() => {
    let live = true
    ensureEnrolled(setup)
      .then(async (enrolment): Promise<Step> => {
        if (enrolment.state === 'ready') return { kind: 'linked' }
        // Gone since (signed out): nothing to ask for.
        if (!live) return { kind: 'loading' }
        if (enrolment.state === 'reset') {
          return { kind: 'reset', record: enrolment.record, fromLink: false }
        }
        return await ask(enrolment.record)
      })
      .then(next => {
        if (live) setStep(next)
      })
      .catch(() => {
        if (live) setStep({ kind: 'failed' })
      })
    return () => {
      live = false
    }
  }, [ask, round, setup])

  // While the code is up, ask now and then whether it was approved.
  useEffect(() => {
    if (step.kind !== 'code') return
    let live = true
    const timer = setInterval(() => {
      pollLink(setup, step.record)
        .then(polled => {
          if (!live) return
          if (polled.state === 'installed') {
            setStep({ kind: 'linked' })
            done.current()
          } else if (polled.state === 'expired') {
            setStep({ kind: 'expired', record: polled.record })
          }
        })
        .catch((caught: unknown) => {
          // Anything but a passing failure (an approved request whose keys
          // do not open on this device) would fail every time: it stops,
          // and Try again starts over from what the store holds.
          if (live && !passing(caught)) setStep({ kind: 'failed' })
        })
    }, pollMs)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [pollMs, setup, step])

  const run = (work: () => Promise<void>): void => {
    setBusy(true)
    setError(undefined)
    work()
      .catch(() => {
        setError(lstrings.chat_devices_failed)
      })
      .finally(() => {
        setBusy(false)
      })
  }

  if (step.kind === 'loading') {
    return (
      <Screen>
        <Text style={styles.muted}>{lstrings.common_loading}</Text>
      </Screen>
    )
  }
  if (step.kind === 'failed') {
    return (
      <Screen>
        <Text style={styles.error}>{lstrings.chat_devices_cannot_load}</Text>
        <Button
          label={lstrings.common_retry}
          kind="secondary"
          onPress={() => {
            setStep({ kind: 'loading' })
            setRound(current => current + 1)
          }}
        />
      </Screen>
    )
  }
  if (step.kind === 'linked') {
    return (
      <Screen>
        <Card style={styles.card}>
          <Text style={styles.heading}>{lstrings.chat_link_done}</Text>
          <Button
            label={lstrings.chat_link_open_devices}
            kind="primary"
            block
            onPress={onDone}
          />
        </Card>
      </Screen>
    )
  }
  if (step.kind === 'reset') {
    const { record, fromLink } = step
    return (
      <Screen>
        <Card style={styles.card}>
          <Text style={styles.heading}>{lstrings.chat_reset_title}</Text>
          {!fromLink && (
            <Text style={styles.body}>{lstrings.chat_reset_no_device}</Text>
          )}
          <Text style={styles.body}>{lstrings.chat_reset_detail}</Text>
          {error != null && <Text style={styles.error}>{error}</Text>}
          <Button
            label={lstrings.chat_reset_submit}
            kind="primary"
            block
            busy={busy}
            disabled={busy}
            onPress={() => {
              run(async () => {
                await resetIdentity(setup, record)
                onDone()
              })
            }}
          />
          {fromLink && (
            <Button
              label={lstrings.chat_reset_back}
              kind="text"
              block
              disabled={busy}
              onPress={() => {
                run(async () => {
                  setStep(await ask(record))
                })
              }}
            />
          )}
        </Card>
      </Screen>
    )
  }
  const record = step.record
  return (
    <Screen>
      <Card style={styles.card}>
        <Text style={styles.heading}>{lstrings.chat_link_title}</Text>
        <Text style={styles.body}>{lstrings.chat_link_detail}</Text>
        {step.kind === 'code' ? (
          <>
            <Text
              style={styles.code}
              accessibilityLabel={sprintf(
                lstrings.chat_link_code_label,
                step.code
              )}
            >
              {spacedCode(step.code)}
            </Text>
            <Text style={styles.muted}>{lstrings.chat_link_waiting}</Text>
          </>
        ) : (
          <View style={styles.expired}>
            <Text style={styles.body}>{lstrings.chat_link_expired}</Text>
            <Button
              label={lstrings.chat_link_again}
              kind="primary"
              block
              busy={busy}
              disabled={busy}
              onPress={() => {
                run(async () => {
                  setStep(await ask(record))
                })
              }}
            />
          </View>
        )}
        {error != null && <Text style={styles.error}>{error}</Text>}
        <Button
          label={lstrings.chat_link_cant_reach}
          kind="text"
          block
          disabled={busy}
          onPress={() => {
            setError(undefined)
            setStep({ kind: 'reset', record, fromLink: true })
          }}
        />
      </Card>
    </Screen>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  card: {
    gap: theme.rem(theme.spaceMdRem)
  },
  expired: {
    gap: theme.rem(theme.spaceSmRem)
  },
  heading: {
    fontFamily: theme.boldTextFont,
    fontSize: theme.rem(1.25),
    fontWeight: '700',
    color: theme.primaryTextColor
  },
  body: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.9375),
    color: theme.primaryTextColor
  },
  code: {
    fontFamily: theme.boldTextFont,
    fontSize: theme.rem(2.5),
    fontWeight: '700',
    letterSpacing: theme.rem(0.25),
    textAlign: 'center',
    color: theme.primaryTextColor
  },
  muted: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.9375),
    color: theme.secondaryTextColor
  },
  error: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875),
    color: theme.dangerColor
  }
}))
