import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Pressable, Text, View } from 'react-native'

import type { Page, TeamStationClient } from '../../common/api'
import { HttpError } from '../../common/errors'
import type { GroupRef } from '../../common/groupCreation'
import {
  isSchedulingNews,
  type Notification,
  RECORDING_UPLOAD
} from '../../common/notifications'
import { Button, Card, Screen } from '../components'
import { PagedList } from '../components/PagedList'
import { PagedListEnd } from '../components/PagedListEnd'
import { useForegroundRefresh } from '../hooks/useForegroundRefresh'
import { useLatestRequest } from '../hooks/useLatestRequest'
import { type PagedRows, usePagedList } from '../hooks/usePagedList'
import { useStableCallback } from '../hooks/useStableCallback'
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

/** A reminder to upload a phone's recording of one camera angle. */
const isReminder = (item: Notification): boolean =>
  item.type === RECORDING_UPLOAD

type Mode = 'pending' | 'sent' | 'history'

/** A row's height before it has been measured. */
const ROW_HEIGHT = 340

/** An inbox page has only a next cursor, and nothing else a list's has. */
const NOTHING: Page<Notification> = {
  items: [],
  nextCursor: null,
  prevCursor: null,
  anchorId: null,
  counts: null
}

const requestIdOf = (item: Notification): string => item.requestId

const failureOf = (error: unknown, otherwise: string): string =>
  error instanceof Error ? error.message : otherwise

/** The approval being decided on its card, and how. */
interface Deciding {
  id: string
  action: 'accept' | 'decline'
}

export function NotificationsScreen({
  client,
  onOpen,
  onOpenTarget,
  onUpload,
  onDismissed,
  onDecided
}: {
  client: TeamStationClient
  onOpen: (id: string) => void
  /**
   * A scheduling notice opens what it names: a venue, a game, a league's
   * Auto-Scheduler or a season. It is marked read first.
   */
  onOpenTarget?: (notice: Notification) => void
  /** Opens the reminder's game on its Videos tab, where Upload Recording is. */
  onUpload?: (gameId: string) => void
  /** A reminder was dismissed, so the header's pending dot is asked again. */
  onDismissed?: () => void
  /**
   * An approval was accepted or rejected on its card: what the person may do
   * and the header's pending dot are asked again. The list stays.
   */
  onDecided?: () => void
}): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  const [mode, setMode] = useState<Mode>('pending')
  const [error, setError] = useState('')
  const [dismissing, setDismissing] = useState<string | undefined>()
  const [deciding, setDeciding] = useState<Deciding | undefined>()
  const read = async (
    which: Mode,
    cursor: string | null
  ): Promise<Page<Notification>> => {
    try {
      const page = await client.notifications({
        history: which === 'history',
        sent: which === 'sent',
        ...(cursor == null ? {} : { cursor })
      })
      setError('')
      return { ...NOTHING, items: page.items, nextCursor: page.nextCursor }
    } catch (caught) {
      // Whatever each list held is no longer theirs to see.
      if (accessRefused(caught)) {
        setError(failureOf(caught, 'Notifications could not load. Retry.'))
        for (const list of Object.values(lists))
          list.apply(NOTHING).catch(() => undefined)
      }
      throw caught
    }
  }
  // Each holds its own pages, for coming back to as they were.
  const lists: Record<Mode, PagedRows<Notification>> = {
    pending: useInbox('pending', read),
    sent: useInbox('sent', read),
    history: useInbox('history', read)
  }
  const list = lists[mode]
  const { rows, refreshHeld: load, loadMore } = list
  useForegroundRefresh(load)
  /** Gone from every list. History reads it again from the server. */
  const settled = (item: Notification): void => {
    for (const held of Object.values(lists)) held.remove(item.requestId)
  }
  /** Settles a reminder for good: it leaves Pending and moves to History. */
  const dismiss = useStableCallback(
    async (item: Notification): Promise<void> => {
      if (dismissing != null) return
      setDismissing(item.requestId)
      setError('')
      try {
        await client.dismissNotification(item.requestId)
        settled(item)
        onDismissed?.()
      } catch (error) {
        setError(
          failureOf(error, 'The reminder could not be dismissed. Retry.')
        )
      } finally {
        setDismissing(undefined)
      }
    }
  )
  /**
   * Accepts or rejects an approval on its card. Decided, it leaves Pending,
   * and History reads it again from the server; refused, the card stays with
   * the reason, to be pressed again.
   */
  const decide = useStableCallback(
    async (item: Notification, action: Deciding['action']): Promise<void> => {
      if (deciding != null) return
      setDeciding({ id: item.requestId, action })
      setError('')
      try {
        if (item.type === 'game')
          await client.decideGameRequest(item.requestId, action)
        else await client.decideRelationship(item.requestId, action)
        settled(item)
        onDecided?.()
      } catch (error) {
        setError(failureOf(error, 'The request could not be decided. Retry.'))
      } finally {
        setDeciding(undefined)
      }
    }
  )
  const upload = useStableCallback((item: Notification): void => {
    if (item.gameId != null) onUpload?.(item.gameId)
  })
  const open = useStableCallback((item: Notification): void => {
    if (onOpenTarget != null && isSchedulingNews(item.type)) {
      client.viewNotification(item.id).catch(() => undefined)
      onOpenTarget(item)
    } else onOpen(item.requestId)
  })
  // Pending reminders come before anything waiting on an approval.
  const shown = useMemo(
    () =>
      mode === 'pending'
        ? [
            ...rows.filter(isReminder),
            ...rows.filter(item => !isReminder(item))
          ]
        : rows,
    [mode, rows]
  )
  const renderRow = useCallback(
    (item: Notification) => (
      <View style={styles.row} testID={`notification-row-${item.requestId}`}>
        <NotificationRow
          item={item}
          mode={mode}
          dismissing={dismissing}
          deciding={deciding}
          onUpload={upload}
          onDismiss={dismiss}
          onDecide={decide}
          onOpen={open}
        />
      </View>
    ),
    [decide, deciding, dismiss, dismissing, mode, open, styles.row, upload]
  )
  const extraData = useMemo(
    () => ({ mode, dismissing, deciding }),
    [deciding, dismissing, mode]
  )
  const shownError =
    error !== '' || list.error == null
      ? error
      : failureOf(list.error, 'Notifications could not load. Retry.')
  return (
    <Screen pagedList>
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
              }}
            />
          ))}
        </View>
        <Text style={styles.hint}>
          Oldest first. Any eligible administrator can answer on behalf of their
          team, season or league.
        </Text>
        {list.loading && <Text style={styles.hint}>Loading…</Text>}
        {shownError !== '' && (
          <>
            <Text accessibilityRole="alert" style={styles.error}>
              {shownError}
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
        <PagedList
          key={mode}
          data={shown}
          keyOf={requestIdOf}
          renderItem={renderRow}
          extraData={extraData}
          estimatedItemSize={ROW_HEIGHT}
          empty={
            list.empty && shownError === '' ? (
              <Text style={styles.hint}>
                {mode === 'pending'
                  ? 'No approvals are waiting for you.'
                  : mode === 'sent'
                    ? 'No sent invitations are waiting for approval.'
                    : 'No resolved notifications yet.'}
              </Text>
            ) : null
          }
          footer={<PagedListEnd list={list} />}
          onEndReached={() => {
            loadMore().catch(() => undefined)
          }}
        />
      </View>
    </Screen>
  )
}

/** One mode's list, read when the screen asks. */
function useInbox(
  mode: Mode,
  read: (mode: Mode, cursor: string | null) => Promise<Page<Notification>>
): PagedRows<Notification> {
  return usePagedList<Notification>({
    listKey: mode,
    auto: false,
    keyOf: requestIdOf,
    read: async cursor => await read(mode, cursor)
  })
}

/** A notification as its mode shows it, and what can be done with it there. */
function NotificationRow(props: {
  item: Notification
  mode: Mode
  dismissing: string | undefined
  deciding: Deciding | undefined
  onUpload: (item: Notification) => void
  onDismiss: (item: Notification) => Promise<void>
  onDecide: (item: Notification, action: Deciding['action']) => Promise<void>
  onOpen: (item: Notification) => void
}): React.ReactElement {
  const { item, mode, dismissing, deciding } = props
  const { onUpload: upload, onDismiss: dismiss, onDecide: decide } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  if (mode === 'pending' && isReminder(item))
    return (
      <Card style={styles.card}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${item.title}. ${item.description}`}
          style={styles.cardBody}
          onPress={() => {
            upload(item)
          }}
        >
          <Text style={styles.hint}>{inviteDate(item.sentAt)}</Text>
          <Text style={styles.name}>{item.title}</Text>
          <Text style={styles.hint}>{item.description}</Text>
        </Pressable>
        <Text style={styles.status}>{statusLine(item, mode)}</Text>
        <View style={styles.tabs}>
          {item.gameId != null && (
            <Button
              compact
              label="Upload"
              onPress={() => {
                upload(item)
              }}
            />
          )}
          <Button
            compact
            kind="secondary"
            label="Dismiss"
            busy={dismissing === item.requestId}
            disabled={dismissing != null}
            onPress={() => {
              dismiss(item).catch(() => undefined)
            }}
          />
        </View>
      </Card>
    )
  // A player taken off the team by their side: read, and dismissed.
  if (mode === 'pending' && item.type === 'playerAddRejected')
    return (
      <Card style={styles.card}>
        <Text style={styles.hint}>{inviteDate(item.sentAt)}</Text>
        <Text style={styles.name}>{item.title}</Text>
        <Text style={styles.hint}>{item.description}</Text>
        <View style={styles.tabs}>
          <Button
            compact
            kind="secondary"
            label="Dismiss"
            accessibilityLabel={`Dismiss ${item.title}`}
            busy={dismissing === item.requestId}
            disabled={dismissing != null}
            onPress={() => {
              dismiss(item).catch(() => undefined)
            }}
          />
        </View>
      </Card>
    )
  // A change already made, which may be rejected for its 90 days: Reject
  // undoes it, Dismiss only moves it to History.
  if (mode !== 'sent' && item.canReject === true)
    return (
      <Card style={styles.card}>
        <Text style={styles.hint}>{inviteDate(item.sentAt)}</Text>
        <Text style={styles.name}>{item.title}</Text>
        <Text style={styles.hint}>{item.description}</Text>
        <Text style={styles.status}>{statusLine(item, mode)}</Text>
        <View style={styles.tabs}>
          <Button
            compact
            label="Reject"
            accessibilityLabel={`Reject ${item.title}`}
            testID="notification-reject"
            color={theme.dangerColor}
            textColor={theme.buttonTextColor}
            busy={
              deciding?.id === item.requestId && deciding.action === 'decline'
            }
            disabled={deciding != null}
            onPress={() => {
              decide(item, 'decline').catch(() => undefined)
            }}
          />
          {mode === 'pending' && (
            <Button
              compact
              kind="secondary"
              label="Dismiss"
              accessibilityLabel={`Dismiss ${item.title}`}
              busy={dismissing === item.requestId}
              disabled={dismissing != null}
              onPress={() => {
                dismiss(item).catch(() => undefined)
              }}
            />
          )}
        </View>
      </Card>
    )
  // Decided here, on the card: the list stays on Notifications.
  if (mode === 'pending' && item.canAct)
    return (
      <Card style={styles.card}>
        <Text style={styles.hint}>{inviteDate(item.sentAt)}</Text>
        <Text style={styles.name}>{item.title}</Text>
        <Text style={styles.hint}>{item.description}</Text>
        <Text style={styles.status}>{statusLine(item, mode)}</Text>
        <View style={styles.tabs}>
          <Button
            compact
            label="Accept"
            accessibilityLabel={`Accept ${item.title}`}
            testID="notification-accept"
            color={theme.successColor}
            textColor={theme.buttonTextColor}
            busy={
              deciding?.id === item.requestId && deciding.action === 'accept'
            }
            disabled={deciding != null}
            onPress={() => {
              decide(item, 'accept').catch(() => undefined)
            }}
          />
          <Button
            compact
            label="Reject"
            accessibilityLabel={`Reject ${item.title}`}
            testID="notification-reject"
            color={theme.dangerColor}
            textColor={theme.buttonTextColor}
            busy={
              deciding?.id === item.requestId && deciding.action === 'decline'
            }
            disabled={deciding != null}
            onPress={() => {
              decide(item, 'decline').catch(() => undefined)
            }}
          />
        </View>
      </Card>
    )
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={item.title}
      onPress={() => {
        props.onOpen(item)
      }}
    >
      <Card style={styles.card}>
        <Text style={styles.hint}>{inviteDate(item.sentAt)}</Text>
        <Text style={styles.name}>{item.title}</Text>
        <Text style={styles.hint}>{item.description}</Text>
        <Text style={styles.status}>{statusLine(item, mode)}</Text>
      </Card>
    </Pressable>
  )
}

/**
 * What a notification's state is, in a word or two. Somebody being added to
 * a group needed nobody's approval: it is new until opened, then added.
 */
function statusLine(item: Notification, mode: Mode): string {
  if (item.type === 'grant') return item.viewed ? 'Added' : 'New'
  if (isReminder(item)) return 'Reminder'
  if (item.status === 'applied')
    return item.canReject === true && item.rejectUntil != null
      ? `You can reject this until ${inviteDate(item.rejectUntil)}.`
      : `Added on ${inviteDate(item.sentAt)}.`
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
  /** A reminder's Upload: opens its game on the Videos tab. */
  onUpload?: (gameId: string) => void
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
  onChanged,
  onUpload
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
        ) : isReminder(item) ? (
          <>
            <Text style={styles.hint}>{inviteDate(item.sentAt)}</Text>
            <Text style={styles.title}>{item.title}</Text>
            <Text style={styles.hint}>{item.description}</Text>
            <Text style={styles.status}>Reminder</Text>
            {item.gameId != null && (
              <Button
                label="Upload"
                onPress={() => {
                  if (item.gameId != null) onUpload?.(item.gameId)
                }}
              />
            )}
          </>
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
  card: { gap: theme.rem(0.75) },
  cardBody: { gap: theme.rem(0.75) },
  // A list's rows are placed one by one, so its gap is on each of them.
  row: { paddingBottom: theme.rem(1) }
}))
