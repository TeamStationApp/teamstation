import React, { useState } from 'react'
import { type LayoutChangeEvent, Pressable, Text, View } from 'react-native'

import type { SearchResult } from '../../common/search/types'
import {
  COMPACT_PILL_LABEL_REM,
  COMPACT_PILL_REM,
  compactPill
} from '../theme/pill'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { Badge } from './Badge'
import { Button } from './Button'
import { ButtonIcon } from './ButtonIcon'
import { Card } from './Card'
import { GroupEmblem } from './GroupEmblem'
import { PersonEmblem } from './PersonEmblem'

const KIND_LABELS = {
  league: 'League',
  season: 'Season',
  team: 'Team',
  person: 'Person'
} as const

/** A result's kind, as its pill reads. */
export function kindLabel(result: SearchResult): string {
  return KIND_LABELS[result.kind]
}

/**
 * The lines under a result's name: a team's or season's city, then its
 * associations (a team's seasons and leagues, a season's league, a league's
 * city, a person's guardian links and teams). Missing ones are left out.
 */
export function resultLines(result: SearchResult): string[] {
  return [
    ...(result.kind === 'person' || result.cityLine == null
      ? []
      : [result.cityLine]),
    result.associations
  ].filter(line => line !== '')
}

/** A name's words, as its lines break between them. */
export function nameWords(name: string): string[] {
  return name.split(' ').filter(word => word !== '')
}

/**
 * Where a name breaks over two lines whose first is `firstLine` wide: the
 * most words whose run (`prefixWidths[i]`, the width of the first `i + 1`
 * words on one line) fits, and the rest, for the full-width second line.
 * Null, the name is drawn as one block in the first line's width: before it
 * is measured, when it fits on the first line, and when not even its first
 * word does.
 */
export function nameLines(
  name: string,
  prefixWidths: ReadonlyArray<number | undefined>,
  firstLine: number | null
): [string, string] | null {
  const words = nameWords(name)
  if (firstLine == null || words.length < 2) return null
  let fits = 0
  for (let at = 0; at < words.length; at++) {
    const width = prefixWidths[at]
    if (width == null) return null
    if (width > firstLine) break
    fits = at + 1
  }
  if (fits === 0 || fits === words.length) return null
  return [words.slice(0, fits).join(' '), words.slice(fits).join(' ')]
}

/**
 * One row of the Search tab's results, in its own card (`docs/ui-rules.md`,
 * "Cards and collections"): the group's or person's tile, the name, the lines
 * `resultLines` gives, and a chevron. The kind pill (compact), with the
 * Follow pill after it on a group the reader may follow, sits at the top
 * right of the name. The name takes two lines before it truncates, so that
 * two seasons whose names differ only at the end still read apart on a
 * phone: its first line is the width left of the pills, and its second the
 * full width up to the chevron, broken between words where the measured
 * words fit (`nameLines`); until they are measured, or when no word break
 * fits, the name is two lines in the first line's width. The lines beneath
 * run the full width up to the chevron.
 *
 * Opening the row and following are separate targets. The open target
 * covers the whole card beneath the content; the drawn tile, name, lines and
 * chevron let touches through to it and are hidden from assistive tech,
 * which reads the target's label instead, as a `ListRow` row does.
 */
export function SearchResultRow({
  result,
  accessibilityLabel,
  onPress,
  follow,
  followBusy = false,
  onToggleFollow
}: {
  result: SearchResult
  accessibilityLabel: string
  onPress: () => void
  /** The Follow pill's state; null or absent draws none. */
  follow?: 'follow' | 'following' | null
  followBusy?: boolean
  onToggleFollow?: () => void
}): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  const lines = resultLines(result)
  const following = follow === 'following'
  // The name's first line's width, and each run of its first words on one
  // line, measured by hidden copies.
  const [firstLine, setFirstLine] = useState<number | null>(null)
  const [prefixWidths, setPrefixWidths] = useState<Array<number | undefined>>(
    []
  )
  const words = nameWords(result.name)
  const split = nameLines(result.name, prefixWidths, firstLine)
  const measured =
    (at: number) =>
    (event: LayoutChangeEvent): void => {
      const { width } = event.nativeEvent.layout
      setPrefixWidths(widths =>
        widths[at] === width
          ? widths
          : Object.assign([...widths], { [at]: width })
      )
    }
  // What the row draws lets touches through to the open target beneath it
  // and is hidden from assistive tech, which reads the target's label.
  const drawn = {
    'aria-hidden': true,
    accessibilityElementsHidden: true,
    importantForAccessibility: 'no-hide-descendants'
  } as const
  return (
    <Card flush testID="search-result-row">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        onPress={onPress}
        style={({ pressed }) => [styles.target, pressed && styles.pressed]}
      />
      <View style={[styles.row, styles.through]}>
        <View {...drawn} style={styles.inert}>
          {result.kind === 'person' ? (
            <PersonEmblem
              name={result.name}
              userId={result.userId}
              uri={result.avatarUrl}
            />
          ) : (
            <GroupEmblem
              kind={result.kind}
              id={result.id}
              name={result.name}
              uri={result.imageUrl}
            />
          )}
        </View>
        <View style={[styles.text, styles.through]}>
          <View style={[styles.top, styles.through]} testID="search-result-top">
            <View
              {...drawn}
              style={[styles.name, styles.inert]}
              testID="search-result-name"
              onLayout={event => {
                const { width } = event.nativeEvent.layout
                setFirstLine(known => (known === width ? known : width))
              }}
            >
              <Text style={styles.title} numberOfLines={split == null ? 2 : 1}>
                {split == null ? result.name : split[0]}
              </Text>
            </View>
            <View
              style={[styles.pills, styles.through]}
              testID="search-result-pills"
            >
              {/* Badge sits at its parent's start; held here, it centres on
                  Follow, and a tap on it opens the row. */}
              <View style={styles.inert}>
                <Badge label={kindLabel(result)} compact raised />
              </View>
              {follow != null && result.kind !== 'person' && (
                <Button
                  label={following ? 'Following' : 'Follow'}
                  accessibilityLabel={`${following ? 'Unfollow' : 'Follow'} ${result.name}`}
                  compact
                  kind={following ? 'secondary' : 'primary'}
                  busy={followBusy}
                  style={styles.followPill}
                  labelStyle={styles.followLabel}
                  hitSlop={FOLLOW_SLOP}
                  onPress={() => {
                    onToggleFollow?.()
                  }}
                />
              )}
            </View>
          </View>
          {words.length > 1 && (
            <View
              {...drawn}
              style={[styles.probes, styles.inert]}
              testID="search-result-name-runs"
            >
              {words.map((_, at) => (
                <Text
                  key={at}
                  style={[styles.title, styles.probe]}
                  numberOfLines={1}
                  onLayout={measured(at)}
                >
                  {words.slice(0, at + 1).join(' ')}
                </Text>
              ))}
            </View>
          )}
          {split != null && (
            <View
              {...drawn}
              style={styles.inert}
              testID="search-result-name-rest"
            >
              <Text style={styles.title} numberOfLines={1}>
                {split[1]}
              </Text>
            </View>
          )}
          {lines.length > 0 && (
            <View
              {...drawn}
              style={[styles.lines, styles.inert]}
              testID="search-result-lines"
            >
              {lines.map((line, index) => (
                <Text key={index} style={styles.line}>
                  {line}
                </Text>
              ))}
            </View>
          )}
        </View>
        <View {...drawn} style={styles.inert}>
          <ButtonIcon name="chevron_right" color={theme.secondaryTextColor} />
        </View>
      </View>
    </Card>
  )
}

/** The Follow pill's height, in rem: the compact kind pill's 20 points. */
export const FOLLOW_HEIGHT_REM = COMPACT_PILL_REM

/** Reaches the Follow pill's target out to 44 points tall at the base size. */
export const FOLLOW_SLOP = 12

const getStyles = cacheStyles((theme: Theme) => ({
  // The kind pill's size, which every pill on the Search screen takes.
  followPill: compactPill(theme),
  followLabel: { fontSize: theme.rem(COMPACT_PILL_LABEL_REM) },
  target: {
    position: 'absolute' as const,
    top: 0,
    right: 0,
    bottom: 0,
    left: 0
  },
  pressed: { backgroundColor: theme.highlightRowActiveBackground },
  through: { pointerEvents: 'box-none' as const },
  inert: { pointerEvents: 'none' as const },
  row: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: theme.rem(theme.spaceMdRem),
    padding: theme.rem(theme.cardContentInsetRem)
  },
  text: { flex: 1, minWidth: 0, gap: theme.rem(0.125) },
  // The pills keep their width at the top of the name's first line.
  top: {
    flexDirection: 'row' as const,
    alignItems: 'flex-start' as const,
    gap: theme.rem(0.5)
  },
  name: { flex: 1, minWidth: 0 },
  title: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1),
    fontWeight: '600' as const,
    color: theme.primaryTextColor
  },
  // Off the row and unseen, wide enough that each run is one line.
  probes: {
    position: 'absolute' as const,
    top: 0,
    left: 0,
    width: 4000,
    opacity: 0,
    alignItems: 'flex-start' as const
  },
  probe: { alignSelf: 'flex-start' as const },
  lines: { gap: theme.rem(0.125) },
  pills: {
    flexShrink: 0,
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: theme.rem(0.375)
  },
  line: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875),
    color: theme.secondaryTextColor
  }
}))
