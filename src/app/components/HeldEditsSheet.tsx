import React, { useEffect, useState } from 'react'
import { Pressable, Text, View } from 'react-native'

import {
  HELD_GAME_CONSEQUENCE,
  HELD_TEAM_CONSEQUENCE,
  TRY_AGAIN,
  USE_SERVER_COPY
} from '../scoring/HeldGameNotice'
import { EDITS_PLACE } from '../sync/editsPlace'
import type { DiscardOutcome } from '../sync/outbox'
import {
  HELD_GAME_UNNAMED,
  HELD_TEAM_UNNAMED,
  type HeldEdit,
  heldEditKey,
  heldEditRetries,
  heldEditText,
  SERVER_COPY_PENDING
} from '../sync/useOffline'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { CancelAction } from './CancelAction'
import { Sheet } from './Sheet'

/** A team's discard went through, and the server's roster did not come back. */
export const TEAM_COPY_PENDING = `The players added ${EDITS_PLACE.on} are gone, and the server's copy of the roster has not arrived yet. Try again once ${EDITS_PLACE.backOnline}.`
/** A discard that found part of the queue on its way: nothing was dropped. */
export const HELD_SENDING =
  'Part of this is being sent right now, so nothing was deleted. Try again in a moment.'

export interface HeldEditActions {
  /** Sends the held queue again, from where the server stopped. */
  retry: (edit: HeldEdit) => Promise<void>
  /**
   * Deletes what the phone holds for it and reads the server's copy, unless
   * part of it is on its way; what that came to (`discardHeld`).
   */
  discard: (edit: HeldEdit) => Promise<DiscardOutcome>
}

export interface HeldEditsSheetProps {
  /** Every held queue on the phone (`heldEdits`). */
  edits: HeldEdit[]
  /** Their names by `heldEditKey` (`useHeldNames`). */
  names: Record<string, string>
  actions: HeldEditActions
  onClose: () => void
}

export const HELD_EDITS_TITLE = 'Edits Not Sent'

/** A held queue's name, or what stands for one the phone cannot name. */
export function heldEditName(
  edit: HeldEdit,
  names: Record<string, string>
): string {
  return (
    names[heldEditKey(edit)] ??
    (edit.kind === 'game' ? HELD_GAME_UNNAMED : HELD_TEAM_UNNAMED)
  )
}

/**
 * What the not-sent banner opens: every game and team whose edits the
 * server stopped, each by name with what the server said and what taking
 * the server's copy costs, and for each a way to send them again or to take
 * that copy. A copy that did not come back is said after its row has gone.
 * It closes itself once nothing is held and nothing is left to say; Cancel
 * changes nothing.
 */
export function HeldEditsSheet(
  props: HeldEditsSheetProps
): React.ReactElement | null {
  const { edits, names, actions, onClose } = props
  const styles = getStyles(useTheme())
  // What became of a discard whose row is gone, by `heldEditKey`.
  const [gone, setGone] = useState<Array<{ key: string; text: string }>>([])
  const discard = async (
    edit: HeldEdit,
    name: string
  ): Promise<string | undefined> => {
    const outcome = await actions.discard(edit)
    if (outcome === 'arrived') return undefined
    // Part of it was on its way, and nothing was dropped: said on its row.
    if (outcome === 'inflight') return HELD_SENDING
    // Dropped, whenever its row goes: said by the sheet, which outlives it.
    const key = heldEditKey(edit)
    setGone(said => [
      ...said.filter(line => line.key !== key),
      {
        key,
        text: `${name}: ${edit.kind === 'game' ? SERVER_COPY_PENDING : TEAM_COPY_PENDING}`
      }
    ])
    return undefined
  }
  const done = edits.length === 0 && gone.length === 0
  useEffect(() => {
    if (done) onClose()
  }, [done, onClose])
  if (done) return null
  return (
    <Sheet
      onClose={onClose}
      closeLabel="Close"
      testID="heldEditsSheet"
      style={styles.sheet}
    >
      <Text style={styles.title}>{HELD_EDITS_TITLE}</Text>
      {edits.map(edit => (
        <HeldEditRow
          key={heldEditKey(edit)}
          edit={edit}
          name={heldEditName(edit, names)}
          retry={actions.retry}
          discard={discard}
        />
      ))}
      {gone.map(line => (
        <Text
          key={line.key}
          testID="heldEditGone"
          accessibilityRole="alert"
          style={styles.problem}
        >
          {line.text}
        </Text>
      ))}
      <CancelAction destructivePrimary label="Cancel" onPress={onClose} />
    </Sheet>
  )
}

function HeldEditRow(props: {
  edit: HeldEdit
  name: string
  retry: HeldEditActions['retry']
  discard: (edit: HeldEdit, name: string) => Promise<string | undefined>
}): React.ReactElement {
  const { edit, name } = props
  const styles = getStyles(useTheme())
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string>()
  const run = (work: () => Promise<string | undefined>): void => {
    if (busy) return
    setBusy(true)
    setProblem(undefined)
    work()
      .then(next => {
        setProblem(next)
      })
      .catch((caught: unknown) => {
        setProblem(
          caught instanceof Error ? caught.message : 'That did not work. Retry.'
        )
      })
      .finally(() => {
        setBusy(false)
      })
  }
  const button = (
    label: string,
    destructive: boolean,
    work: () => Promise<string | undefined>
  ): React.ReactElement => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}, ${name}`}
      accessibilityState={{ disabled: busy }}
      disabled={busy}
      onPress={() => {
        run(work)
      }}
      style={({ pressed }) => [
        styles.action,
        (pressed || busy) && styles.pressed
      ]}
    >
      <Text style={[styles.actionLabel, destructive && styles.destructive]}>
        {label}
      </Text>
    </Pressable>
  )
  return (
    <View testID={`heldEdit-${edit.kind}-${edit.id}`} style={styles.row}>
      <Text style={styles.name}>{name}</Text>
      <Text style={styles.detail}>{heldEditText(edit)}</Text>
      <Text style={styles.detail}>
        {edit.kind === 'game' ? HELD_GAME_CONSEQUENCE : HELD_TEAM_CONSEQUENCE}
      </Text>
      {problem != null && (
        <Text accessibilityRole="alert" style={styles.problem}>
          {problem}
        </Text>
      )}
      <View style={styles.actions}>
        {heldEditRetries(edit) &&
          button(TRY_AGAIN, false, async () => {
            await props.retry(edit)
            return undefined
          })}
        {button(
          USE_SERVER_COPY,
          true,
          async () => await props.discard(edit, name)
        )}
      </View>
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  // The card, title and rows of the app's other sheets (`ChoiceSheet`).
  sheet: {
    backgroundColor: theme.cardBackgroundColor,
    borderWidth: 1,
    borderColor: theme.defaultBorderColor,
    padding: theme.rem(theme.spaceLgRem),
    gap: theme.rem(theme.spaceSmRem)
  },
  title: {
    fontFamily: theme.boldTextFont,
    fontSize: theme.rem(1.125),
    fontWeight: '700' as const,
    color: theme.primaryTextColor
  },
  row: {
    padding: theme.rem(theme.spaceMdRem),
    borderRadius: theme.rem(theme.radiusRem),
    borderWidth: 1,
    borderColor: theme.defaultBorderColor,
    gap: theme.rem(theme.spaceXsRem)
  },
  name: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1),
    fontWeight: '600' as const,
    color: theme.primaryTextColor
  },
  detail: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.8125),
    color: theme.secondaryTextColor
  },
  problem: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.8125),
    color: theme.dangerColor
  },
  actions: {
    flexDirection: 'row' as const,
    gap: theme.rem(theme.spaceSmRem),
    marginTop: theme.rem(theme.spaceXsRem)
  },
  action: {
    flexGrow: 1,
    alignItems: 'center' as const,
    paddingVertical: theme.rem(theme.spaceSmRem),
    borderRadius: theme.rem(theme.radiusRem),
    borderWidth: 1,
    borderColor: theme.defaultBorderColor
  },
  actionLabel: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.9375),
    color: theme.linkTextColor
  },
  destructive: { color: theme.dangerColor },
  pressed: { opacity: 0.6 }
}))
