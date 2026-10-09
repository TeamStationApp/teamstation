import React, { useCallback, useEffect, useState } from 'react'
import { Text, View } from 'react-native'

import type { ChatReport, TeamStationClient } from '../../common/api'
import { asChatContent } from '../../common/chatContent'
import { HttpError } from '../../common/errors'
import { getChatStyles } from '../chat/chatStyles'
import { Badge, Button, Card, PillTabs, Screen } from '../components'
import { lstrings, plural, sprintf } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

export interface ChatReportsScreenProps {
  client: Pick<TeamStationClient, 'chatReports' | 'resolveChatReport'>
  /** Whether the signed-in person is a site administrator. */
  isAdmin: boolean
}

type Filter = 'open' | 'all'

/**
 * Reported chat messages, for site administrators (`/admin/chat/reports`).
 *
 * Each report shows the one message its reporter disclosed — the only chat
 * text the server ever holds — with whether it is **verified**: the sender's
 * signature and the disclosed message key prove the sender wrote exactly
 * this. An unverified report is the reporter's word only. Resolving one
 * marks it handled; nothing is deleted.
 *
 * Anyone else gets the same "nothing here" a missing page gets, without the
 * screen asking the server at all.
 */
export function ChatReportsScreen(
  props: ChatReportsScreenProps
): React.ReactElement {
  const { client, isAdmin } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const shared = getChatStyles(theme)
  const [filter, setFilter] = useState<Filter>('open')
  const [reports, setReports] = useState<ChatReport[] | undefined>(undefined)
  const [state, setState] = useState<'loading' | 'ready' | 'failed' | 'none'>(
    isAdmin ? 'loading' : 'none'
  )
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)

  const load = useCallback(
    async (which: Filter, live: () => boolean): Promise<void> => {
      try {
        const found = await client.chatReports(which === 'open')
        if (!live()) return
        setReports(found)
        setState('ready')
      } catch (failure) {
        if (!live()) return
        const refused =
          failure instanceof HttpError &&
          (failure.code === 'forbidden' || failure.code === 'notFound')
        setState(refused ? 'none' : 'failed')
      }
    },
    [client]
  )

  useEffect(() => {
    if (!isAdmin) return
    let live = true
    load(filter, () => live).catch(() => undefined)
    return () => {
      live = false
    }
  }, [filter, isAdmin, load])

  if (state === 'none') {
    return (
      <Screen>
        <Text style={shared.muted}>{lstrings.chat_reports_not_found}</Text>
      </Screen>
    )
  }

  const resolve = (report: ChatReport): void => {
    setBusy(report.id)
    setError(undefined)
    client
      .resolveChatReport(report.id)
      .then(resolved => {
        setReports(current =>
          (current ?? []).flatMap(held =>
            held.id !== resolved.id
              ? [held]
              : filter === 'open'
                ? []
                : [resolved]
          )
        )
      })
      .catch(() => {
        setError(lstrings.chat_reports_resolve_failed)
      })
      .finally(() => {
        setBusy(undefined)
      })
  }

  return (
    <Screen>
      <View style={styles.column}>
        <PillTabs<Filter>
          tabs={[
            { id: 'open', label: lstrings.chat_reports_open },
            { id: 'all', label: lstrings.chat_reports_all }
          ]}
          selected={filter}
          onSelect={next => {
            setFilter(next)
          }}
          accessibilityLabel={lstrings.chat_reports_title}
        />
        {error != null && <Text style={shared.error}>{error}</Text>}
        {state === 'failed' ? (
          <Text style={shared.error}>{lstrings.chat_reports_failed}</Text>
        ) : state === 'loading' || reports == null ? (
          <Text style={shared.muted}>{lstrings.common_loading}</Text>
        ) : reports.length === 0 ? (
          <Text style={shared.muted}>
            {filter === 'open'
              ? lstrings.chat_reports_none_open
              : lstrings.chat_reports_none}
          </Text>
        ) : (
          reports.map(report => (
            <Card key={report.id} accent={report.resolvedAt == null}>
              <View
                style={styles.report}
                accessibilityLabel={sprintf(
                  lstrings.chat_reports_from,
                  report.sender.shortName,
                  chatName(report)
                )}
              >
                <View style={styles.top}>
                  <Text style={shared.heading}>
                    {sprintf(
                      lstrings.chat_reports_from,
                      report.sender.shortName,
                      chatName(report)
                    )}
                  </Text>
                  <Badge
                    label={
                      report.verified
                        ? lstrings.chat_reports_verified
                        : lstrings.chat_reports_unverified
                    }
                    tone={report.verified ? 'win' : 'loss'}
                  />
                </View>
                <Text style={styles.body} selectable>
                  {disclosed(report)}
                </Text>
                <Text style={shared.small}>
                  {report.verified
                    ? lstrings.chat_reports_verified_detail
                    : lstrings.chat_reports_unverified_detail}
                </Text>
                <Text style={shared.small}>
                  {sprintf(
                    lstrings.chat_reports_reported_by,
                    report.reporter.shortName,
                    when(report.createdAt)
                  )}
                </Text>
                {report.resolvedAt == null ? (
                  <Button
                    label={lstrings.chat_reports_resolve}
                    kind="secondary"
                    busy={busy === report.id}
                    disabled={busy != null}
                    onPress={() => {
                      resolve(report)
                    }}
                  />
                ) : (
                  <Text style={shared.small}>
                    {sprintf(
                      lstrings.chat_reports_resolved,
                      when(report.resolvedAt)
                    )}
                  </Text>
                )}
              </View>
            </Card>
          ))
        )}
      </View>
    </Screen>
  )
}

/** The chat's title, or what kind of chat it was. */
function chatName(report: ChatReport): string {
  return report.conversation.title ?? lstrings.chat_reports_kind_dm
}

/**
 * What the reporter disclosed, as people read it: a post's words, with a
 * count of its attachments. Anything that is not a post's content (an
 * unverified report can carry anything) is shown as it was sent.
 */
export function disclosed(report: Pick<ChatReport, 'plaintext'>): string {
  try {
    const content = asChatContent(JSON.parse(report.plaintext))
    if (content.type !== 'text') return report.plaintext
    const files = content.attachments.length
    return files === 0
      ? content.body
      : `${content.body}${content.body === '' ? '' : '\n'}${plural(
          files,
          lstrings.chat_reports_attachments_one,
          lstrings.chat_reports_attachments_many
        )}`
  } catch {
    return report.plaintext
  }
}

function when(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}

const getStyles = cacheStyles((theme: Theme) => ({
  column: {
    gap: theme.rem(theme.spaceMdRem)
  },
  report: {
    gap: theme.rem(theme.spaceSmRem)
  },
  top: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.rem(theme.spaceSmRem)
  },
  body: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(1),
    color: theme.primaryTextColor
  }
}))
