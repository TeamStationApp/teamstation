import React, { useEffect, useRef, useState } from 'react'
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
  return {
    finish,
    discard,
    error,
    editing: edit?.game,
    cell: (game, type) => {
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
            selectTextOnFocus
            maxLength={2000}
            editable={!saving}
            autoCapitalize="sentences"
            autoCorrect={false}
            submitBehavior="submit"
            returnKeyType="next"
            onFocus={() => {
              if (input.current != null) onFocus?.(input.current)
            }}
            onChangeText={value => {
              if (pending.current == null && active.current != null) {
                update({ ...active.current, value })
                setError('')
              }
            }}
            onBlur={() => {
              if (error === '') finish().catch(() => undefined)
            }}
            onSubmitEditing={() => {
              if (Platform.OS !== 'web') navigate('down')
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
                      discard()
                    } else
                      navigate(
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
            move({ game: game.id, type: type.id }).catch(() => undefined)
          }}
        >
          <Text style={s.tableText}>{game.umpireNotes[type.id] ?? ''}</Text>
        </Pressable>
      )
    }
  }
}
