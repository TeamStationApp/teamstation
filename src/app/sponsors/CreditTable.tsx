import React, { useState } from 'react'
import { Pressable, Text, TextInput, View } from 'react-native'

import { Button } from '../components'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import type { CreditRow } from './sponsorRules'

/** Below this table width a row's picture sits over its name. */
const PICTURE_OVER_NAME_BELOW = 480

export interface CreditTableProps<Row extends CreditRow> {
  /** The four column headers, e.g. Logo / Games used / Games remaining / Action. */
  headers: readonly [string, string, string, string]
  rows: readonly Row[]
  /** The row's picture. */
  renderPicture: (row: Row) => React.ReactNode
  /** Anything under the row's name, such as its length. */
  renderDetail?: (row: Row) => React.ReactNode
  /** Tapping a row's name, e.g. to preview it over the sample. */
  onSelect: (row: Row) => void
  /** While true, a name tap does nothing. */
  selectDisabled?: boolean
  /** Shown in place of the table when there are no rows. */
  emptyHint: string
  /** Why `allocation` cannot be the row's, or `null`. */
  allocationProblem: (row: Row, allocation: number) => string | null
  onSaveAllocation: (row: Row, allocation: number) => Promise<void>
  onDeactivate: (row: Row) => void
  disabled?: boolean
}

type RowProps<Row extends CreditRow> = Omit<
  CreditTableProps<Row>,
  'headers' | 'rows' | 'emptyHint'
> & { row: Row; pictureOver: boolean }

/**
 * A sponsor's rows: the picture and name (a blue link that previews it),
 * what each has used and has left, and Deactivate. Tapping the remaining
 * number edits it in place; while the typed number differs, Deactivate
 * becomes Save. An inactive row is muted, reads "Inactive" and has nothing
 * to edit.
 */
export function CreditTable<Row extends CreditRow>({
  headers,
  rows,
  emptyHint,
  ...rowProps
}: CreditTableProps<Row>): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  const [width, setWidth] = useState(0)
  if (rows.length === 0)
    return (
      <View style={styles.table}>
        <Text style={styles.empty}>{emptyHint}</Text>
      </View>
    )
  const pictureOver = width > 0 && width < PICTURE_OVER_NAME_BELOW
  return (
    <View
      style={styles.table}
      testID="sponsor-credit-table"
      onLayout={event => {
        setWidth(event.nativeEvent.layout.width)
      }}
    >
      <View style={[styles.row, styles.headerRow]} accessibilityRole="header">
        {headers.map((header, index) => (
          <Text
            key={header}
            style={[styles.header, COLUMN_STYLES[index](styles)]}
            numberOfLines={2}
          >
            {header}
          </Text>
        ))}
      </View>
      {rows.map(row => (
        <CreditTableRow
          // A saved allocation starts the row's cell afresh.
          key={`${row.id}:${row.allocation}`}
          row={row}
          pictureOver={pictureOver}
          {...rowProps}
        />
      ))}
    </View>
  )
}

type Styles = ReturnType<typeof getStyles>
const COLUMN_STYLES = [
  (styles: Styles) => styles.itemColumn,
  (styles: Styles) => styles.usedColumn,
  (styles: Styles) => styles.remainingColumn,
  (styles: Styles) => styles.actionColumn
] as const

function CreditTableRow<Row extends CreditRow>({
  row,
  pictureOver,
  renderPicture,
  renderDetail,
  onSelect,
  selectDisabled = false,
  allocationProblem,
  onSaveAllocation,
  onDeactivate,
  disabled = false
}: RowProps<Row>): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  const remaining = row.allocation - row.used
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(String(remaining))
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const typed = draft.trim() === '' ? NaN : Number(draft)
  const allocation = row.used + typed
  const changed = editing && draft !== String(remaining)
  const problem = changed ? allocationProblem(row, allocation) : null
  const shown = error !== '' ? error : problem
  const editable = row.active && !disabled
  const cancel = (): void => {
    setEditing(false)
    setDraft(String(remaining))
    setError('')
  }
  const save = async (): Promise<void> => {
    if (!changed || problem != null || saving) return
    setSaving(true)
    setError('')
    try {
      await onSaveAllocation(row, allocation)
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : 'That could not be saved.'
      )
      setSaving(false)
    }
  }
  return (
    <View
      testID={`sponsor-row-${row.id}`}
      accessibilityLabel={row.active ? row.name : `${row.name}, inactive`}
      style={[styles.rowBlock, !row.active && styles.inactive]}
    >
      <View style={styles.row}>
        <View
          style={[
            styles.itemColumn,
            styles.item,
            pictureOver && styles.itemOver
          ]}
        >
          {renderPicture(row)}
          <View style={styles.itemText}>
            <Pressable
              accessibilityRole="link"
              accessibilityLabel={`Preview ${row.name}`}
              disabled={selectDisabled}
              onPress={() => {
                onSelect(row)
              }}
            >
              <Text style={styles.name} numberOfLines={1}>
                {row.name}
              </Text>
            </Pressable>
            {renderDetail?.(row)}
          </View>
        </View>
        <Text style={[styles.number, styles.usedColumn]}>
          {row.used.toLocaleString('en-US')}
        </Text>
        <View style={styles.remainingColumn}>
          {editing ? (
            <TextInput
              accessibilityLabel={`Remaining, ${row.name}`}
              value={draft}
              autoFocus
              selectTextOnFocus
              inputMode="numeric"
              keyboardType="number-pad"
              editable={!saving}
              style={styles.cell}
              onChangeText={text => {
                setError('')
                setDraft(text.replace(/[^0-9]/g, ''))
              }}
              onKeyPress={event => {
                if (event.nativeEvent.key === 'Escape') cancel()
              }}
              onSubmitEditing={() => {
                save().catch(() => undefined)
              }}
              onBlur={() => {
                if (draft === String(remaining)) cancel()
              }}
            />
          ) : editable ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Edit remaining, ${row.name}`}
              style={styles.numberButton}
              onPress={() => {
                setDraft(String(remaining))
                setEditing(true)
              }}
            >
              <Text style={[styles.number, styles.link]}>
                {remaining.toLocaleString('en-US')}
              </Text>
            </Pressable>
          ) : (
            <Text style={styles.number}>
              {remaining.toLocaleString('en-US')}
            </Text>
          )}
        </View>
        <View style={[styles.actionColumn, styles.action]}>
          {!row.active ? (
            <Text style={styles.inactiveLabel}>Inactive</Text>
          ) : changed ? (
            // The Schedule's Add Game button: same size and colour.
            <Button
              label="Save"
              color={theme.scoreActionColor}
              accessibilityLabel={`Save remaining, ${row.name}`}
              disabled={disabled || saving || problem != null}
              busy={saving}
              onPress={() => {
                save().catch(() => undefined)
              }}
            />
          ) : (
            <Button
              kind="text"
              small
              fit={0.6}
              style={styles.deactivate}
              label="Deactivate"
              textColor={theme.dangerColor}
              accessibilityLabel={`Deactivate ${row.name}`}
              disabled={disabled || editing}
              onPress={() => {
                onDeactivate(row)
              }}
            />
          )}
        </View>
      </View>
      {shown != null && shown !== '' && (
        <Text accessibilityRole="alert" style={styles.error}>
          {shown}
        </Text>
      )}
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  table: {
    borderRadius: theme.rem(0.75),
    borderWidth: 1,
    borderColor: theme.defaultBorderColor,
    backgroundColor: theme.cardBackgroundColor,
    overflow: 'hidden'
  },
  empty: {
    padding: theme.rem(1),
    color: theme.secondaryTextColor,
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.9375)
  },
  headerRow: {
    paddingHorizontal: theme.rem(0.75),
    paddingVertical: theme.rem(0.5),
    backgroundColor: theme.containerBackgroundColor
  },
  header: {
    color: theme.secondaryTextColor,
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.8125)
  },
  rowBlock: {
    paddingHorizontal: theme.rem(0.75),
    paddingVertical: theme.rem(0.5),
    gap: theme.rem(0.25),
    borderTopWidth: 1,
    borderTopColor: theme.defaultBorderColor
  },
  inactive: { opacity: 0.55 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    columnGap: theme.rem(0.5)
  },
  itemColumn: { flex: 1, minWidth: 0 },
  usedColumn: { width: theme.rem(4.75) },
  remainingColumn: { width: theme.rem(4.75) },
  actionColumn: { width: theme.rem(5.5) },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(0.5),
    overflow: 'hidden'
  },
  itemOver: {
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: theme.rem(0.25)
  },
  itemText: { flexShrink: 1, minWidth: 0, maxWidth: '100%' },
  name: {
    color: theme.linkTextColor,
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.9375)
  },
  number: {
    color: theme.primaryTextColor,
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.9375)
  },
  numberButton: {
    alignSelf: 'flex-start',
    minHeight: 36,
    justifyContent: 'center'
  },
  link: {
    color: theme.linkTextColor,
    fontFamily: theme.semiBoldTextFont
  },
  cell: {
    width: '100%',
    minHeight: 36,
    paddingHorizontal: theme.rem(0.375),
    borderRadius: theme.rem(0.25),
    borderWidth: 2,
    borderColor: theme.linkTextColor,
    backgroundColor: theme.inputBackgroundColor,
    color: theme.inputTextColor,
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.9375)
  },
  action: { alignItems: 'flex-start' },
  deactivate: { paddingHorizontal: 0 },
  inactiveLabel: {
    color: theme.secondaryTextColor,
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.9375)
  },
  error: {
    color: theme.dangerColor,
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875)
  }
}))
