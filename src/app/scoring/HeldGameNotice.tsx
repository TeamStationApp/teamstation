import React, { useState } from 'react'
import { Pressable, Text } from 'react-native'

import type { HeldGameControl } from '../sync/useOffline'
import { useTheme } from '../theme/ThemeContext'
import { ScoringButton, ScoringError, ScoringSheet } from './ScoringSheet'

/** The way out of a held game's queue, confirmed before anything goes. */
export const USE_SERVER_COPY = "Use Server's Copy"
export const TRY_AGAIN = 'Try Again'

/**
 * What a game's screen says of the edits the server stopped, as a button:
 * pressed, it asks whether to send a refused game's edits again or to
 * delete what this phone holds for the game and take the server's copy.
 * Opening it, or cancelling, changes nothing.
 */
export function HeldGameNotice(props: {
  held: HeldGameControl
  /**
   * The phone gave its edits up: read the game anew. `arrived` is whether
   * the server's copy came back; until it does the phone has none.
   */
  onSettled: (arrived: boolean) => void
  /** The message as the screen draws it. */
  children: React.ReactNode
}): React.ReactElement {
  const { held, onSettled } = props
  const theme = useTheme()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string>()
  const run = (work: () => Promise<unknown>, settled: boolean): void => {
    if (busy) return
    setBusy(true)
    setProblem(undefined)
    work()
      .then(arrived => {
        setOpen(false)
        if (settled) onSettled(arrived !== false)
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
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Unsent changes"
        accessibilityHint={held.text}
        onPress={() => {
          setProblem(undefined)
          setOpen(true)
        }}
      >
        {props.children}
      </Pressable>
      {open && (
        <ScoringSheet
          title="Unsent Changes"
          onClose={() => {
            if (!busy) setOpen(false)
          }}
        >
          <Text
            style={{
              color: theme.scoringSurface.text,
              fontFamily: theme.regularTextFont
            }}
          >
            {held.text} Using the server's copy deletes what this phone scored
            for this game and has not sent.
          </Text>
          <ScoringError message={problem} />
          {held.retry != null && (
            <ScoringButton
              label={TRY_AGAIN}
              disabled={busy}
              onPress={() => {
                run(held.retry!, false)
              }}
            />
          )}
          <ScoringButton
            label={USE_SERVER_COPY}
            color={theme.scoringSurface.dangerFill}
            disabled={busy}
            onPress={() => {
              run(held.discard, true)
            }}
          />
        </ScoringSheet>
      )}
    </>
  )
}
