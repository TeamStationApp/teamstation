import React from 'react'
import { Text, View, type ViewStyle } from 'react-native'

import type { BaseProjection } from '../field/fieldTypes'
import { lstrings } from '../locales/strings'
import { useScoringSheetTheme } from './scoringSheetTheme'

/** How far a label stands off its base on screen, in points. */
const GAP = 22
const HEIGHT = 28

/**
 * Names the bases a Caught out's tagging defender may be dropped on: "Tag
 * 2nd" above 2nd, "Tag 1st" to the right of 1st and "Tag 3rd" to the left of
 * 3rd, beside the lit base on the field. Nothing until the field has said
 * where its bases are on screen.
 */
export function TagBaseLabels({
  projection,
  bases
}: {
  projection?: BaseProjection
  bases: readonly number[]
}): React.ReactElement | null {
  const theme = useScoringSheetTheme()
  if (projection == null) return null
  return (
    <View pointerEvents="none" style={{ position: 'absolute', inset: 0 }}>
      {bases.map(base => {
        const point = projection.bases[base]
        if (point == null) return null
        const label =
          base === 1
            ? lstrings.scoring_tag_first
            : base === 2
              ? lstrings.scoring_tag_second
              : lstrings.scoring_tag_third
        const place: ViewStyle =
          base === 2
            ? {
                left: point.x - 50,
                width: 100,
                alignItems: 'center',
                top: point.y - GAP - HEIGHT
              }
            : base === 1
              ? {
                  left: point.x + GAP,
                  alignItems: 'flex-start',
                  top: point.y - HEIGHT / 2
                }
              : {
                  right: projection.width - (point.x - GAP),
                  alignItems: 'flex-end',
                  top: point.y - HEIGHT / 2
                }
        return (
          <View
            key={base}
            accessibilityLabel={label}
            testID={`tag-base-label-${base}`}
            style={{ position: 'absolute', height: HEIGHT, ...place }}
          >
            <Text
              style={{
                color: '#ffe000',
                backgroundColor: 'rgba(0, 0, 0, 0.6)',
                borderRadius: 6,
                overflow: 'hidden',
                paddingHorizontal: 8,
                lineHeight: HEIGHT,
                fontFamily: theme.boldTextFont,
                fontSize: 16
              }}
            >
              {label}
            </Text>
          </View>
        )
      })}
    </View>
  )
}
