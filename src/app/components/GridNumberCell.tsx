import React, { useEffect, useRef, useState } from 'react'
import {
  type NativeSyntheticEvent,
  Platform,
  Pressable,
  type StyleProp,
  Text,
  TextInput,
  type TextStyle,
  View,
  type ViewStyle
} from 'react-native'

import {
  BUFFER_MINUTES,
  GAME_MINUTES,
  MAX_GAMES
} from '../../common/seasonScheduling'

/** A season setting the grid edits in place, as a bare number. */
export type NumberColumn =
  'gameMinutes' | 'bufferMinutes' | 'regularGames' | 'exhibitionGames'

/** The number columns in the grid's order, which Tab follows. */
export const NUMBER_COLUMNS: NumberColumn[] = [
  'gameMinutes',
  'bufferMinutes',
  'regularGames',
  'exhibitionGames'
]

/** What each number column accepts. */
export const GRID_NUMBERS: Record<
  NumberColumn,
  { min: number; max: number; step: number }
> = {
  gameMinutes: { ...GAME_MINUTES, step: 5 },
  bufferMinutes: { ...BUFFER_MINUTES, step: 5 },
  regularGames: { min: 0, max: MAX_GAMES, step: 1 },
  exhibitionGames: { min: 0, max: MAX_GAMES, step: 1 }
}

export function isNumberColumn(column: string): column is NumberColumn {
  return (NUMBER_COLUMNS as string[]).includes(column)
}

/** Why a cell's text can't be saved, or undefined when it can. */
export function numberRefusal(
  column: NumberColumn,
  title: string,
  text: string
): string | undefined {
  const rule = GRID_NUMBERS[column]
  const value = Number(text)
  if (
    text === '' ||
    !Number.isInteger(value) ||
    value < rule.min ||
    value > rule.max ||
    value % rule.step !== 0
  )
    return `${title}: choose ${rule.min} to ${rule.max}${rule.step === 1 ? '' : `, in ${rule.step}-minute steps`}.`
  return undefined
}

export interface GridCell {
  seasonId: string
  column: NumberColumn
}

/**
 * The number cell before or after this one, row by row: a season's four
 * numbers, then the next season's. Undefined past either end.
 */
export function nextGridCell(
  cell: GridCell,
  seasonIds: string[],
  columns: NumberColumn[],
  direction: 'next' | 'previous'
): GridCell | undefined {
  const row = seasonIds.indexOf(cell.seasonId)
  const col = columns.indexOf(cell.column)
  if (row < 0 || col < 0) return undefined
  const index = row * columns.length + col + (direction === 'next' ? 1 : -1)
  if (index < 0 || index >= seasonIds.length * columns.length) return undefined
  return {
    seasonId: seasonIds[Math.floor(index / columns.length)],
    column: columns[index % columns.length]
  }
}

type Input = React.ComponentRef<typeof TextInput>

/** Selects the whole text of a focused input: the DOM's or the native one. */
function selectAll(input: Input | null, length: number): void {
  const node = input as unknown as {
    select?: () => void
    setSelection?: (start: number, end: number) => void
  } | null
  if (node?.select != null) node.select()
  else node?.setSelection?.(0, length)
}

interface Edit extends GridCell {
  before: string
  value: string
}

/**
 * One cell of the grid's number columns, like a spreadsheet's: a bare number
 * that turns into a text field with its whole number selected when tapped.
 */
export function GridNumberCell({
  label,
  testID,
  value,
  style,
  textStyle,
  editing,
  onOpen
}: {
  /** "<Season> <column title>", which the number follows. */
  label: string
  testID: string
  value: number
  style: StyleProp<ViewStyle>
  textStyle: StyleProp<TextStyle>
  /** The text field's props while this cell is open. */
  editing?: React.ComponentProps<typeof TextInput> & {
    ref: React.Ref<Input>
  }
  onOpen: () => void
}): React.ReactElement {
  if (editing != null)
    return (
      <View style={style}>
        <TextInput
          accessibilityLabel={`Edit ${label}`}
          testID={testID.replace('grid-cell-', 'grid-cell-input-')}
          {...editing}
          style={[
            textStyle,
            {
              width: '100%',
              minHeight: 32,
              paddingHorizontal: 4,
              borderWidth: 1,
              borderColor: '#1565C0'
            }
          ]}
        />
      </View>
    )
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${value}`}
      testID={testID}
      style={({ pressed }) => [style, pressed && { opacity: 0.6 }]}
      onPress={onOpen}
    >
      <Text style={textStyle}>{value}</Text>
    </Pressable>
  )
}

/**
 * The grid's number cells, one open at a time. Opening another cell, Tab or
 * leaving the cell saves the open one first; a refused or failed save keeps
 * it open, with its text selected, and names why.
 */
export function useGridNumberEditor({
  seasonIds,
  valueOf,
  titleOf,
  onSave
}: {
  seasonIds: string[]
  valueOf: (seasonId: string, column: NumberColumn) => number | undefined
  titleOf: (column: NumberColumn) => string
  /** Resolves null once saved, or the message saying why it wasn't. */
  onSave: (
    seasonId: string,
    column: NumberColumn,
    value: number
  ) => Promise<string | null>
}): {
  cell: (props: {
    seasonId: string
    seasonName: string
    column: NumberColumn
    style: StyleProp<ViewStyle>
    textStyle: StyleProp<TextStyle>
  }) => React.ReactElement
  error: string
} {
  const [edit, setEdit] = useState<Edit>()
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  // Bumped by each refusal, so the same message twice still reselects.
  const [refusals, setRefusals] = useState(0)
  const active = useRef<Edit | undefined>(undefined)
  const input = useRef<Input>(null)
  const pending = useRef<Promise<boolean> | undefined>(undefined)
  const mounted = useRef(true)
  const refocus = useRef(false)
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
    // Native refuses focus while editable=false; wait for the enabled render.
    if (!saving && refocus.current && active.current != null) {
      refocus.current = false
      input.current?.focus()
      selectAll(input.current, active.current.value.length)
    }
  }, [saving, error, refusals])
  const refuse = (message: string): false => {
    setError(message)
    setRefusals(n => n + 1)
    refocus.current = true
    return false
  }
  const finish = async (): Promise<boolean> => {
    if (pending.current != null) return await pending.current
    const held = active.current
    if (held == null) return true
    if (held.value !== '' && Number(held.value) === Number(held.before)) {
      update(undefined)
      setError('')
      return true
    }
    const refused = numberRefusal(held.column, titleOf(held.column), held.value)
    if (refused != null) return refuse(refused)
    const task = (async (): Promise<boolean> => {
      setError('')
      setSaving(true)
      try {
        const failure = await onSave(
          held.seasonId,
          held.column,
          Number(held.value)
        )
        if (!mounted.current) return false
        if (failure != null) return refuse(failure)
        update(undefined)
        return true
      } catch (e) {
        if (!mounted.current) return false
        return refuse(
          e instanceof Error && e.message !== ''
            ? e.message
            : 'That could not be saved. Try again.'
        )
      } finally {
        if (mounted.current) setSaving(false)
      }
    })()
    pending.current = task
    try {
      return await task
    } finally {
      if (pending.current === task) pending.current = undefined
    }
  }
  const discard = (): void => {
    if (pending.current != null) return
    refocus.current = false
    update(undefined)
    setError('')
  }
  const activate = (cell: GridCell): void => {
    const value = valueOf(cell.seasonId, cell.column)
    if (!mounted.current || value == null) return
    update({ ...cell, before: String(value), value: String(value) })
  }
  const move = async (cell?: GridCell): Promise<void> => {
    if (await finish()) {
      if (cell != null) activate(cell)
    }
  }
  const navigate = (direction: 'next' | 'previous'): void => {
    const held = active.current
    if (held == null || pending.current != null) return
    move(nextGridCell(held, seasonIds, NUMBER_COLUMNS, direction)).catch(
      () => undefined
    )
  }
  const save = (): void => {
    finish().catch(() => undefined)
  }
  return {
    error,
    cell: ({ seasonId, seasonName, column, style, textStyle }) => {
      const open = edit?.seasonId === seasonId && edit.column === column
      return (
        <GridNumberCell
          key={column}
          label={`${seasonName} ${titleOf(column)}`}
          testID={`grid-cell-${seasonId}-${column}`}
          value={valueOf(seasonId, column) ?? 0}
          style={style}
          textStyle={textStyle}
          onOpen={() => {
            move({ seasonId, column }).catch(() => undefined)
          }}
          editing={
            !open
              ? undefined
              : {
                  ref: input,
                  value: edit.value,
                  autoFocus: true,
                  selectTextOnFocus: true,
                  maxLength: 3,
                  editable: !saving,
                  // A return key on every platform, so Return can save:
                  // iOS's number pad has none.
                  keyboardType:
                    Platform.OS === 'ios'
                      ? 'numbers-and-punctuation'
                      : 'number-pad',
                  ...(Platform.OS === 'web'
                    ? { inputMode: 'numeric' as const }
                    : {}),
                  returnKeyType: 'done',
                  submitBehavior: 'blurAndSubmit',
                  onChangeText: text => {
                    if (pending.current == null && active.current != null) {
                      update({
                        ...active.current,
                        value: text.replace(/\D/g, '')
                      })
                      setError('')
                    }
                  },
                  // iOS ignores selectTextOnFocus for a field that is focused
                  // as it mounts, and puts the caret after the number; a
                  // selection made as the focus lands is replaced by that
                  // caret too. Select the whole number a tick later, so
                  // typing replaces it on every platform.
                  onFocus: () => {
                    setTimeout(() => {
                      if (active.current != null)
                        selectAll(input.current, active.current.value.length)
                    }, 0)
                  },
                  onBlur: () => {
                    if (error === '') save()
                  },
                  onSubmitEditing: () => {
                    if (Platform.OS !== 'web') save()
                  },
                  ...(Platform.OS === 'web'
                    ? {
                        onKeyPress: (event: NativeSyntheticEvent<unknown>) => {
                          const key = event.nativeEvent as {
                            key: string
                            shiftKey?: boolean
                            isComposing?: boolean
                            keyCode?: number
                          }
                          if (key.isComposing === true || key.keyCode === 229)
                            return
                          if (!['Enter', 'Tab', 'Escape'].includes(key.key))
                            return
                          event.preventDefault()
                          event.stopPropagation()
                          if (pending.current != null) return
                          if (key.key === 'Escape') discard()
                          else if (key.key === 'Enter') save()
                          else
                            navigate(
                              key.shiftKey === true ? 'previous' : 'next'
                            )
                        }
                      }
                    : {})
                }
          }
        />
      )
    }
  }
}
