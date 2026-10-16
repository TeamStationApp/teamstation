import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Pressable, Text, View } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import { HttpError } from '../../common/errors'
import type { GroupRef } from '../../common/groupCreation'
import type { Notification } from '../../common/notifications'
import { Button, Card, Screen } from '../components'
import { useForegroundRefresh } from '../hooks/useForegroundRefresh'
import { useLatestRequest } from '../hooks/useLatestRequest'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

function accessRefused(error: unknown): boolean {
  return (
    error instanceof HttpError &&
    ['unauthorized', 'forbidden', 'notFound'].includes(error.code)
  )
}

const inviteDate = (time: string): string =>
  new Date(time).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })

export function NotificationsScreen({
  client,
  onOpen
}: {
  client: TeamStationClient
  onOpen: (id: string) => void
}): React.ReactElement {
  const styles = getStyles(useTheme())
  const [mode, setMode] = useState<'pending' | 'sent' | 'history'>('pending')
  const [items, setItems] = useState<Notification[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const begin = useLatestRequest()
  const cache = useRef<
    Partial<
      Record<
        typeof mode,
        { items: Notification[]; cursor: string | null; pages: number }
      >
    >
  >({})
  const load = useCallback(async (): Promise<void> => {
    const current = begin()
    try {
      const wantedPages = cache.current[mode]?.pages ?? 1
      const found = new Map<string, Notification>()
      let next: string | null = null
      let pages = 0
      do {
        const page = await client.notifications({
          history: mode === 'history',
          sent: mode === 'sent',
          ...(next == null ? {} : { cursor: next })
        })
        if (!current()) return
        for (const item of page.items) found.set(item.requestId, item)
        next = page.nextCursor
        pages++
      } while (pages < wantedPages && next != null)
      if (!current()) return
      const refreshed = [...found.values()]
      setItems(refreshed)
      setCursor(next)
      cache.current[mode] = { items: refreshed, cursor: next, pages }
      setError('')
    } catch (error) {
      if (!current()) return
      if (accessRefused(error)) cache.current = {}
      setItems(cache.current[mode]?.items ?? [])
      setCursor(cache.current[mode]?.cursor ?? null)
      setError(
        error instanceof Error
          ? error.message
          : 'Notifications could not load. Retry.'
      )
    } finally {
      if (current()) setLoading(false)
    }
  }, [client, mode, begin])
  useForegroundRefresh(load)
  const more = async (): Promise<void> => {
    if (cursor == null) return
    const current = begin()
    try {
      const page = await client.notifications({
        history: mode === 'history',
        sent: mode === 'sent',
        cursor
      })
      if (!current()) return
      setItems(previous => {
        const merged = [
          ...new Map(
            [...previous, ...page.items].map(item => [item.requestId, item])
          ).values()
        ]
        cache.current[mode] = {
          items: merged,
          cursor: page.nextCursor,
          pages: (cache.current[mode]?.pages ?? 1) + 1
        }
        return merged
      })
      setCursor(page.nextCursor)
      setError('')
    } catch (error) {
      if (!current()) return
      if (accessRefused(error)) {
        cache.current = {}
        setItems([])
        setCursor(null)
      }
      setError(
        error instanceof Error
          ? error.message
          : 'More notifications could not load. Retry.'
      )
    }
  }
  return (
    <Screen>
      <View style={styles.page}>
        <Text style={styles.title}>Notifications</Text>
        <View style={styles.tabs}>
          {(['pending', 'sent', 'history'] as const).map(value => (
            <Button
              key={value}
              compact
              kind={mode === value ? 'primary' : 'secondary'}
              label={value[0].toUpperCase() + value.slice(1)}
              onPress={() => {
                setMode(value)
                setItems(cache.current[value]?.items ?? [])
                setCursor(cache.current[value]?.cursor ?? null)
              }}
            />
          ))}
        </View>
        <Text style={styles.hint}>
          Oldest first. Any eligible administrator can answer on behalf of their
          team, season or league.
        </Text>
        {loading && <Text style={styles.hint}>Loading…</Text>}
        {error !== '' && (
          <>
            <Text accessibilityRole="alert" style={styles.error}>
              {error}
            </Text>
            <Button
              label="Retry notifications"
              kind="secondary"
              onPress={() => {
                load().catch(() => undefined)
              }}
            />
          </>
        )}
        {!loading && error === '' && items.length === 0 && (
          <Text style={styles.hint}>
            {mode === 'pending'
              ? 'No approvals are waiting for you.'
              : mode === 'sent'
                ? 'No sent invitations are waiting for approval.'
                : 'No resolved notifications yet.'}
          </Text>
        )}
        {items.map(item => (
          <Pressable
            key={item.requestId}
            accessibilityRole="button"
            accessibilityLabel={item.title}
            onPress={() => {
              onOpen(item.requestId)
            }}
          >
            <Card style={styles.card}>
              <Text style={styles.hint}>{inviteDate(item.sentAt)}</Text>
              <Text style={styles.name}>{item.title}</Text>
              <Text style={styles.hint}>{item.description}</Text>
              <Text style={styles.status}>{statusLine(item, mode)}</Text>
            </Card>
          </Pressable>
        ))}
        {cursor != null && (
          <Button
            label="Load more"
            kind="secondary"
            onPress={() => {
              more().catch(() => undefined)
            }}
          />
        )}
      </View>
    </Screen>
  )
}

/**
 * What a notification's state is, in a word or two. Somebody being added to
 * a group needed nobody's approval: it is new until opened, then added.
 */
function statusLine(
  item: Notification,
  mode: 'pending' | 'sent' | 'history'
): string {
  if (item.type === 'grant') return item.viewed ? 'Added' : 'New'
  if (item.status === 'pending')
    return mode === 'sent' ? 'Awaiting approval' : 'Needs your approval'
  return item.status[0].toUpperCase() + item.status.slice(1)
}

interface DetailProps {
  client: TeamStationClient
  id: string
  onChanged: (
    replacementId?: string,
    completion?: { gameId?: string; source?: GroupRef; notice: string }
  ) => void
}

/** A different route owns a different cache and decision state. */
export function NotificationDetailScreen(
  props: DetailProps
): React.ReactElement {
  return <NotificationDetail key={props.id} {...props} />
}

function NotificationDetail({
  client,
  id,
  onChanged
}: DetailProps): React.ReactElement {
  const styles = getStyles(useTheme())
  const [item, setItem] = useState<Notification | undefined>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [readUnavailable, setReadUnavailable] = useState(false)
  /** The group just left from here, said once it is done. */
  const [left, setLeft] = useState<string | undefined>()
  const begin = useLatestRequest()
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const resendKey = useRef<{ id: string; key: string } | undefined>(undefined)
  const load = useCallback(async (): Promise<void> => {
    const current = begin()
    try {
      const found = await client.notification(id)
      if (!current()) return
      setItem(found)
      setError('')
      setReadUnavailable(false)
    } catch (error) {
      if (!current()) return
      if (accessRefused(error)) setItem(undefined)
      setReadUnavailable(true)
      setError(
        error instanceof Error
          ? error.message
          : 'This invitation could not load. Retry.'
      )
    }
  }, [client, id, begin])
  useForegroundRefresh(load)
  useEffect(() => {
    client.viewNotification(id).catch(() => undefined)
  }, [client, id])
  const decide = async (
    action: 'accept' | 'decline' | 'withdraw' | 'resend'
  ): Promise<void> => {
    if (busy || readUnavailable || item?.requestId !== id) return
    setBusy(true)
    setError('')
    try {
      if (action === 'resend' && resendKey.current?.id !== id)
        resendKey.current = {
          id,
          key: `resend-${Date.now()}-${Math.random().toString(36).slice(2)}`
        }
      const key = action === 'resend' ? resendKey.current?.key : undefined
      const result =
        item?.type === 'game'
          ? await client.decideGameRequest(id, action, key)
          : await client.decideRelationship(id, action, key)
      if (!mounted.current) return
      if (action === 'resend') {
        resendKey.current = undefined
        onChanged(
          result.id,
          result.status !== 'accepted'
            ? undefined
            : {
                ...('gameId' in result && result.gameId != null
                  ? { gameId: result.gameId }
                  : {}),
                ...('source' in result ? { source: result.source } : {}),
                notice:
                  result.notice ??
                  (item.type === 'game' ? 'Game saved' : 'Connection saved')
              }
        )
      } else {
        await load()
        if (mounted.current) onChanged()
      }
    } catch (error) {
      if (mounted.current)
        setError(
          error instanceof Error
            ? error.message
            : 'The invitation could not be updated. Retry.'
        )
    } finally {
      if (mounted.current) setBusy(false)
    }
  }
  /** Leaves the team, season or league somebody was added to. */
  const leave = async (): Promise<void> => {
    const group = item?.leave
    if (busy || group == null) return
    setBusy(true)
    setError('')
    try {
      await client.leaveGroup(group.kind, group.id)
      if (!mounted.current) return
      setLeft(group.name)
      await load()
      if (mounted.current) onChanged()
    } catch (error) {
      if (mounted.current)
        setError(
          error instanceof Error ? error.message : 'You could not leave. Retry.'
        )
    } finally {
      if (mounted.current) setBusy(false)
    }
  }
  return (
    <Screen>
      <Card style={styles.card}>
        {item == null ? (
          <Text style={styles.hint}>Loading invitation…</Text>
        ) : (
          <>
            <Text style={styles.hint}>{inviteDate(item.sentAt)}</Text>
            <Text style={styles.title}>{item.title}</Text>
            <Text style={styles.hint}>{item.description}</Text>
            {readUnavailable && (
              <Text style={styles.hint}>
                Showing the saved invitation. Refresh before responding.
              </Text>
            )}
            <Text style={styles.status}>
              {item.type === 'grant'
                ? 'Added'
                : item.status[0].toUpperCase() + item.status.slice(1)}
            </Text>
            {item.leave != null && (
              <Button
                label={`Leave ${item.leave.name}`}
                kind="secondary"
                busy={busy}
                onPress={() => {
                  leave().catch(() => undefined)
                }}
              />
            )}
            {left != null && <Text style={styles.hint}>You left {left}.</Text>}
            {item.status === 'pending' && (
              <Text style={styles.hint}>
                Valid until {inviteDate(item.expiresAt)}. Opening this
                invitation does not approve it.
              </Text>
            )}
            {item.canAct && (
              <>
                <Button
                  label="Accept invitation"
                  busy={busy}
                  disabled={readUnavailable}
                  onPress={() => {
                    decide('accept').catch(() => undefined)
                  }}
                />
                <Button
                  label="Decline invitation"
                  kind="secondary"
                  disabled={busy || readUnavailable}
                  onPress={() => {
                    decide('decline').catch(() => undefined)
                  }}
                />
              </>
            )}
            {item.canWithdraw && (
              <Button
                label="Withdraw invitation"
                kind="secondary"
                disabled={busy || readUnavailable}
                onPress={() => {
                  decide('withdraw').catch(() => undefined)
                }}
              />
            )}
            {item.canResend && (
              <Button
                label="Submit again"
                kind="secondary"
                disabled={busy || readUnavailable}
                onPress={() => {
                  decide('resend').catch(() => undefined)
                }}
              />
            )}
          </>
        )}
        {error !== '' && (
          <>
            <Text accessibilityRole="alert" style={styles.error}>
              {error}
            </Text>
            <Button
              label="Retry invitation"
              kind="secondary"
              onPress={() => {
                load().catch(() => undefined)
              }}
            />
          </>
        )}
      </Card>
    </Screen>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  page: { gap: theme.rem(1) },
  title: {
    fontSize: theme.rem(1.5),
    color: theme.primaryTextColor,
    fontFamily: theme.semiBoldTextFont
  },
  name: {
    fontSize: theme.rem(1.125),
    color: theme.primaryTextColor,
    fontFamily: theme.semiBoldTextFont
  },
  hint: {
    fontSize: theme.rem(0.875),
    lineHeight: theme.rem(1.35),
    color: theme.secondaryTextColor
  },
  status: {
    fontSize: theme.rem(0.875),
    color: theme.primaryTextColor,
    fontFamily: theme.semiBoldTextFont
  },
  error: { fontSize: theme.rem(0.875), color: theme.dangerColor },
  tabs: {
    flexDirection: 'row' as const,
    flexWrap: 'wrap' as const,
    gap: theme.rem(0.5)
  },
  card: { gap: theme.rem(0.75) }
}))
