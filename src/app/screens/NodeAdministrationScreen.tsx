import React, { useCallback, useRef, useState } from 'react'
import { Modal, Pressable, Switch, Text, View } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import type { NodeAccount } from '../../common/nodeAdministration'
import {
  Button,
  initialsOf,
  ListCard,
  ListRow,
  Screen,
  SectionHeader,
  TextField
} from '../components'
import { ActionList } from '../components/ActionRow'
import { CancelAction } from '../components/CancelAction'
import { useForegroundRefresh } from '../hooks/useForegroundRefresh'
import { useLatestRequest } from '../hooks/useLatestRequest'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

export function NodeAdministrationScreen({
  client,
  onChanged
}: {
  client: TeamStationClient
  onChanged: (userId: number) => void
}): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  const [query, setQuery] = useState('')
  const [admins, setAdmins] = useState<NodeAccount[]>([])
  const [matches, setMatches] = useState<NodeAccount[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [confirmation, setConfirmation] = useState<NodeAccount>()
  const [accountMessages, setAccountMessages] = useState<boolean | null>(null)
  const [mailBusy, setMailBusy] = useState(false)
  const begin = useLatestRequest()
  const beginWrite = useLatestRequest()
  const writing = useRef(false)
  /** A completed write takes precedence over an older mail refresh. */
  const mailRevision = useRef(0)
  const load = useCallback(
    async (reportMailError = true): Promise<void> => {
      const seen = mailRevision.current
      const current = begin()
      const [nodes, found, mail] = await Promise.allSettled([
        client.nodeAccounts('', true),
        query.trim() === ''
          ? Promise.resolve([])
          : client.nodeAccounts(query.trim()),
        client.accountMail()
      ])
      if (!current()) return
      setAdmins(nodes.status === 'fulfilled' ? nodes.value : [])
      setMatches(found.status === 'fulfilled' ? found.value : [])
      if (nodes.status === 'fulfilled' && found.status === 'fulfilled')
        setLoaded(true)
      if (mail.status === 'fulfilled' && mailRevision.current === seen)
        setAccountMessages(mail.value.accountMessages)
      const reason =
        nodes.status === 'rejected'
          ? nodes.reason
          : found.status === 'rejected'
            ? found.reason
            : reportMailError && mail.status === 'rejected'
              ? mail.reason
              : undefined
      setError(
        reason instanceof Error
          ? reason.message
          : reason == null
            ? ''
            : 'Accounts could not load. Retry.'
      )
    },
    [client, query, begin]
  )
  useForegroundRefresh(load)
  const change = async (
    account: NodeAccount,
    isNodeAdmin: boolean
  ): Promise<void> => {
    if (writing.current) return
    writing.current = true
    begin()
    const current = beginWrite()
    setBusy(true)
    setError('')
    try {
      await client.changeNodeAccount(account.userId, { isNodeAdmin })
      if (!current()) return
      setConfirmation(undefined)
      onChanged(account.userId)
      await load(false)
    } catch (error) {
      if (current())
        setError(
          error instanceof Error
            ? error.message
            : 'The account change could not be saved. Retry.'
        )
    } finally {
      writing.current = false
      if (current()) setBusy(false)
    }
  }
  const close = (): void => {
    if (!busy) setConfirmation(undefined)
  }
  const row = (account: NodeAccount): React.ReactElement => (
    <View key={account.userId}>
      <ListRow
        title={account.displayName}
        subtitle={account.email ?? undefined}
        subtitleNumberOfLines={2}
        emblem={initialsOf(account.displayName)}
        emblemUri={account.avatarUrl}
        emblemShape="circle"
        end={
          <Button
            label={account.isNodeAdmin ? 'Revoke' : 'Add'}
            accessibilityLabel={`${account.isNodeAdmin ? 'Revoke' : 'Add'} ${account.displayName}`}
            kind="text"
            textColor={
              account.isNodeAdmin ? theme.dangerColor : theme.successColor
            }
            disabled={
              busy ||
              (account.isNodeAdmin
                ? !account.canRemoveNodeRole
                : account.suspended)
            }
            onPress={() => {
              if (account.isNodeAdmin) setConfirmation(account)
              else change(account, true).catch(() => undefined)
            }}
          />
        }
      />
      {account.isNodeAdmin && !account.canRemoveNodeRole && (
        <Text style={styles.rowHint}>
          This is the final active node administrator.
        </Text>
      )}
      {!account.isNodeAdmin && account.suspended && (
        <Text style={styles.rowHint}>This account is suspended.</Text>
      )}
    </View>
  )
  const shown = new Set(matches.map(account => account.userId))
  const currentAdmins = admins.filter(account => !shown.has(account.userId))
  return (
    <Screen>
      <Text style={styles.title}>Node administration</Text>
      {accountMessages != null && (
        <ListCard>
          <ListRow
            title="Account emails"
            end={
              <Switch
                accessibilityLabel="Account emails"
                value={accountMessages}
                disabled={busy || mailBusy}
                onValueChange={next => {
                  if (mailBusy) return
                  const revision = ++mailRevision.current
                  setMailBusy(true)
                  setError('')
                  client
                    .setAccountMail(next)
                    .then(() => {
                      if (mailRevision.current !== revision) return
                      mailRevision.current = revision + 1
                      setAccountMessages(next)
                    })
                    .catch((error: unknown) => {
                      if (mailRevision.current !== revision) return
                      setError(
                        error instanceof Error
                          ? error.message
                          : 'Account emails could not be changed. Retry.'
                      )
                    })
                    .finally(() => {
                      setMailBusy(false)
                    })
                }}
              />
            }
          />
        </ListCard>
      )}
      <TextField
        label="Find an account"
        value={query}
        disabled={busy}
        placeholder="Name or email"
        onChangeText={value => {
          begin()
          setMatches([])
          setLoaded(false)
          setQuery(value)
        }}
      />
      {error !== '' && (
        <View>
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
          <Button
            label="Retry accounts"
            kind="text"
            onPress={() => {
              load().catch(() => undefined)
            }}
          />
        </View>
      )}
      {query.trim() !== '' && (
        <View style={styles.section}>
          <SectionHeader title="Search results" />
          {loaded && matches.length === 0 ? (
            <Text style={styles.hint}>No accounts match.</Text>
          ) : matches.length > 0 ? (
            <ActionList>{matches.map(row)}</ActionList>
          ) : (
            <Text style={styles.hint}>Looking for accounts…</Text>
          )}
        </View>
      )}
      <View style={styles.section}>
        <SectionHeader title="Node access" />
        {currentAdmins.length > 0 && (
          <ActionList>{currentAdmins.map(row)}</ActionList>
        )}
      </View>
      {confirmation != null && (
        <Modal transparent animationType="slide" visible onRequestClose={close}>
          <View style={styles.scrim}>
            <Pressable
              accessibilityLabel="Cancel revoke"
              style={styles.behind}
              disabled={busy}
              onPress={close}
            />
            <View style={styles.sheet} accessibilityLabel="Revoke node access">
              <Text style={styles.name}>
                Revoke node access for {confirmation.displayName}?
              </Text>
              <Text style={styles.hint}>
                They will no longer manage the node. Their account, group
                memberships and game history remain.
              </Text>
              {error !== '' && (
                <Text accessibilityRole="alert" style={styles.error}>
                  {error}
                </Text>
              )}
              <Button
                label="Revoke"
                accessibilityLabel="Confirm revoke"
                color={theme.dangerColor}
                busy={busy}
                onPress={() => {
                  change(confirmation, false).catch(() => undefined)
                }}
              />
              <CancelAction
                destructivePrimary
                label="Cancel"
                disabled={busy}
                onPress={close}
              />
            </View>
          </View>
        </Modal>
      )}
    </Screen>
  )
}
const getStyles = cacheStyles((theme: Theme) => ({
  section: { gap: theme.rem(0.75) },
  title: {
    color: theme.primaryTextColor,
    fontSize: theme.rem(1.5),
    fontFamily: theme.semiBoldTextFont
  },
  name: {
    color: theme.primaryTextColor,
    fontSize: theme.rem(1.125),
    fontFamily: theme.semiBoldTextFont
  },
  hint: {
    color: theme.secondaryTextColor,
    fontSize: theme.rem(0.875),
    lineHeight: theme.rem(1.3)
  },
  rowHint: {
    paddingHorizontal: theme.rem(1),
    paddingBottom: theme.rem(0.75),
    color: theme.secondaryTextColor,
    fontSize: theme.rem(0.875)
  },
  error: { color: theme.dangerColor, fontSize: theme.rem(0.875) },
  scrim: { flex: 1, justifyContent: 'flex-end' },
  behind: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: theme.overlayBackgroundColor
  },
  sheet: {
    width: '100%',
    maxWidth: theme.rem(36),
    alignSelf: 'center',
    backgroundColor: theme.cardBackgroundColor,
    borderTopLeftRadius: theme.rem(theme.radiusLargeRem),
    borderTopRightRadius: theme.rem(theme.radiusLargeRem),
    padding: theme.rem(theme.spaceLgRem),
    paddingBottom: theme.rem(2),
    gap: theme.rem(0.75)
  },
  cancel: { alignSelf: 'center' }
}))
