import React, { useEffect, useState } from 'react'
import { Pressable, Text, View } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import { Badge, Button, Card, Icon, initialsOf, Screen } from '../components'
import { Emblem } from '../components/Emblem'
import { lstrings, sprintf } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { approvalsIn, safetyGroups } from './chatModel'
import { getChatStyles } from './chatStyles'
import type {
  ConversationView,
  GrantApproval,
  MemberView
} from './engine/engine'
import { SafetyNumberScreen } from './SafetyNumberScreen'
import type { ChatScreenEngine } from './screenEngine'

export interface ChatMembersScreenProps {
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
  >
  client: Pick<TeamStationClient, 'leaveDm'>
  conversationId: string
  /** The signed-in person. */
  userId: number
  /** Left the conversation (a DM): back to the list. */
  onLeft: () => void
}

/**
 * Who is in a chat: each member with how they stand in it ("Coach ·
 * Guardian", Moderator), their safety number a tap away, a note where it has
 * changed, and the requests waiting for this person's approval — a member
 * whose keys were reset asks for the history, showing the old and the new
 * safety numbers before anyone taps Approve.
 */
export function ChatMembersScreen(
  props: ChatMembersScreenProps
): React.ReactElement {
  const { engine, client, conversationId, userId, onLeft } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const shared = getChatStyles(theme)
  const [view, setView] = useState<ConversationView | undefined>(
    engine.view(conversationId)
  )
  const [approvals, setApprovals] = useState<GrantApproval[]>([])
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [safety, setSafety] = useState<MemberView | undefined>(undefined)

  useEffect(() => {
    let live = true
    const mine = (): GrantApproval[] =>
      approvalsIn(engine.approvals(), conversationId, userId)
    const unsubscribe = engine.subscribe(event => {
      if (!live) return
      if (event.type === 'approvals') setApprovals(mine())
      if (
        event.type === 'conversation' &&
        event.conversationId === conversationId
      ) {
        setView(engine.view(conversationId))
      }
    })
    engine
      .open(conversationId)
      .then(opened => {
        if (live) setView(opened)
      })
      .catch(() => {
        if (live) setFailed(true)
      })
    engine
      .fillGrants()
      .then(() => {
        if (live) setApprovals(mine())
      })
      .catch(() => undefined)
    return () => {
      live = false
      unsubscribe()
      engine.close(conversationId)
    }
  }, [engine, conversationId, userId])

  if (safety != null) {
    return (
      <SafetyNumberScreen
        engine={engine}
        userId={safety.userId}
        name={safety.shortName}
        onDone={() => {
          setSafety(undefined)
        }}
      />
    )
  }
  if (view == null) {
    return (
      <Screen>
        <Text style={failed ? shared.error : shared.muted}>
          {failed ? lstrings.chat_cannot_load : lstrings.common_loading}
        </Text>
      </Screen>
    )
  }

  const approve = (approval: GrantApproval): void => {
    setBusy(String(approval.requestId))
    setError(undefined)
    engine
      .approve(approval.requestId)
      .then(async () => {
        await engine.fillGrants()
        setApprovals(approvalsIn(engine.approvals(), conversationId, userId))
      })
      .catch(() => {
        setError(lstrings.chat_approve_failed)
      })
      .finally(() => {
        setBusy(undefined)
      })
  }

  const leave = (): void => {
    setBusy('leave')
    setError(undefined)
    client
      .leaveDm(conversationId)
      .then(async () => {
        await engine.refresh().catch(() => undefined)
        onLeft()
      })
      .catch(() => {
        setError(lstrings.chat_new_failed)
        setBusy(undefined)
      })
  }

  const digits = (number: string | undefined): string =>
    number == null ? '—' : safetyGroups(number).join(' ')

  return (
    <Screen>
      <Text style={shared.title}>
        {sprintf(lstrings.chat_members_title, view.conversation.title)}
      </Text>
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
      <Card flush>
        {view.members.map((member, index) => {
          const me = member.userId === userId
          return (
            <View key={member.userId}>
              {index > 0 && <View style={shared.divider} />}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={
                  me
                    ? member.shortName
                    : sprintf(
                        lstrings.chat_safety_number_with,
                        member.shortName
                      )
                }
                disabled={me}
                onPress={() => {
                  setSafety(member)
                }}
                style={styles.member}
              >
                <Emblem
                  uri={member.avatarUrl}
                  fallback={initialsOf(member.shortName)}
                  shape="circle"
                />
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
                      {sprintf(lstrings.chat_safety_changed, member.shortName)}
                    </Text>
                  )}
                </View>
                {member.isModerator && (
                  <Badge label={lstrings.chat_moderator} tone="neutral" />
                )}
                {!me && (
                  <Icon name="chevron_right" color={theme.secondaryTextColor} />
                )}
              </Pressable>
            </View>
          )
        })}
      </Card>
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
