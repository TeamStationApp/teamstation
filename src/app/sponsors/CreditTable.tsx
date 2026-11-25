import React, { useState } from 'react'
import { Text, TextInput, View } from 'react-native'

import { Button, usePaneWidth } from '../components'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import type { CreditRow } from './sponsorRules'

/** Below this pane width the row's actions stack. */
const STACK_BELOW = 600

/** The four columns' shares of the table's width. */
const COLUMNS = ['32%', '18%', '22%', '28%'] as const

export interface CreditTableProps<Row extends CreditRow> {
  /** The four column headers, e.g. Logo / Games used / Games remaining / Action. */
  headers: readonly [string, string, string, string]
  rows: readonly Row[]
  /** The row's picture and anything under its name, such as its length. */
  renderItem: (row: Row) => React.ReactNode
  /** The label before each row's allocation field, e.g. "Games allocated". */
  allocationLabel: string
  /** The row action that swaps its picture, e.g. "Change Logo". */
  changeLabel: string
  /** Shown in place of the table when there are no rows. */
  emptyHint: string
  /** Why `allocation` cannot be the row's, or `null`. */
  allocationProblem: (row: Row, allocation: number) => string | null
  onSaveAllocation: (row: Row, allocation: number) => Promise<void>
  onChange: (row: Row) => void
  onDeactivate: (row: Row) => void
  disabled?: boolean
}

/**
 * A sponsor's rows: what each has used and has left, with Change and
 * Deactivate, and a second line to change its allocation. An inactive row
 * is muted, reads "Inactive" and has nothing to press.
 */
export function CreditTable<Row extends CreditRow>({
  headers,
  rows,
  renderItem,
  allocationLabel,
  changeLabel,
  emptyHint,
  allocationProblem,
  onSaveAllocation,
  onChange,
  onDeactivate,
  disabled = false
}: CreditTableProps<Row>): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  const stacked = usePaneWidth() < STACK_BELOW
  if (rows.length === 0)
    return (
      <View style={styles.table}>
        <Text style={styles.empty}>{emptyHint}</Text>
      </View>
    )
  return (
    <View style={styles.table} testID="sponsor-credit-table">
      <View style={[styles.row, styles.headerRow]} accessibilityRole="header">
        {headers.map((header, index) => (
          <Text
            key={header}
            style={[styles.header, { width: COLUMNS[index] }]}
            numberOfLines={2}
          >
            {header}
          </Text>
        ))}
      </View>
      {rows.map(row => (
        <CreditTableRow
          // A new allocation or picture starts the row's field afresh.
          key={`${row.id}:${row.allocation}:${row.version}`}
          row={row}
          stacked={stacked}
          renderItem={renderItem}
          allocationLabel={allocationLabel}
          changeLabel={changeLabel}
          allocationProblem={allocationProblem}
          onSaveAllocation={onSaveAllocation}
          onChange={onChange}
          onDeactivate={onDeactivate}
          disabled={disabled}
        />
      ))}
    </View>
  )
}

function CreditTableRow<Row extends CreditRow>({
  row,
  stacked,
  renderItem,
  allocationLabel,
  changeLabel,
  allocationProblem,
  onSaveAllocation,
  onChange,
  onDeactivate,
  disabled
}: Omit<CreditTableProps<Row>, 'headers' | 'rows' | 'emptyHint'> & {
  row: Row
  stacked: boolean
  disabled: boolean
}): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  const [draft, setDraft] = useState(String(row.allocation))
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const allocation = draft.trim() === '' ? NaN : Number(draft)
  const problem =
    draft === String(row.allocation) ? null : allocationProblem(row, allocation)
  const shown = error !== '' ? error : problem
  const unchanged = allocation === row.allocation
  const save = async (): Promise<void> => {
    setSaving(true)
    setError('')
    try {
      await onSaveAllocation(row, allocation)
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : 'That could not be saved.'
      )
    } finally {
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
        <View style={[styles.cell, { width: COLUMNS[0] }]}>
          {renderItem(row)}
        </View>
        <Text style={[styles.number, { width: COLUMNS[1] }]}>
          {row.used.toLocaleString('en-US')}
        </Text>
        <Text style={[styles.number, { width: COLUMNS[2] }]}>
          {(row.allocation - row.used).toLocaleString('en-US')}
        </Text>
        <View
          style={[
            styles.actions,
            { width: COLUMNS[3] },
            stacked ? styles.actionsStacked : styles.actionsInline
          ]}
        >
          {row.active ? (
            <>
              <Button
                kind="secondary"
                compact
                small={stacked}
                label={changeLabel}
                accessibilityLabel={`${changeLabel}, ${row.name}`}
                disabled={disabled}
                onPress={() => {
                  onChange(row)
                }}
              />
              <Button
                kind="text"
                compact
                small={stacked}
                label="Deactivate"
                textColor={theme.dangerColor}
                accessibilityLabel={`Deactivate ${row.name}`}
                disabled={disabled}
                onPress={() => {
                  onDeactivate(row)
                }}
              />
            </>
          ) : (
            <Text style={styles.inactiveLabel}>Inactive</Text>
          )}
        </View>
      </View>
      {row.active && (
        <View style={styles.allocationLine}>
          <Text style={styles.allocationLabel}>{allocationLabel}</Text>
          <TextInput
            accessibilityLabel={`${allocationLabel}, ${row.name}`}
            value={draft}
            inputMode="numeric"
            keyboardType="number-pad"
            editable={!disabled && !saving}
            style={styles.allocationInput}
            onChangeText={text => {
              setError('')
              setDraft(text.replace(/[^0-9]/g, ''))
            }}
          />
          <Button
            kind="secondary"
            compact
            label="Save"
            accessibilityLabel={`Save ${allocationLabel.toLowerCase()}, ${row.name}`}
            disabled={disabled || saving || unchanged || problem != null}
            busy={saving}
            onPress={() => {
              save().catch(() => undefined)
            }}
          />
          {shown != null && shown !== '' && (
            <Text accessibilityRole="alert" style={styles.error}>
              {shown}
            </Text>
          )}
        </View>
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
    fontSize: theme.rem(0.8125),
    paddingRight: theme.rem(0.25)
  },
  rowBlock: {
    paddingHorizontal: theme.rem(0.75),
    paddingVertical: theme.rem(0.75),
    gap: theme.rem(0.5),
    borderTopWidth: 1,
    borderTopColor: theme.defaultBorderColor
  },
  inactive: { opacity: 0.55 },
  row: { flexDirection: 'row', alignItems: 'center' },
  cell: { paddingRight: theme.rem(0.25) },
  number: {
    color: theme.primaryTextColor,
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.9375)
  },
  actions: { gap: theme.rem(0.25) },
  actionsInline: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center'
  },
  actionsStacked: { flexDirection: 'column', alignItems: 'stretch' },
  inactiveLabel: {
    color: theme.secondaryTextColor,
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.9375)
  },
  allocationLine: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: theme.rem(0.5)
  },
  allocationLabel: {
    color: theme.secondaryTextColor,
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875)
  },
  allocationInput: {
    width: theme.rem(6),
    minHeight: 48,
    paddingHorizontal: theme.rem(0.75),
    borderRadius: theme.rem(0.5),
    borderWidth: 1,
    borderColor: theme.inputBorderColor,
    backgroundColor: theme.inputBackgroundColor,
    color: theme.inputTextColor,
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(1)
  },
  error: {
    width: '100%',
    color: theme.dangerColor,
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875)
  }
}))
