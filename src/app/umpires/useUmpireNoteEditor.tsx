import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  type NativeSyntheticEvent,
  Platform,
  Pressable,
  Text,
  TextInput
} from 'react-native'

import type { TeamStationClient } from '../../common/api'
import type { UmpireLevel } from '../../common/umpires'
import type { UmpireGameRow } from '../../common/umpireSchedule'
import { useStableCallback } from '../hooks/useStableCallback'
import { useUmpireStyles } from './shared'
import { useUnsavedWarning } from './UmpireSelector'

export interface NoteCell {
  game: string
  type: string
}
export function nextNoteCell(
  cell: NoteCell,
  games: string[],
  types: string[],
  direction: 'down' | 'next' | 'previous'
): NoteCell | undefined {
  const row = games.indexOf(cell.game)
  const col = types.indexOf(cell.type)
  if (row < 0 || col < 0) return undefined
  const index =
    row * types.length +
    col +
    (direction === 'down' ? types.length : direction === 'next' ? 1 : -1)
  if (index < 0 || index >= games.length * types.length) return undefined
  return {
    game: games[Math.floor(index / types.length)],
    type: types[index % types.length]
  }
}
interface Edit extends NoteCell {
  before: string
  value: string
}

/** One editor per grid; a blur and the following click share the same save. */
/**
 * Selects a web input's whole text now, and once more after the focus if
 * nothing has been typed and the selection fell back to a caret, as Safari
 * may leave it.
 */
function selectOnWeb(into: unknown): void {
  const node = into as HTMLInputElement | null
  if (node == null || typeof node.select !== 'function') return
  node.select()
  const text = node.value
  setTimeout(() => {
    if (
      document.activeElement === node &&
      node.value === text &&
      node.selectionStart === node.selectionEnd
    )
      node.select()
  }, 0)
}

export function useUmpireNoteEditor({
  client,
  scope,
  games,
  types,
  editable,
  onSaved,
  onFocus
}: {
  client: TeamStationClient
  scope: string
  games: UmpireGameRow[]
  types: UmpireLevel[]
  editable: boolean
  onSaved: (cell: NoteCell, value: string) => void
  onFocus?: (input: React.ComponentRef<typeof TextInput>) => void
}): {
  cell: (game: UmpireGameRow, type: UmpireLevel) => React.ReactElement
  finish: () => Promise<boolean>
  discard: () => boolean
  error: string
  /** The game whose row has the editor open. */
  editing: string | undefined
} {
  const s = useUmpireStyles()
  const [edit, setEdit] = useState<Edit>()
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const active = useRef<Edit | undefined>(undefined)
  const input = useRef<React.ComponentRef<typeof TextInput>>(null)
  const pending = useRef<Promise<boolean> | undefined>(undefined)
  const current = useRef(scope)
  const mounted = useRef(true)
  const refocus = useRef(false)
  useUnsavedWarning(edit != null && edit.value !== edit.before)
  current.current = scope
  const live = (): boolean => mounted.current && current.current === scope
  const update = (next: Edit | undefined): void => {
    active.current = next
    setEdit(next)
  }
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    update(undefined)
    setError('')
    setSaving(false)
    pending.current = undefined
    refocus.current = false
  }, [scope])
  useEffect(() => {
    // Native refuses focus while editable=false; wait for the enabled render.
    if (!saving && refocus.current && active.current != null) {
      refocus.current = false
      input.current?.focus()
    }
  }, [saving, error])
  const finish = async (): Promise<boolean> => {
    if (pending.current != null) return await pending.current
    const held = active.current
    if (held == null) return true
    const task = (async (): Promise<boolean> => {
      setError('')
      setSaving(true)
      try {
        const value = held.value.trim() === '' ? '' : held.value
        if (value !== held.before) {
          const saved = await client.saveUmpireNote(
            held.game,
            held.type,
            held.before,
            value
          )
          if (!live()) return false
          onSaved(held, saved.value)
        }
        if (!live()) return false
        update(undefined)
        return true
      } catch (e) {
        if (live()) {
          setError(
            e instanceof Error
              ? e.message
              : 'Could not save this note. Try again.'
          )
          refocus.current = true
        }
        return false
      } finally {
        if (live()) setSaving(false)
      }
    })()
    pending.current = task
    try {
      return await task
    } finally {
      if (pending.current === task) pending.current = undefined
    }
  }
  const discard = (): boolean => {
    if (pending.current != null) return false
    refocus.current = false
    update(undefined)
    setError('')
    return true
  }
  const activate = (cell: NoteCell): void => {
    const game = games.find(g => g.id === cell.game)
    if (
      !live() ||
      !editable ||
      game == null ||
      !types.some(t => t.id === cell.type)
    )
      return
    const value = game.umpireNotes[cell.type] ?? ''
    update({ ...cell, before: value, value })
  }
  const move = async (cell?: NoteCell): Promise<void> => {
    if (await finish()) {
      if (cell != null) activate(cell)
    }
  }
  const navigate = (direction: 'down' | 'next' | 'previous'): void => {
    const held = active.current
    if (held == null || pending.current != null) return
    move(
      nextNoteCell(
        held,
        games.map(g => g.id),
        types.map(t => t.id),
        direction
      )
    ).catch(() => undefined)
  }
  // A row is drawn again only when what its cells show changes, so a cell
  // reaches the editor's latest workings through these.
  const moveTo = useStableCallback(move)
  const navigateTo = useStableCallback(navigate)
  const discardEdit = useStableCallback(discard)
  const finishEdit = useStableCallback(finish)
  const focused = useStableCallback(
    (into: React.ComponentRef<typeof TextInput>): void => {
      onFocus?.(into)
    }
  )
  const cell = useCallback(
    (game: UmpireGameRow, type: UmpireLevel): React.ReactElement => {
      const label = `${type.name}, ${game.home} vs ${game.away}, ${game.date}`
      if (edit?.game === game.id && edit.type === type.id && editable)
        return (
          <TextInput
            key={`${game.id}:${type.id}`}
            ref={input}
            accessibilityLabel={`Edit ${label}`}
            testID={`umpire-note-input-${game.id}-${type.id}`}
            style={[
              s.tableText,
              {
                minHeight: 48,
                padding: 8,
                borderWidth: 1,
                borderColor: '#1565C0',
                width: '100%'
              }
            ]}
            value={edit.value}
            autoFocus
            // On the web the whole note is selected as it takes focus, in
            // `onFocus`: react-native-web's own select runs a timer later, so
            // keys typed before it were selected and typed over.
            selectTextOnFocus={Platform.OS !== 'web'}
            maxLength={2000}
            editable={!saving}
            autoCapitalize="sentences"
            autoCorrect={false}
            submitBehavior="submit"
            returnKeyType="next"
            onFocus={event => {
              // The event's own input: on mount it focuses before its ref
              // is set.
              if (Platform.OS === 'web') selectOnWeb(event.target)
              if (input.current != null) focused(input.current)
            }}
            onChangeText={value => {
              if (pending.current == null && active.current != null) {
                update({ ...active.current, value })
                setError('')
              }
            }}
            onBlur={() => {
              if (error === '') finishEdit().catch(() => undefined)
            }}
            onSubmitEditing={() => {
              if (Platform.OS !== 'web') navigateTo('down')
            }}
            {...(Platform.OS === 'web'
              ? {
                  onKeyPress: (event: NativeSyntheticEvent<unknown>) => {
                    const key = event.nativeEvent as {
                      key: string
                      shiftKey?: boolean
                      isComposing?: boolean
                      keyCode?: number
                    }
                    if (key.isComposing === true || key.keyCode === 229) return
                    if (!['Enter', 'Tab', 'Escape'].includes(key.key)) return
                    event.preventDefault()
                    event.stopPropagation()
                    if (pending.current != null) return
                    if (key.key === 'Escape') {
                      discardEdit()
                    } else
                      navigateTo(
                        key.key === 'Enter'
                          ? 'down'
                          : key.shiftKey === true
                            ? 'previous'
                            : 'next'
                      )
                  }
                }
              : {})}
          />
        )
      if (!editable)
        return (
          <Text style={s.tableText}>{game.umpireNotes[type.id] ?? ''}</Text>
        )
      return (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Edit ${label}`}
          testID={`umpire-note-${game.id}-${type.id}`}
          style={{ minHeight: 48, justifyContent: 'center', width: '100%' }}
          onPress={() => {
            moveTo({ game: game.id, type: type.id }).catch(() => undefined)
          }}
        >
          <Text style={s.tableText}>{game.umpireNotes[type.id] ?? ''}</Text>
        </Pressable>
      )
    },
    [
      discardEdit,
      edit,
      editable,
      error,
      finishEdit,
      focused,
      moveTo,
      navigateTo,
      s,
      saving
    ]
  )
  return {
    finish,
    discard,
    error,
    editing: edit?.game,
    cell
  }
}
