import React, { useCallback, useState } from 'react'
import { Text, View } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import type {
  NodeAccount,
  NodeAccountChange
} from '../../common/nodeAdministration'
import { Button, Card, Screen, TextField } from '../components'
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
  const styles = getStyles(useTheme())
  const [query, setQuery] = useState('')
  const [accounts, setAccounts] = useState<NodeAccount[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const begin = useLatestRequest()
  const [confirmation, setConfirmation] = useState<{
    account: NodeAccount
    change: NodeAccountChange
    label: string
  }>()
  const load = useCallback(async (): Promise<void> => {
    const current = begin()
    try {
      const found = await client.nodeAccounts(query)
      if (!current()) return
      setAccounts(found)
      setError('')
      setLoaded(true)
    } catch (error) {
      if (!current()) return
      setAccounts([])
      setError(
        error instanceof Error
          ? error.message
          : 'Accounts could not load. Retry.'
      )
    }
  }, [client, query, begin])
  useForegroundRefresh(load)
  const save = async (): Promise<void> => {
    if (confirmation == null || busy) return
    setBusy(true)
    setError('')
    try {
      await client.changeNodeAccount(
        confirmation.account.userId,
        confirmation.change
      )
      const id = confirmation.account.userId
      setConfirmation(undefined)
      onChanged(id)
      await load()
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : 'The account change could not be saved. Retry.'
      )
    } finally {
      setBusy(false)
    }
  }
  return (
    <Screen>
      <View style={styles.page}>
        <Text style={styles.title}>Node administration</Text>
        <Text style={styles.hint}>
          Node administrators manage all organizations and accounts. Every group
          and the node must keep an active administrator. Suspension preserves
          identity and game history and requires a new sign-in after
          reactivation.
        </Text>
        <TextField
          label="Find an account"
          value={query}
          onChangeText={setQuery}
          placeholder="Name or verified email"
        />
        {error !== '' && (
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
        )}
        <Button
          label="Refresh accounts"
          kind="secondary"
          onPress={() => {
            load().catch(() => undefined)
          }}
        />
        {loaded && accounts.length === 0 && error === '' && (
          <Text style={styles.hint}>No accounts match.</Text>
        )}
        {accounts.map(account => (
          <Card key={account.userId} style={styles.card}>
            <Text style={styles.name}>{account.displayName}</Text>
            {account.email != null && (
              <Text style={styles.hint}>{account.email}</Text>
            )}
            <Text style={styles.hint}>
              {account.isNodeAdmin ? 'Node administrator' : 'Account'}
              {account.suspended ? ' · Suspended' : ' · Active'}
            </Text>
            {account.isNodeAdmin && !account.canRemoveNodeRole && (
              <Text style={styles.hint}>
                This is the final active node administrator.
              </Text>
            )}
            <Button
              label={`${account.isNodeAdmin ? 'Remove node role from' : 'Grant node role to'} ${account.displayName}`}
              kind="secondary"
              disabled={
                busy ||
                (account.isNodeAdmin && !account.canRemoveNodeRole) ||
                (!account.isNodeAdmin && account.suspended)
              }
              onPress={() => {
                setConfirmation({
                  account,
                  change: { isNodeAdmin: !account.isNodeAdmin },
                  label: account.isNodeAdmin
                    ? 'Remove node role'
                    : 'Grant node role'
                })
              }}
            />
            <Button
              label={`${account.suspended ? 'Reactivate' : 'Suspend'} ${account.displayName}`}
              kind="secondary"
              disabled={
                busy ||
                (account.isNodeAdmin &&
                  !account.canRemoveNodeRole &&
                  !account.suspended)
              }
              onPress={() => {
                setConfirmation({
                  account,
                  change: { suspended: !account.suspended },
                  label: account.suspended
                    ? 'Reactivate account'
                    : 'Suspend account'
                })
              }}
            />
          </Card>
        ))}
        {confirmation != null && (
          <Card style={styles.card}>
            <Text style={styles.name}>
              {confirmation.label}: {confirmation.account.displayName}
            </Text>
            <Text style={styles.hint}>
              {confirmation.change.suspended === true
                ? 'Active sign-ins and connected devices will stop working. Add accepted replacement administrators for every group this person alone administers first.'
                : 'This changes account access immediately. Group memberships and game history remain intact.'}
            </Text>
            <Button
              label="Confirm account change"
              busy={busy}
              onPress={() => {
                save().catch(() => undefined)
              }}
            />
            <Button
              label="Keep account unchanged"
              kind="secondary"
              disabled={busy}
              onPress={() => {
                setConfirmation(undefined)
              }}
            />
          </Card>
        )}
      </View>
    </Screen>
  )
}
const getStyles = cacheStyles((theme: Theme) => ({
  page: { gap: theme.rem(1) },
  card: { padding: theme.rem(1), gap: theme.rem(0.75) },
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
  error: { color: theme.dangerColor, fontSize: theme.rem(0.875) }
}))
