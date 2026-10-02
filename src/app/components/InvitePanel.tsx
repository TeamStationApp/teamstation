import React, { useEffect, useState } from 'react'
import { Pressable, Text, View } from 'react-native'

import type { GameStationClient, Invite } from '../../common/api'
import { lstrings, sprintf } from '../locales/strings'
import { copyToClipboard } from '../platform/clipboard'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { Button } from './Button'
import { Card } from './Card'
import { Icon } from './Icon'
import { SectionHeader } from './SectionHeader'
import { TextField } from './TextField'

export interface InvitePanelProps {
  client: GameStationClient
  scopeType: 'league' | 'season' | 'team'
  scopeId: string
  /** What people are being invited to, for the line above the links. */
  scopeName: string
}

/**
 * Making invite links, at the bottom of the team and season screens.
 *
 * Shown only to somebody who administers this team or season — the server
 * decides that and says so in `canInvite`, and everybody else sees nothing
 * rather than a greyed-out row for a thing they cannot do.
 *
 * A link, not an e-mail: GameStation does not know the address of the parent
 * a coach wants to add, and asking a coach to type twenty of them is how a
 * feature goes unused. The code can be their own wording — `fall26` — because
 * the codes that worked in PeerTube were the ones people could read down a
 * phone.
 *
 * A stopped link stays on the list, greyed. It is how somebody works out why
 * the link they sent last week no longer works.
 */
export function InvitePanel(props: InvitePanelProps): React.ReactElement {
  const { client, scopeType, scopeId, scopeName } = props
  const theme = useTheme()
  const styles = getStyles(theme)

  const [canInvite, setCanInvite] = useState(false)
  const [invites, setInvites] = useState<Invite[]>([])
  const [opening, setOpening] = useState(false)
  const [code, setCode] = useState('')
  const [label, setLabel] = useState('')
  const [copied, setCopied] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  useEffect(() => {
    let live = true
    client
      .invites(scopeType, scopeId)
      .then(answer => {
        if (!live) return
        setCanInvite(answer.canInvite)
        setInvites(answer.invites)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [client, scopeId, scopeType])

  const run = (work: () => Promise<void>): void => {
    setBusy(true)
    setError(undefined)
    work()
      .catch((caught: unknown) => {
        setError(
          caught instanceof Error ? caught.message : 'Something went wrong'
        )
      })
      .finally(() => {
        setBusy(false)
      })
  }

  const create = (): void => {
    run(async () => {
      const made = await client.createInvite({
        scopeType,
        scopeId,
        code: code.trim() === '' ? undefined : code.trim(),
        label: label.trim() === '' ? undefined : label.trim()
      })
      setInvites([made, ...invites])
      setCode('')
      setLabel('')
      setOpening(false)
    })
  }

  const revoke = (invite: Invite): void => {
    run(async () => {
      await client.revokeInvite(invite.id)
      const answer = await client.invites(scopeType, scopeId)
      setInvites(answer.invites)
    })
  }

  if (!canInvite) return <View />

  return (
    <View style={styles.section}>
      <SectionHeader title={lstrings.invite_title} />
      <Card style={styles.card}>
        <Text style={styles.detail}>
          {sprintf(lstrings.invite_detail, scopeName)}
        </Text>

        {invites.length === 0 && !opening && (
          <Text style={styles.muted}>{lstrings.invite_none}</Text>
        )}

        {invites.map(invite => (
          <View key={invite.id} style={styles.invite}>
            {/* The copy glyph leads, so the row says what pressing it does
                before anybody has to guess that an address is a button. */}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Copy the invite link ${invite.code}`}
              style={({ pressed }) => [styles.linkRow, pressed && styles.faded]}
              onPress={() => {
                copyToClipboard(invite.url)
                setCopied(invite.id)
              }}
            >
              <Icon
                name="content_copy"
                size={1}
                color={
                  invite.problem == null
                    ? theme.activeColor
                    : theme.secondaryTextColor
                }
              />
              <Text
                style={[
                  styles.url,
                  invite.problem != null && styles.urlStopped
                ]}
                selectable
                numberOfLines={1}
              >
                {invite.url}
              </Text>
            </Pressable>
            <View style={styles.inviteFoot}>
              <Text style={styles.muted}>
                {[
                  invite.label,
                  usesLabel(invite.uses),
                  problemLabel(invite.problem),
                  copied === invite.id ? lstrings.invite_copied : undefined
                ]
                  .filter(part => part != null && part !== '')
                  .join(' · ')}
              </Text>
              {invite.problem == null && (
                <Button
                  label={lstrings.invite_revoke}
                  kind="text"
                  onPress={() => {
                    revoke(invite)
                  }}
                />
              )}
            </View>
          </View>
        ))}

        {opening ? (
          <>
            <TextField
              label={lstrings.invite_code_label}
              value={code}
              onChangeText={setCode}
              placeholder={lstrings.invite_code_placeholder}
              autoFocus
            />
            <TextField
              label={lstrings.invite_label_label}
              value={label}
              onChangeText={setLabel}
              placeholder={lstrings.invite_label_placeholder}
              onSubmitEditing={create}
            />
            <Button
              label={lstrings.invite_submit}
              busy={busy}
              onPress={create}
            />
            <Button
              label={lstrings.invite_cancel}
              kind="text"
              onPress={() => {
                setOpening(false)
                setError(undefined)
              }}
            />
          </>
        ) : (
          <Button
            label={lstrings.invite_create}
            kind="secondary"
            busy={busy}
            onPress={() => {
              setOpening(true)
            }}
          />
        )}

        {error != null && <Text style={styles.warning}>{error}</Text>}
      </Card>
    </View>
  )
}

function usesLabel(uses: number): string {
  if (uses === 0) return lstrings.invite_uses_none
  if (uses === 1) return lstrings.invite_uses_one
  return sprintf(lstrings.invite_uses_many, uses)
}

function problemLabel(problem: Invite['problem']): string | undefined {
  if (problem === 'revoked') return lstrings.invite_revoked
  if (problem === 'expired') return lstrings.invite_expired
  if (problem === 'exhausted') return lstrings.invite_exhausted
  return undefined
}

/** The clipboard, where this app runs: a browser, for now. */

const getStyles = cacheStyles((theme: Theme) => ({
  section: {
    gap: theme.rem(theme.spaceMdRem)
  },
  card: {
    gap: theme.rem(theme.spaceMdRem)
  },
  detail: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875),
    color: theme.secondaryTextColor
  },
  invite: {
    gap: theme.rem(theme.spaceXsRem)
  },
  linkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(theme.spaceSmRem)
  },
  faded: {
    opacity: 0.6
  },
  inviteFoot: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.rem(theme.spaceSmRem)
  },
  url: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.9375),
    fontWeight: '600',
    color: theme.primaryTextColor
  },
  urlStopped: {
    color: theme.secondaryTextColor,
    textDecorationLine: 'line-through'
  },
  muted: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.8125),
    color: theme.secondaryTextColor
  },
  warning: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875),
    color: theme.warningColor
  }
}))
