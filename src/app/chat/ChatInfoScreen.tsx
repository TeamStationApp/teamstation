import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Pressable, type ScrollView, Text, View } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import { Badge, Button, Card, Icon, Screen } from '../components'
import { useBackOverride } from '../components/headerSlot'
import { lstrings, plural, sprintf } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { ChatAvatar } from './ChatAvatar'
import { conversationIdentity, memberIdentity } from './chatIdentityModel'
import {
  approvalsIn,
  conversationPill,
  conversationTitle,
  safetyGroups
} from './chatModel'
import { getChatStyles } from './chatStyles'
import type {
  ConversationView,
  GrantApproval,
  MemberView
} from './engine/engine'
import { SafetyNumberScreen } from './SafetyNumberScreen'
import type { ChatScreenEngine } from './screenEngine'

export interface ChatInfoScreenProps {
  engine: Pick<
    ChatScreenEngine,
    | 'open'
    | 'close'
    | 'view'
    | 'subscribe'
    | 'approvals'
    | 'approve'
    | 'fillGrants'
    | 'safetyNumber'
    | 'refresh'
    | 'setPreferences'
  >
  client: Pick<TeamStationClient, 'leaveDm'>
  conversationId: string
  /** The signed-in person. */
  userId: string
  /** Left the conversation (a DM): back to the list. */
  onLeft: () => void
  /** Legacy member links reveal the member section of the information page. */
  showMembers?: boolean
}

/** Conversation identity and personal mute, with existing member security access. */
export function ChatInfoScreen(props: ChatInfoScreenProps): React.ReactElement {
  const { engine, client, conversationId, userId, onLeft } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const shared = getChatStyles(theme)
  const [view, setView] = useState<ConversationView | undefined>(
    engine.view(conversationId)
  )
  const [approvals, setApprovals] = useState<GrantApproval[]>([])
  const [failed, setFailed] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadRevision, setLoadRevision] = useState(0)
  const generation = useRef(0)
  const scroll = useRef<React.ComponentRef<typeof ScrollView>>(null)
  const memberY = useRef<number | undefined>(undefined)
  const revealedMembers = useRef(false)
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [safety, setSafety] = useState<MemberView | undefined>(undefined)

  useEffect(() => {
    let live = true
    const version = ++generation.current
    setView(engine.view(conversationId))
    setApprovals(approvalsIn(engine.approvals(), conversationId, userId))
    setSafety(undefined)
    setError(undefined)
    memberY.current = undefined
    setFailed(false)
    setLoading(true)
    setBusy(undefined)
    revealedMembers.current = false
    const mine = (): GrantApproval[] =>
      approvalsIn(engine.approvals(), conversationId, userId)
    const unsubscribe = engine.subscribe(event => {
      if (!live) return
      if (event.type === 'approvals') setApprovals(mine())
      if (
        (event.type === 'conversation' &&
          event.conversationId === conversationId) ||
        event.type === 'conversations'
      ) {
        const next = engine.view(conversationId)
        setView(next)
        if (next == null) {
          setFailed(true)
          setLoading(false)
          setSafety(undefined)
        }
      }
    })
    engine
      .open(conversationId)
      .then(() => {
        if (live && generation.current === version) {
          const current = engine.view(conversationId)
          setView(current)
          setFailed(current == null)
          setLoading(false)
        }
      })
      .catch(() => {
        if (live && generation.current === version) {
          setFailed(true)
          setLoading(false)
        }
      })
    engine
      .fillGrants()
      .then(() => {
        if (live) setApprovals(mine())
      })
      .catch(() => undefined)
    return () => {
      live = false
      generation.current += 1
      unsubscribe()
      engine.close(conversationId)
    }
  }, [engine, conversationId, userId, loadRevision])

  useBackOverride(
    view?.members.some(member => member.userId === safety?.userId) === true,
    () => {
      setSafety(undefined)
    }
  )
  useEffect(() => {
    if (
      safety != null &&
      view != null &&
      !view.members.some(member => member.userId === safety.userId)
    )
      setSafety(undefined)
  }, [view, safety])
  const revealMembers = useCallback((): void => {
    if (
      props.showMembers !== true ||
      loading ||
      revealedMembers.current ||
      memberY.current == null ||
      scroll.current == null
    )
      return
    revealedMembers.current = true
    scroll.current.scrollTo({ y: memberY.current, animated: false })
  }, [props.showMembers, loading])
  useEffect(revealMembers, [revealMembers, view])

  const retry = (): void => {
    setLoadRevision(value => value + 1)
  }
  if (view == null) {
    return (
      <Screen>
        <Text style={failed ? shared.error : shared.muted}>
          {failed ? lstrings.chat_cannot_load : lstrings.common_loading}
        </Text>
        {failed && (
          <Button label={lstrings.common_retry} kind="text" onPress={retry} />
        )}
      </Screen>
    )
  }
  const currentSafety = view.members.find(
    member => member.userId === safety?.userId
  )
  if (currentSafety != null) {
    return (
      <SafetyNumberScreen
        engine={engine}
        userId={currentSafety.userId}
        name={currentSafety.shortName}
        onDone={() => {
          setSafety(undefined)
        }}
      />
    )
  }

  const approve = (approval: GrantApproval): void => {
    const version = generation.current
    setBusy(String(approval.requestId))
    setError(undefined)
    engine
      .approve(approval.requestId)
      .then(async () => {
        await engine.fillGrants()
        if (generation.current === version)
          setApprovals(approvalsIn(engine.approvals(), conversationId, userId))
      })
      .catch(() => {
        if (generation.current === version)
          setError(lstrings.chat_approve_failed)
      })
      .finally(() => {
        if (generation.current === version) setBusy(undefined)
      })
  }

  const leave = (): void => {
    const version = generation.current
    setBusy('leave')
    setError(undefined)
    client
      .leaveDm(conversationId)
      .then(async () => {
        await engine.refresh().catch(() => undefined)
        if (generation.current === version) onLeft()
      })
      .catch(() => {
        if (generation.current === version) {
          setError(lstrings.chat_new_failed)
          setBusy(undefined)
        }
      })
  }

  const mute = (): void => {
    const version = generation.current
    const current = engine.view(conversationId)
    if (current == null || busy != null) return
    setBusy('mute')
    setError(undefined)
    const work =
      engine.setPreferences?.(conversationId, {
        muted: current.conversation.preferences?.muted !== true
      }) ?? Promise.reject(new Error('Preferences unavailable'))
    work
      .then(() => {
        if (generation.current === version) setView(engine.view(conversationId))
      })
      .catch(() => {
        if (generation.current === version)
          setError(lstrings.chat_preference_failed)
      })
      .finally(() => {
        if (generation.current === version) setBusy(undefined)
      })
  }

  const digits = (number: string | undefined): string =>
    number == null ? '—' : safetyGroups(number).join(' ')

  return (
    <Screen scrollRef={scroll}>
      <View
        testID="chat-info-hero"
        style={{
          alignItems: 'center',
          gap: theme.rem(1),
          paddingVertical: theme.rem(1.5)
        }}
      >
        <ChatAvatar
          identity={conversationIdentity(view.conversation)}
          size={6.5}
        />
        <Text style={[shared.title, { textAlign: 'center' }]}>
          {conversationTitle(view.conversation)}
        </Text>
        <Text style={[shared.muted, { textAlign: 'center' }]}>
          {conversationPill(view.conversation) ??
            lstrings.chat_direct_conversation}
        </Text>
        {view.conversation.closed && (
          <Text style={shared.muted}>{lstrings.chat_closed_notice}</Text>
        )}
        {view.composer === 'readOnly' && (
          <Text style={shared.muted}>{lstrings.chat_read_only}</Text>
        )}
        {view.historyLocked && (
          <Text style={shared.muted}>{lstrings.chat_history_locked}</Text>
        )}
        <Button
          label={
            view.conversation.preferences?.muted === true
              ? lstrings.chat_unmute
              : lstrings.chat_mute
          }
          kind="text"
          icon="notifications"
          busy={busy === 'mute'}
          disabled={busy != null}
          onPress={mute}
        />
      </View>
      {loading && <Text style={shared.muted}>{lstrings.common_loading}</Text>}
      {failed && (
        <View style={styles.section}>
          <Text style={shared.error}>{lstrings.chat_cannot_load}</Text>
          <Button label={lstrings.common_retry} kind="text" onPress={retry} />
        </View>
      )}
      {error != null && <Text style={shared.error}>{error}</Text>}
      {approvals.length > 0 && (
        <View style={styles.section}>
          <Text style={shared.sectionLabel}>{lstrings.chat_approvals}</Text>
          {approvals.map(approval => {
            const name = approval.name ?? lstrings.chat_former_member
            return (
              <Card key={approval.requestId} style={styles.approval}>
                <Text style={shared.heading}>
                  {sprintf(lstrings.chat_approval_request, name)}
                </Text>
                <Text style={shared.sectionLabel}>
                  {lstrings.chat_old_safety_number}
                </Text>
                <Text style={styles.digits}>
                  {digits(approval.oldSafetyNumber)}
                </Text>
                <Text style={shared.sectionLabel}>
                  {lstrings.chat_new_safety_number}
                </Text>
                <Text style={styles.digits}>
                  {digits(approval.newSafetyNumber)}
                </Text>
                <Button
                  label={lstrings.chat_approve}
                  accessibilityLabel={sprintf(
                    lstrings.chat_approve_label,
                    name
                  )}
                  kind="primary"
                  busy={busy === String(approval.requestId)}
                  disabled={busy != null}
                  onPress={() => {
                    approve(approval)
                  }}
                />
              </Card>
            )
          })}
        </View>
      )}
      <View
        testID="chat-info-members"
        onLayout={event => {
          memberY.current = event.nativeEvent.layout.y
          revealMembers()
        }}
        style={styles.section}
      >
        <Text style={shared.sectionLabel}>
          {plural(
            view.members.length,
            lstrings.chat_members_count_one,
            lstrings.chat_members_count_many
          )}
        </Text>
        <Card flush>
          {view.members.map((member, index) => {
            const me = member.userId === userId
            return (
              <View key={member.userId}>
                {index > 0 && <View style={shared.divider} />}
                <Pressable
                  testID={`chat-info-member-${member.userId}`}
                  accessibilityRole="button"
                  accessibilityLabel={[
                    me
                      ? `${member.shortName} (${lstrings.chat_you})`
                      : sprintf(
                          lstrings.chat_safety_number_with,
                          member.shortName
                        ),
                    member.label,
                    member.isModerator ? lstrings.chat_moderator : ''
                  ]
                    .filter(part => part !== '')
                    .join(', ')}
                  disabled={me}
                  onPress={() => {
                    setSafety(member)
                  }}
                  style={styles.member}
                >
                  <ChatAvatar identity={memberIdentity(member)} />
                  <View style={shared.rowText}>
                    <Text style={shared.name}>
                      {me
                        ? `${member.shortName} (${lstrings.chat_you})`
                        : member.shortName}
                    </Text>
                    {member.label !== '' && (
                      <Text style={shared.small}>{member.label}</Text>
                    )}
                    {member.safetyNumberChanged && (
                      <Text style={[shared.small, styles.changed]}>
                        {sprintf(
                          lstrings.chat_safety_changed,
                          member.shortName
                        )}
                      </Text>
                    )}
                  </View>
                  {member.isModerator && (
                    <Badge label={lstrings.chat_moderator} tone="neutral" />
                  )}
                  {!me && (
                    <Icon
                      name="chevron_right"
                      color={theme.secondaryTextColor}
                    />
                  )}
                </Pressable>
              </View>
            )
          })}
        </Card>
      </View>
      {view.conversation.kind === 'dm' && !view.conversation.closed && (
        <Button
          label={lstrings.chat_leave_dm}
          kind="text"
          textColor={theme.dangerColor}
          busy={busy === 'leave'}
          disabled={busy != null}
          onPress={leave}
        />
      )}
    </Screen>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  section: {
    gap: theme.rem(theme.spaceSmRem)
  },
  approval: {
    gap: theme.rem(theme.spaceXsRem)
  },
  digits: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.9375),
    fontWeight: '600',
    letterSpacing: theme.rem(0.04),
    color: theme.primaryTextColor
  },
  member: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(theme.spaceSmRem),
    paddingHorizontal: theme.rem(theme.spaceMdRem),
    paddingVertical: theme.rem(theme.spaceSmRem)
  },
  changed: {
    color: theme.warningColor
  }
}))
