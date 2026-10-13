import React, { useRef, useState } from 'react'
import { Text, View } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import { parseEmailList } from '../../common/emailList'
import type { GroupRef } from '../../common/groupCreation'
import type { RoleFlag } from '../../common/roles'
import { Button, Card, DangerText, Screen, TextField } from '../components'
import { adminLabel, flagLabel } from '../components/roleLabels'
import { RoleSwitches } from '../components/RoleSwitches'
import { useLatestRequest } from '../hooks/useLatestRequest'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

export function AddPeopleScreen({
  client,
  group,
  scopeName,
  onDone,
  onCancel
}: {
  client: TeamStationClient
  group: GroupRef
  scopeName: string
  onDone: () => void
  onCancel: () => void
}): React.ReactElement {
  const styles = getStyles(useTheme())
  const [addresses, setAddresses] = useState('')
  const [roles, setRoles] = useState<{ admin: boolean; flags: RoleFlag[] }>({
    admin: false,
    flags: []
  })
  const [busy, setBusy] = useState(false)
  const [errors, setErrors] = useState<
    Array<{ email: string; message: string }>
  >([])
  const [notice, setNotice] = useState('')
  const keys = useRef(new Map<string, string>())
  const working = useRef(false)
  const begin = useLatestRequest()
  const parsed = parseEmailList(addresses)
  const send = async (): Promise<void> => {
    if (
      working.current ||
      parsed.valid.length === 0 ||
      parsed.invalid.length > 0
    )
      return
    working.current = true
    setBusy(true)
    setErrors([])
    const current = begin()
    let added = 0
    let invited = 0
    const failed: Array<{ email: string; message: string }> = []
    try {
      for (const email of parsed.valid) {
        if (!current()) return
        const body = JSON.stringify({ group, email, roles })
        let key = keys.current.get(body)
        if (key == null) {
          key = `people-${Date.now()}-${Math.random().toString(36).slice(2)}`
          keys.current.set(body, key)
        }
        try {
          const result = await client.addPerson(group.kind, group.id, email, {
            ...roles,
            idempotencyKey: key
          })
          if (result.added) added++
          else if (result.invited != null) invited++
        } catch (error) {
          failed.push({
            email,
            message:
              error instanceof Error
                ? error.message
                : 'Invitation could not be sent. Try again.'
          })
        }
      }
      if (!current()) return
      if (failed.length === 0) onDone()
      else {
        setAddresses(failed.map(row => row.email).join(', '))
        setErrors(failed)
        setNotice(`Added ${added}, invited ${invited}, ${failed.length} failed`)
      }
    } finally {
      working.current = false
      if (current()) setBusy(false)
    }
  }
  return (
    <Screen>
      <View style={styles.page}>
        <Text accessibilityRole="header" style={styles.title}>
          Add People
        </Text>
        <Text style={styles.hint}>{scopeName}</Text>
        <Card>
          <TextField
            label="E-mail addresses"
            value={addresses}
            onChangeText={setAddresses}
            multiline
            disabled={busy}
            placeholder="parent@example.com, coach@example.com"
          />
          <Text style={styles.hint}>
            Enter one address, or several separated by commas. Everybody you add
            gets the roles below. Somebody with an account is added at once;
            anybody else receives an invitation lasting seven days.
          </Text>
          {parsed.invalid.length > 0 && (
            <Text accessibilityRole="alert" style={styles.error}>
              Invalid addresses: {parsed.invalid.join(', ')}
            </Text>
          )}
          <RoleSwitches
            scopeKind={group.kind}
            scopeName={scopeName}
            admin={roles.admin}
            flags={roles.flags}
            busy={busy}
            onChange={setRoles}
          />
          <Text style={styles.hint}>
            Adds them as:{' '}
            {roles.admin
              ? adminLabel(group.kind)
              : roles.flags.length > 0
                ? roles.flags.map(flagLabel).join(', ')
                : 'Member'}
          </Text>
        </Card>
        {errors.map(row => (
          <Text key={row.email} accessibilityRole="alert" style={styles.error}>
            {row.email}: {row.message}
          </Text>
        ))}
        {notice !== '' && <Text style={styles.hint}>{notice}</Text>}
        <Button
          label={parsed.valid.length > 1 ? 'Send invites' : 'Send invite'}
          block
          busy={busy}
          disabled={parsed.valid.length === 0 || parsed.invalid.length > 0}
          onPress={() => {
            send().catch(() => undefined)
          }}
        />
        <DangerText label="Cancel" disabled={busy} onPress={onCancel} />
      </View>
    </Screen>
  )
}
const getStyles = cacheStyles((theme: Theme) => ({
  page: { gap: theme.rem(1) },
  title: {
    fontSize: theme.rem(1.5),
    fontFamily: theme.semiBoldTextFont,
    color: theme.primaryTextColor
  },
  hint: { fontSize: theme.rem(0.875), color: theme.secondaryTextColor },
  error: { color: theme.dangerColor }
}))
