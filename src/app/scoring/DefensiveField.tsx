import React, { useState } from 'react'
import { Pressable, Text, View } from 'react-native'

import { lstrings } from '../locales/strings'
import { useTheme } from '../theme/ThemeContext'
import { DefensiveFieldArt } from './DefensiveFieldArt'
import { RosterDrag } from './RosterDrag'
import { useScoringSheetTheme } from './scoringSheetTheme'
import { type Position, POSITIONS } from './scoringTypes'

/**
 * Position centres as percentages of the top-down field, on six rows (CF;
 * LF RF; SS 2B; 3B 1B; P; C) 16 apart, so no row ever holds three cards.
 */
export const DEFENSE_LOCATIONS: Record<Position, readonly [number, number]> = {
  CF: [50, 8],
  LF: [17, 24],
  RF: [83, 24],
  SS: [31, 40],
  '2B': [69, 40],
  '3B': [17, 56],
  '1B': [83, 56],
  P: [50, 73],
  C: [50, 90]
}

/** How far above its centre a card's top sits, in percent of the field. */
export const CARD_TOP_OFFSET = 7
/** A card is this share of the field's height, at most `MAX_CARD_HEIGHT`. */
const CARD_HEIGHT_RATIO = 0.14
const MAX_CARD_HEIGHT = 46
/** Field names are 25% larger than the scoring sheet's 11- and 10-point text. */
export const FIELD_NAME_SCALE = 1.25
const TWO_LINE_FONT = 11 * FIELD_NAME_SCALE
const SINGLE_LINE_FONT = 10 * FIELD_NAME_SCALE
const CARD_PADDING = 2
const CARD_BORDER = 1
const lineHeightOf = (fontSize: number): number => Math.round(fontSize * 1.2)
/** Two lines, their padding and the border. */
const TWO_LINE_CARD =
  2 * lineHeightOf(TWO_LINE_FONT) + 2 * CARD_PADDING + 2 * CARD_BORDER
/** One line, its padding and the border. */
const SINGLE_LINE_CARD =
  lineHeightOf(SINGLE_LINE_FONT) + 2 * CARD_PADDING + 2 * CARD_BORDER

export interface FieldCardMetrics {
  cardHeight: number
  /** "P · Name" on one line, rather than the position above the name. */
  singleLine: boolean
  /** Too short for a name: the position alone, with no vertical padding. */
  positionOnly: boolean
  fontSize: number
  lineHeight: number
  /** What the card's text, padding and border need, never above `cardHeight`. */
  contentHeight: number
}

/** A position card's size and text for a field viewport of this height. */
export function fieldCardMetrics(
  viewportHeight: number,
  compact: boolean
): FieldCardMetrics {
  const cardHeight =
    viewportHeight > 0
      ? Math.min(MAX_CARD_HEIGHT, viewportHeight * CARD_HEIGHT_RATIO)
      : MAX_CARD_HEIGHT
  if (cardHeight < SINGLE_LINE_CARD) {
    const lineHeight = Math.max(5, cardHeight - 2 * CARD_BORDER)
    return {
      cardHeight,
      singleLine: true,
      positionOnly: true,
      fontSize: lineHeight,
      lineHeight,
      contentHeight: lineHeight + 2 * CARD_BORDER
    }
  }
  if (compact || cardHeight < TWO_LINE_CARD)
    return {
      cardHeight,
      singleLine: true,
      positionOnly: false,
      fontSize: SINGLE_LINE_FONT,
      lineHeight: lineHeightOf(SINGLE_LINE_FONT),
      contentHeight: SINGLE_LINE_CARD
    }
  return {
    cardHeight,
    singleLine: false,
    positionOnly: false,
    fontSize: TWO_LINE_FONT,
    lineHeight: lineHeightOf(TWO_LINE_FONT),
    contentHeight: TWO_LINE_CARD
  }
}

/**
 * The cards whose vertical extents overlap, grouped top to bottom and each
 * group left to right, for a card `cardHeightPercent` of the field tall.
 */
export function fieldRows(
  locations: Record<Position, readonly [number, number]>,
  cardHeightPercent: number
): Position[][] {
  const cards = POSITIONS.map(position => {
    const [x, y] = locations[position]
    const top = y - CARD_TOP_OFFSET
    return { position, x, top, bottom: top + cardHeightPercent }
  }).sort((a, b) => (a.top === b.top ? a.x - b.x : a.top - b.top))
  const rows: Array<{ bottom: number; positions: Position[] }> = []
  for (const card of cards) {
    const row = rows[rows.length - 1]
    if (row != null && card.top < row.bottom) {
      row.positions.push(card.position)
      row.bottom = Math.max(row.bottom, card.bottom)
    } else rows.push({ bottom: card.bottom, positions: [card.position] })
  }
  return rows.map(row => row.positions)
}

/** Help's and Clear's height, and their inset from the field's corners. */
export const DEFENSE_CONTROL_HEIGHT = 22
export const DEFENSE_CONTROL_INSET = 4
/** The row Help and Clear take above a field too short for its corners. */
export const DEFENSE_CONTROL_ROW = 24
/**
 * The shortest field whose top corners hold Help and Clear: LF's and RF's
 * tops sit 17% down, 27 points here, clear of a 22-point control inset by 4.
 */
export const DEFENSE_CORNERS_MINIMUM = 160
/**
 * Where Help and Clear go: the field's top corners, over the outfield beside
 * CF, or a row of their own above a shorter field.
 */
export function defenseControlsPlacement(
  viewportHeight: number
): 'corners' | 'row' {
  return viewportHeight >= DEFENSE_CORNERS_MINIMUM ? 'corners' : 'row'
}

/**
 * Every position remains visible while only the roster scrolls. An assigned
 * card drags with no hold, so its player moves to an empty position or swaps
 * with the fielder at an occupied one; a tap clears it.
 */
export function DefensiveField({
  defense,
  compact = false,
  display,
  spoken = display,
  onPlace,
  onClear,
  onHelp,
  onClearAll
}: {
  defense: Partial<Record<Position, number | null>>
  compact?: boolean
  display: (id: number) => string
  /**
   * What a screen reader says for a fielder; the drawn name by default. A
   * short drawn name can be said in full.
   */
  spoken?: (id: number) => string
  onPlace: (id: number, position: Position) => void
  onClear: (position: Position) => void
  /** Help, at the field's top left, which opens the tab's help. */
  onHelp?: () => void
  /** Clear, at the field's top right, which empties every position. */
  onClearAll?: () => void
}): React.ReactElement {
  const { scoringSurface: surface } = useScoringSheetTheme()
  const [viewportHeight, setViewportHeight] = useState(0)
  const { cardHeight, singleLine, positionOnly, fontSize, lineHeight } =
    fieldCardMetrics(viewportHeight, compact)
  // Unmeasured, the field is taken to be tall enough for its corners.
  const corners =
    viewportHeight === 0 ||
    defenseControlsPlacement(viewportHeight) === 'corners'
  const controls = (
    <>
      {onHelp != null && (
        <FieldControl
          label={lstrings.roster_help}
          accessibilityLabel={lstrings.roster_defense_help_label}
          side="left"
          corner={corners}
          onPress={onHelp}
        />
      )}
      {onClearAll != null && (
        <FieldControl
          label={lstrings.roster_clear}
          accessibilityLabel={lstrings.roster_clear_defense}
          side="right"
          corner={corners}
          onPress={onClearAll}
        />
      )}
    </>
  )
  return (
    <>
      {!corners && (
        <View
          testID="Defense controls row"
          style={{
            height: DEFENSE_CONTROL_ROW,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between'
          }}
        >
          {controls}
        </View>
      )}
      <View
        testID="Defensive field viewport"
        style={{ flexBasis: 330, flexGrow: 0, flexShrink: 1, minHeight: 60 }}
        onLayout={event => {
          setViewportHeight(event.nativeEvent.layout.height)
        }}
      >
        <View
          testID="Defensive field"
          style={{
            flex: 1,
            minHeight: 0,
            backgroundColor: surface.canvas,
            borderRadius: 8
          }}
        >
          <DefensiveFieldArt />
          {POSITIONS.map(position => {
            const id = defense[position]
            const [x, y] = DEFENSE_LOCATIONS[position]
            const assigned = id != null
            const name = assigned ? display(id) : 'Unassigned'
            const said = assigned ? spoken(id) : 'Unassigned'
            const textColor = assigned
              ? surface.activeText
              : surface.badges.red.text
            return (
              <View
                key={position}
                style={{
                  position: 'absolute',
                  width: '30%',
                  left: `${x - 15}%`,
                  top: `${y - CARD_TOP_OFFSET}%`
                }}
              >
                <RosterDrag
                  targetId={`defense-${position}`}
                  playerId={assigned ? id : undefined}
                  immediate
                  fixed
                  value={assigned ? said : undefined}
                  label={assigned ? `Clear ${position}` : `Assign ${position}`}
                  onTap={
                    assigned
                      ? () => {
                          onClear(position)
                        }
                      : undefined
                  }
                  onDropPlayer={player => {
                    onPlace(player, position)
                  }}
                >
                  <View
                    testID={`Defense ${position} card`}
                    style={{
                      height: cardHeight,
                      paddingHorizontal: singleLine ? 1 : 3,
                      paddingVertical: positionOnly ? 0 : CARD_PADDING,
                      borderWidth: CARD_BORDER,
                      borderStyle: assigned ? 'solid' : 'dashed',
                      borderColor: assigned
                        ? surface.accent
                        : surface.badges.red.border,
                      borderRadius: 5,
                      backgroundColor: assigned
                        ? surface.active
                        : surface.badges.red.background,
                      alignItems: 'center',
                      justifyContent: 'center'
                    }}
                  >
                    {positionOnly ? (
                      <Text
                        numberOfLines={1}
                        accessibilityLabel={`${position} · ${said}`}
                        style={{
                          color: textColor,
                          fontSize,
                          lineHeight,
                          fontWeight: '700',
                          width: '100%',
                          textAlign: 'center'
                        }}
                      >
                        {position}
                      </Text>
                    ) : singleLine ? (
                      <Text
                        numberOfLines={1}
                        style={{
                          color: textColor,
                          fontSize,
                          lineHeight,
                          width: '100%',
                          textAlign: 'center'
                        }}
                      >
                        {`${position} · ${name}`}
                      </Text>
                    ) : (
                      <>
                        <Text
                          style={{
                            color: textColor,
                            fontSize,
                            lineHeight,
                            fontWeight: '700'
                          }}
                        >
                          {position}
                        </Text>
                        <Text
                          numberOfLines={1}
                          style={{
                            color: textColor,
                            fontSize,
                            lineHeight,
                            width: '100%',
                            textAlign: 'center'
                          }}
                        >
                          {name}
                        </Text>
                      </>
                    )}
                  </View>
                </RosterDrag>
              </View>
            )
          })}
          {corners && controls}
        </View>
      </View>
    </>
  )
}

/**
 * Help (blue) or Clear (red), as words: at one of the field's top corners,
 * over the outfield, or at one end of the row above a short field.
 */
function FieldControl({
  label,
  accessibilityLabel,
  side,
  corner,
  onPress
}: {
  label: string
  accessibilityLabel: string
  side: 'left' | 'right'
  corner: boolean
  onPress: () => void
}): React.ReactElement {
  const theme = useTheme()
  return (
    <Pressable
      testID={`${accessibilityLabel} control`}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      hitSlop={8}
      onPress={onPress}
      style={{
        height: DEFENSE_CONTROL_HEIGHT,
        paddingHorizontal: 4,
        justifyContent: 'center',
        ...(corner
          ? {
              position: 'absolute',
              top: DEFENSE_CONTROL_INSET,
              [side]: DEFENSE_CONTROL_INSET
            }
          : {})
      }}
    >
      <Text
        selectable={false}
        style={{
          fontFamily: theme.regularTextFont,
          fontSize: 14,
          fontWeight: '700',
          color: side === 'left' ? theme.linkTextColor : theme.scoringOutColor
        }}
      >
        {label}
      </Text>
    </Pressable>
  )
}
