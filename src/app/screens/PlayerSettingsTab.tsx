import React, { useEffect, useState } from 'react'
import { Pressable, Text, View } from 'react-native'

import { ageOn, type BirthMonth, parseBirthMonth } from '../../common/age'
import type { Guardian, RosterEntry, TeamStationClient } from '../../common/api'
import { rosterFullName } from '../../common/names'
import { playerFormError, type PlayerFormValue } from '../../common/playerForm'
import {
  PLAYER_POSITIONS,
  type PlayerPosition,
  type PlayerSettings
} from '../../common/playerSettings'
import { Button, Card, SectionHeader } from '../components'
import { GuardiansModal, kindLabel } from '../components/GuardiansModal'
import { PlayerForm, type PlayerFormFields } from '../components/PlayerForm'
import { lstrings, sprintf } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

export interface PlayerSettingsTabProps {
  client: TeamStationClient
  /**
   * The team the page was opened for: whose jersey and positions these are.
   * Without one, the form is how the player bats and throws instead.
   */
  teamId?: string
  userId: string
  /**
   * Whether to ask the team's roster for the player's whole name, and offer
   * it to edit: the viewer manages that roster (`managesRoster`), which a
   * guardian alone does not. Asked for by default.
   */
  fullNames?: boolean
  /**
   * How they bat and throw after a save, so the page can redraw, and, saved
   * on a team, the player's roster entry there as it now reads.
   */
  onSaved?: (
    hands: Pick<RosterEntry, 'bats' | 'throws'>,
    entry?: RosterEntry
  ) => void
}

/** What the form starts from: a roster entry, or the person away from one. */
type Saved = Pick<
  RosterEntry,
  'jersey' | 'positions' | 'bats' | 'throws' | 'nameDetails' | 'shortName'
>

interface Draft {
  name?: PlayerSettings['name']
  jersey: string
  positions: PlayerPosition[]
  bats: RosterEntry['bats']
  throws: RosterEntry['throws']
}

/**
 * What a roster manager or a guardian sets for one player. Opened from a
 * team, the jersey number and the positions they play there, and the
 * player's name when the roster sent it (`fullNames`); opened from anywhere
 * else, how they bat and throw, which reads the same on every team. Never
 * both: a page opened for one team is about that team.
 *
 * The form starts from the player's roster entry on the team, or from the
 * player. Save is offered only once something differs from it, and sends
 * only what differs, so two coaches changing two different things do not
 * undo each other. A refusal stays on the form, beside what was typed, rather
 * than throwing it away.
 */
export function PlayerSettingsTab(
  props: PlayerSettingsTabProps
): React.ReactElement {
  const { client, teamId, userId, fullNames = true, onSaved } = props
  const theme = useTheme()
  const styles = getStyles(theme)

  const [saved, setSaved] = useState<Saved | undefined>(undefined)
  const [draft, setDraft] = useState<Draft | undefined>(undefined)
  const [loadError, setLoadError] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)

  useEffect(() => {
    let cancelled = false
    setSaved(undefined)
    setDraft(undefined)
    setLoadError(undefined)
    const loaded: Promise<Saved | undefined> =
      teamId == null
        ? client.player(userId).then(({ bats, throws, name }) => ({
            shortName: name,
            jersey: null,
            positions: [],
            bats,
            throws,
            nameDetails: undefined
          }))
        : client
            .roster(teamId, { includeFullNames: fullNames })
            .then(roster =>
              roster.find(row => String(row.userId) === userId && row.isPlayer)
            )
    loaded
      .then(entry => {
        if (cancelled) return
        if (entry == null) {
          setLoadError(lstrings.player_settings_not_on_team)
          return
        }
        setSaved(entry)
        setDraft(draftOf(entry))
      })
      .catch(() => {
        if (!cancelled) setLoadError(lstrings.player_settings_cannot_load)
      })
    return () => {
      cancelled = true
    }
  }, [client, teamId, userId, fullNames])

  if (loadError != null) {
    return (
      <Card>
        <Text style={styles.error}>{loadError}</Text>
      </Card>
    )
  }
  if (saved == null || draft == null) {
    return (
      <Card>
        <Text style={styles.muted}>{lstrings.player_loading}</Text>
      </Card>
    )
  }

  const changes = changesOf(saved, draft)
  const changed = Object.keys(changes).length > 0
  const edit = (next: Partial<Draft>): void => {
    if (busy) return
    setDraft({ ...draft, ...next })
    setDone(false)
  }

  const save = (): void => {
    setBusy(true)
    setError(undefined)
    const stored: Promise<{ saved: Saved; entry?: RosterEntry }> =
      teamId == null
        ? client
            .setPlayerBatsThrows(userId, changes)
            .then(({ bats, throws }) => ({ saved: { ...saved, bats, throws } }))
        : client
            .setPlayerSettings(teamId, userId, changes)
            .then(entry => ({ saved: entry, entry }))
    stored
      .then(({ saved: now, entry }) => {
        setSaved(now)
        setDraft(draftOf(now))
        setDone(true)
        onSaved?.({ bats: now.bats, throws: now.throws }, entry)
      })
      .catch((caught: unknown) => {
        setError(
          caught instanceof Error && caught.message !== ''
            ? caught.message
            : lstrings.player_settings_cannot_save
        )
      })
      .finally(() => {
        setBusy(false)
      })
  }

  const fields: PlayerFormFields =
    teamId == null
      ? { name: 'hidden', hands: 'edit', jersey: false, positions: false }
      : {
          name: draft.name == null ? 'hidden' : 'edit',
          hands: 'edit',
          jersey: true,
          positions: true
        }
  const value: PlayerFormValue = {
    firstName: draft.name?.firstName ?? '',
    lastName: draft.name?.lastName ?? '',
    jersey: draft.jersey,
    throws: draft.throws,
    bats: draft.bats,
    positions: draft.positions
  }
  // A jersey stored before the form checked jerseys is the player's until
  // somebody changes it: only an edited one is held to the digits rule.
  const problem = playerFormError(
    { ...value, jersey: 'jersey' in changes ? value.jersey : '' },
    { nameRequired: draft.name != null }
  )

  return (
    <View style={styles.sections}>
      <Card style={styles.form}>
        <PlayerForm
          value={value}
          fields={fields}
          disabled={busy}
          onChange={next => {
            edit({
              ...(draft.name == null
                ? {}
                : {
                    name: { firstName: next.firstName, lastName: next.lastName }
                  }),
              jersey: next.jersey,
              // In the roster's own order, so positions compare as a set.
              positions: PLAYER_POSITIONS.filter(position =>
                next.positions.includes(position)
              ),
              bats: next.bats,
              throws: next.throws
            })
          }}
        />

        {(error ?? (changed ? problem : undefined)) != null && (
          <Text style={styles.error}>{error ?? problem}</Text>
        )}
        {done && !changed && (
          <Text style={styles.muted}>{lstrings.player_settings_saved}</Text>
        )}

        <Button
          label={lstrings.player_settings_save}
          accessibilityLabel={lstrings.player_settings_save}
          busy={busy}
          disabled={!changed || problem != null}
          onPress={save}
        />
      </Card>
      <BirthMonthSection client={client} userId={userId} />
      {teamId != null && (
        <GuardiansSection
          client={client}
          teamId={teamId}
          userId={userId}
          playerName={saved.shortName}
        />
      )}
    </View>
  )
}

/** A month and a year of birth, never a day, with the age it makes today. */
function BirthMonthSection(props: {
  client: TeamStationClient
  userId: string
}): React.ReactElement | null {
  const { client, userId } = props
  const styles = getStyles(useTheme())
  /** Undefined while loading, and for somebody not shown it at all. */
  const [saved, setSaved] = useState<BirthMonth | null | undefined>(undefined)
  const [month, setMonth] = useState<number | null>(null)
  const [year, setYear] = useState(new Date().getUTCFullYear() - 12)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)

  const show = (birth: BirthMonth | null): void => {
    setSaved(birth)
    setMonth(birth?.month ?? null)
    if (birth != null) setYear(birth.year)
  }

  useEffect(() => {
    let live = true
    client
      .player(userId)
      .then(player => {
        if (!live || player.birthMonth === undefined) return
        show(parseBirthMonth(player.birthMonth) ?? null)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [client, userId])

  if (saved === undefined) return null

  const thisYear = new Date().getUTCFullYear()
  const changed =
    month != null && (saved?.month !== month || saved?.year !== year)
  const send = (birth: BirthMonth | null): void => {
    setBusy(true)
    setError(undefined)
    setNote(undefined)
    client
      .setBirthMonth(userId, birth)
      .then(text => {
        show(parseBirthMonth(text) ?? null)
        setNote(
          birth == null
            ? lstrings.player_birth_cleared
            : lstrings.player_birth_saved
        )
      })
      .catch((caught: unknown) => {
        setError(
          caught instanceof Error && caught.message !== ''
            ? caught.message
            : lstrings.player_settings_cannot_save
        )
      })
      .finally(() => {
        setBusy(false)
      })
  }

  return (
    <View style={styles.section}>
      <SectionHeader title={lstrings.player_birth} />
      <Card style={styles.form}>
        <Text style={styles.muted}>
          {saved == null
            ? lstrings.player_birth_none
            : sprintf(
                lstrings.player_birth_shown,
                monthName(saved.month),
                saved.year,
                ageOn(saved.year, saved.month, new Date())
              )}
        </Text>
        <Text style={styles.muted}>{lstrings.player_birth_detail}</Text>

        <Text style={styles.label}>
          {lstrings.player_birth_month.toUpperCase()}
        </Text>
        <View
          style={styles.chips}
          accessibilityRole="radiogroup"
          accessibilityLabel={lstrings.player_birth_month}
        >
          {MONTHS.map(number => (
            <Chip
              key={number}
              label={monthName(number).slice(0, 3)}
              accessibilityLabel={`${lstrings.player_birth_month} ${monthName(number)}`}
              role="radio"
              on={month === number}
              disabled={busy}
              onPress={() => {
                setMonth(number)
                setNote(undefined)
              }}
            />
          ))}
        </View>

        <Text style={styles.label}>
          {lstrings.player_birth_year.toUpperCase()}
        </Text>
        <View style={styles.stepper}>
          <Chip
            label="−"
            accessibilityLabel={lstrings.player_birth_year_earlier}
            role="button"
            on={false}
            disabled={busy || year <= EARLIEST_YEAR}
            onPress={() => {
              setYear(year - 1)
              setNote(undefined)
            }}
          />
          <Text
            style={styles.year}
            accessibilityLabel={`${lstrings.player_birth_year} ${year}`}
          >
            {year}
          </Text>
          <Chip
            label="+"
            accessibilityLabel={lstrings.player_birth_year_later}
            role="button"
            on={false}
            disabled={busy || year >= thisYear}
            onPress={() => {
              setYear(year + 1)
              setNote(undefined)
            }}
          />
        </View>

        {error != null && <Text style={styles.error}>{error}</Text>}
        {note != null && <Text style={styles.muted}>{note}</Text>}
        <Button
          label={lstrings.player_birth_save}
          accessibilityLabel={lstrings.player_birth_save}
          busy={busy}
          disabled={!changed}
          onPress={() => {
            if (month != null) send({ year, month })
          }}
        />
        <Button
          label={lstrings.player_birth_clear}
          accessibilityLabel={lstrings.player_birth_clear}
          kind="text"
          disabled={busy || saved == null}
          onPress={() => {
            send(null)
          }}
        />
      </Card>
    </View>
  )
}

const MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
const EARLIEST_YEAR = 1900

/** `March`, from 3. */
function monthName(month: number): string {
  return (lstrings as Record<string, string>)[`month_${month}`] ?? String(month)
}

/**
 * The player's guardians and adult family members, and the way to change
 * them: `GuardiansModal`.
 */
function GuardiansSection(props: {
  client: TeamStationClient
  teamId: string
  userId: string
  playerName: string
}): React.ReactElement {
  const { client, teamId, userId, playerName } = props
  const styles = getStyles(useTheme())
  const [guardians, setGuardians] = useState<Guardian[] | undefined>(undefined)
  const [failed, setFailed] = useState(false)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let live = true
    client
      .guardians(teamId, userId)
      .then(list => {
        if (live) setGuardians(list)
      })
      .catch(() => {
        if (live) setFailed(true)
      })
    return () => {
      live = false
    }
  }, [client, teamId, userId])

  return (
    <View style={styles.section}>
      <SectionHeader title={lstrings.guardians_title} />
      <Card style={styles.form}>
        {failed ? (
          <Text style={styles.error}>{lstrings.guardians_cannot_load}</Text>
        ) : guardians == null ? (
          <Text style={styles.muted}>{lstrings.player_loading}</Text>
        ) : guardians.length === 0 ? (
          <Text style={styles.muted}>{lstrings.guardians_none}</Text>
        ) : (
          guardians.map(guardian => (
            <View key={guardian.userId}>
              <Text style={styles.name}>{guardian.name}</Text>
              <Text style={styles.muted}>
                {[kindLabel(guardian.kind), guardian.email]
                  .filter(item => item != null)
                  .join(' \u00b7 ')}
              </Text>
            </View>
          ))
        )}
        <Button
          label={lstrings.guardians_manage}
          accessibilityLabel={lstrings.guardians_manage}
          kind="secondary"
          onPress={() => {
            setOpen(true)
          }}
        />
      </Card>
      {open && (
        <GuardiansModal
          client={client}
          teamId={teamId}
          playerId={userId}
          playerName={playerName}
          onChanged={setGuardians}
          onClose={() => {
            setOpen(false)
          }}
        />
      )}
    </View>
  )
}

/** The form's starting point: what the roster, or the player, says now. */
function draftOf(entry: Saved): Draft {
  const details = entry.nameDetails
  let name: PlayerSettings['name']
  if (details != null) {
    const first = details.firstName?.trim() ?? ''
    const last = details.lastName?.trim() ?? ''
    const full = rosterFullName({ id: 0, ...details })
    // Legacy imports sometimes stored only one part. Preserve the full label
    // when constructing the two edit fields instead of dropping its surname.
    if (first !== '' && last !== '') name = { firstName: first, lastName: last }
    else if (first !== '' && (full === first || full.startsWith(first + ' '))) {
      name = { firstName: first, lastName: full.slice(first.length).trim() }
    } else if (last !== '' && (full === last || full.endsWith(' ' + last))) {
      name = { firstName: full.slice(0, -last.length).trim(), lastName: last }
    } else {
      const [firstName, ...rest] = full.split(/\s+/)
      name = { firstName, lastName: rest.join(' ') }
    }
  }
  return {
    name,
    jersey: entry.jersey ?? '',
    positions: PLAYER_POSITIONS.filter(position =>
      entry.positions.includes(position)
    ),
    bats: entry.bats,
    throws: entry.throws
  }
}

/**
 * The fields that differ from the roster entry, and nothing else. An emptied
 * jersey field is no number; positions compare as a set.
 */
export function changesOf(saved: Saved, draft: Draft): PlayerSettings {
  const changes: PlayerSettings = {}
  const previousName = draftOf(saved).name
  if (draft.name != null && previousName != null) {
    const name = {
      firstName: draft.name.firstName.trim(),
      lastName: draft.name.lastName.trim()
    }
    if (
      name.firstName !== previousName.firstName ||
      name.lastName !== previousName.lastName
    )
      changes.name = name
  }
  const jersey = draft.jersey.trim() === '' ? null : draft.jersey.trim()
  if (jersey !== saved.jersey) changes.jersey = jersey
  const before = draftOf(saved).positions
  if (before.join(' ') !== draft.positions.join(' ')) {
    changes.positions = draft.positions
  }
  if (draft.bats !== saved.bats) changes.bats = draft.bats
  if (draft.throws !== saved.throws) changes.throws = draft.throws
  return changes
}

/** One choice: a position to tick, or a hand to pick. */
function Chip(props: {
  label: string
  accessibilityLabel?: string
  role: 'radio' | 'button'
  on: boolean
  disabled: boolean
  onPress: () => void
}): React.ReactElement {
  const { label, role, on, disabled, onPress } = props
  const styles = getStyles(useTheme())
  return (
    <Pressable
      accessibilityRole={role}
      accessibilityLabel={props.accessibilityLabel ?? label}
      accessibilityState={{
        checked: role === 'radio' ? on : undefined,
        selected: role === 'button' ? on : undefined,
        disabled
      }}
      // react-native-web does not render `aria-checked` from
      // `accessibilityState`, so the web says it directly.
      aria-checked={role === 'radio' ? on : undefined}
      aria-pressed={role === 'button' ? on : undefined}
      disabled={disabled}
      onPress={onPress}
      style={[styles.chip, on ? styles.chipOn : styles.chipOff]}
    >
      <Text style={[styles.chipLabel, on ? styles.chipLabelOn : undefined]}>
        {label}
      </Text>
    </Pressable>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  sections: {
    gap: theme.rem(theme.spaceLgRem)
  },
  section: {
    gap: theme.rem(theme.spaceSmRem)
  },
  stepper: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(theme.spaceMdRem)
  },
  year: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1.125),
    fontWeight: '600',
    color: theme.primaryTextColor,
    minWidth: theme.rem(3.5),
    textAlign: 'center'
  },
  name: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.9375),
    fontWeight: '600',
    color: theme.primaryTextColor
  },
  form: {
    gap: theme.rem(theme.spaceMdRem)
  },
  label: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.75),
    fontWeight: '600',
    letterSpacing: theme.rem(0.04),
    color: theme.secondaryTextColor
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.rem(theme.spaceSmRem)
  },
  chip: {
    minHeight: theme.rem(2.75),
    minWidth: theme.rem(3),
    paddingHorizontal: theme.rem(theme.spaceMdRem),
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.radiusPill
  },
  chipOff: {
    backgroundColor: theme.pillBackground
  },
  chipOn: {
    backgroundColor: theme.pillActiveBackground
  },
  chipLabel: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.875),
    fontWeight: '600',
    color: theme.pillTextColor
  },
  chipLabelOn: {
    color: theme.pillActiveTextColor
  },
  muted: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.9375),
    color: theme.secondaryTextColor
  },
  error: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875),
    color: theme.dangerColor
  }
}))
