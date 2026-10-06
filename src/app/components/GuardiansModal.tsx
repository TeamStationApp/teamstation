import React, { useCallback, useEffect, useState } from 'react'
import { Modal, Pressable, ScrollView, Text, View } from 'react-native'

import type {
  Guardian,
  RelativeKind,
  RosterEntry,
  TeamStationClient
} from '../../common/api'
import { HttpError } from '../../common/errors'
import { lstrings, sprintf } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { Button } from './Button'
import { TextField } from './TextField'

export interface GuardiansModalProps {
  client: TeamStationClient
  /** The team the player is on, whose staff the caller is. */
  teamId: string
  playerId: number | string
  playerName: string
  onClose: () => void
  /** Told the list as it stands after each change. */
  onChanged?: (guardians: Guardian[]) => void
}

const KINDS: Array<{ id: RelativeKind; label: string }> = [
  { id: 'guardian', label: lstrings.guardians_kind_guardian },
  { id: 'family', label: lstrings.guardians_kind_family }
]

/**
 * A player's guardians and adult family members, for the team's
 * administrators and coaches: who they are, Remove beside each, and Add.
 *
 * Add takes an e-mail address, which links an account at once or mails an
 * invitation only that address can accept, or a name, which offers the
 * matching people on the team to pick. Either is added as the kind chosen
 * above it: a guardian, or an adult family member.
 */
export function GuardiansModal(props: GuardiansModalProps): React.ReactElement {
  const { client, teamId, playerId, playerName, onClose, onChanged } = props
  const styles = getStyles(useTheme())

  const [guardians, setGuardians] = useState<Guardian[] | undefined>(undefined)
  const [team, setTeam] = useState<RosterEntry[]>([])
  const [text, setText] = useState('')
  const [kind, setKind] = useState<RelativeKind>('guardian')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)

  const shown = useCallback(
    (list: Guardian[]): void => {
      setGuardians(list)
      onChanged?.(list)
    },
    [onChanged]
  )

  useEffect(() => {
    let live = true
    client
      .guardians(teamId, playerId)
      .then(list => {
        if (live) setGuardians(list)
      })
      .catch(() => {
        if (live) setError(lstrings.guardians_cannot_load)
      })
    client
      .roster(teamId)
      .then(roster => {
        if (live) setTeam(roster)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [client, playerId, teamId])

  const run = (work: () => Promise<void>): void => {
    setBusy(true)
    setError(undefined)
    setNote(undefined)
    work()
      .catch((caught: unknown) => {
        setError(messageOf(caught))
      })
      .finally(() => {
        setBusy(false)
      })
  }

  const wanted = text.trim()
  const byEmail = wanted.includes('@')
  const linked = new Set((guardians ?? []).map(guardian => guardian.userId))
  const matches =
    byEmail || wanted.length < 2
      ? []
      : team
          .filter(
            entry =>
              String(entry.userId) !== String(playerId) &&
              !linked.has(entry.userId) &&
              entry.shortName.toLowerCase().includes(wanted.toLowerCase())
          )
          .slice(0, 6)

  const addEmail = (): void => {
    run(async () => {
      const answer = await client.addGuardian(
        teamId,
        playerId,
        { email: wanted },
        kind
      )
      shown(answer.guardians)
      setNote(
        answer.invited != null
          ? sprintf(lstrings.guardians_invited, answer.invited.email)
          : sprintf(lstrings.guardians_added, wanted)
      )
      setText('')
    })
  }

  const addPerson = (entry: RosterEntry): void => {
    run(async () => {
      const answer = await client.addGuardian(
        teamId,
        playerId,
        { userId: entry.userId },
        kind
      )
      shown(answer.guardians)
      setNote(sprintf(lstrings.guardians_added, entry.shortName))
      setText('')
    })
  }

  const remove = (guardian: Guardian): void => {
    run(async () => {
      await client.removeGuardian(teamId, playerId, guardian.userId)
      shown(await client.guardians(teamId, playerId))
    })
  }

  return (
    <Modal transparent animationType="fade" visible onRequestClose={onClose}>
      <View style={styles.scrim}>
        {/* A sibling of the sheet, never its parent: a pressable inside a
            pressable is invalid on the web build. */}
        <Pressable
          style={styles.behind}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel={lstrings.guardians_done}
        />
        <ScrollView
          style={styles.sheetScroll}
          contentContainerStyle={styles.sheet}
        >
          <Text style={styles.title}>
            {sprintf(lstrings.guardians_title_for, playerName)}
          </Text>
          <Text style={styles.detail}>{lstrings.guardians_detail}</Text>

          <View accessibilityLabel={lstrings.guardians_title}>
            {guardians == null ? null : guardians.length === 0 ? (
              <Text style={styles.detail}>{lstrings.guardians_none}</Text>
            ) : (
              guardians.map(guardian => (
                <View key={guardian.userId} style={styles.row}>
                  <View style={styles.rowText}>
                    <Text style={styles.name}>{guardian.name}</Text>
                    <Text style={styles.detail}>
                      {[kindLabel(guardian.kind), guardian.email]
                        .filter(item => item != null)
                        .join(' · ')}
                    </Text>
                  </View>
                  <Button
                    label={lstrings.guardians_remove}
                    accessibilityLabel={sprintf(
                      lstrings.guardians_remove_label,
                      guardian.name
                    )}
                    kind="text"
                    disabled={busy}
                    onPress={() => {
                      remove(guardian)
                    }}
                  />
                </View>
              ))
            )}
          </View>

          <Text style={styles.heading}>{lstrings.guardians_add}</Text>
          <View
            style={styles.kinds}
            accessibilityRole="radiogroup"
            accessibilityLabel={lstrings.guardians_add}
          >
            {KINDS.map(choice => {
              const on = kind === choice.id
              return (
                <Pressable
                  key={choice.id}
                  accessibilityRole="radio"
                  accessibilityLabel={choice.label}
                  accessibilityState={{ checked: on, disabled: busy }}
                  aria-checked={on}
                  disabled={busy}
                  onPress={() => {
                    setKind(choice.id)
                  }}
                  style={[styles.kind, on ? styles.kindOn : styles.kindOff]}
                >
                  <Text
                    style={[styles.kindLabel, on ? styles.kindLabelOn : null]}
                  >
                    {choice.label}
                  </Text>
                </Pressable>
              )
            })}
          </View>
          <TextField
            label={lstrings.guardians_add_field}
            value={text}
            onChangeText={next => {
              setText(next)
              setNote(undefined)
            }}
            placeholder={lstrings.guardians_add_placeholder}
            keyboardType="email-address"
            autoComplete="off"
            onSubmitEditing={() => {
              if (byEmail && !busy) addEmail()
            }}
          />
          {matches.map(entry => (
            <View key={entry.userId} style={styles.row}>
              <Text style={[styles.name, styles.rowText]}>
                {entry.shortName}
              </Text>
              <Button
                label={kindLabel(kind)}
                accessibilityLabel={sprintf(
                  lstrings.guardians_pick,
                  entry.shortName
                )}
                kind="text"
                disabled={busy}
                onPress={() => {
                  addPerson(entry)
                }}
              />
            </View>
          ))}
          <Button
            label={lstrings.guardians_add_submit}
            accessibilityLabel={lstrings.guardians_add_submit}
            busy={busy}
            disabled={!byEmail}
            onPress={addEmail}
          />
          {note != null && <Text style={styles.detail}>{note}</Text>}
          {error != null && <Text style={styles.error}>{error}</Text>}
          <Button
            label={lstrings.guardians_done}
            accessibilityLabel={lstrings.guardians_done}
            kind="text"
            onPress={onClose}
          />
        </ScrollView>
      </View>
    </Modal>
  )
}

/** `Guardian` or `Family`, for a row. */
export function kindLabel(kind: RelativeKind): string {
  return kind === 'guardian'
    ? lstrings.guardians_kind_guardian
    : lstrings.guardians_kind_family_short
}

/** What went wrong, in words; the server's reason where it gave one. */
function messageOf(caught: unknown): string {
  if (caught instanceof HttpError) {
    const reason = (caught.details as { reason?: unknown } | undefined)?.reason
    if (reason === 'guardianNeedsAccount') {
      return lstrings.guardians_needs_account
    }
  }
  return caught instanceof Error && caught.message !== ''
    ? caught.message
    : 'Something went wrong'
}

const getStyles = cacheStyles((theme: Theme) => ({
  scrim: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: theme.rem(theme.spaceMdRem)
  },
  behind: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: theme.overlayBackgroundColor
  },
  sheetScroll: {
    width: '100%',
    maxWidth: theme.rem(30),
    flexGrow: 0
  },
  sheet: {
    backgroundColor: theme.cardBackgroundColor,
    borderRadius: theme.rem(theme.radiusLargeRem),
    borderWidth: 1,
    borderColor: theme.defaultBorderColor,
    padding: theme.rem(theme.spaceMdRem),
    gap: theme.rem(theme.spaceSmRem)
  },
  title: {
    fontFamily: theme.boldTextFont,
    fontSize: theme.rem(1.125),
    fontWeight: '700',
    color: theme.primaryTextColor
  },
  heading: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.75),
    fontWeight: '600',
    letterSpacing: theme.rem(0.04),
    textTransform: 'uppercase',
    color: theme.secondaryTextColor,
    paddingTop: theme.rem(theme.spaceSmRem)
  },
  detail: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.8125),
    color: theme.secondaryTextColor
  },
  error: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875),
    color: theme.dangerColor
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(theme.spaceSmRem),
    paddingVertical: theme.rem(theme.spaceXsRem),
    borderTopWidth: 1,
    borderTopColor: theme.defaultBorderColor
  },
  rowText: {
    flex: 1,
    gap: theme.rem(theme.spaceXsRem)
  },
  name: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.9375),
    fontWeight: '600',
    color: theme.primaryTextColor
  },
  kinds: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.rem(theme.spaceSmRem)
  },
  kind: {
    minHeight: theme.rem(2.75),
    paddingHorizontal: theme.rem(theme.spaceMdRem),
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.radiusPill
  },
  kindOff: {
    backgroundColor: theme.pillBackground
  },
  kindOn: {
    backgroundColor: theme.pillActiveBackground
  },
  kindLabel: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.875),
    fontWeight: '600',
    color: theme.pillTextColor
  },
  kindLabelOn: {
    color: theme.pillActiveTextColor
  }
}))
