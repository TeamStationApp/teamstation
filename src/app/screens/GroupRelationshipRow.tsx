import React from 'react'
import { Text, View } from 'react-native'

import { localityLabel } from '../../common/locality'
import type { PublicGroup } from '../../common/publicGroups'
import { seasonPeriodLabel } from '../../common/seasonTimeFrames'
import { Button, DangerText, Emblem, initialsOf } from '../components'
import { ActionRow } from '../components/ActionRow'
import { TeamEmblem } from '../components/TeamEmblem'
import { pillPadding } from '../theme/pill'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

export function GroupRelationshipRow({
  group,
  label,
  disabled,
  onLeave,
  onOpen,
  action = 'Leave',
  detail,
  links
}: {
  group: Pick<PublicGroup, 'id' | 'kind' | 'name' | 'imageUrl'>
  label?: string
  action?: string
  detail?: string
  links?: Array<{ label: string; onPress: () => void }>
  disabled?: boolean
  onLeave?: () => void
  onOpen?: () => void
}): React.ReactElement {
  const styles = getStyles(useTheme())
  const hasLinks = links != null && links.length > 0
  const shownDetail =
    detail ??
    (group.kind === 'league'
      ? 'League'
      : group.kind === 'season'
        ? 'Season'
        : undefined)
  return (
    <ActionRow
      title={group.name}
      // With links, the detail joins them on the second line, so a row
      // never grows a third.
      detail={hasLinks ? undefined : shownDetail}
      leading={
        group.kind === 'team' ? (
          <TeamEmblem name={group.name} uri={group.imageUrl} />
        ) : (
          <Emblem uri={group.imageUrl} fallback={initialsOf(group.name)} />
        )
      }
      onOpen={onOpen}
      separateEndAction={onOpen != null && onLeave != null}
      extra={
        !hasLinks ? undefined : (
          <View style={styles.links}>
            {shownDetail != null && shownDetail !== '' && (
              <Text numberOfLines={1} style={styles.detail}>
                {shownDetail}
              </Text>
            )}
            {links.map(link => (
              <Button
                key={link.label}
                label={link.label}
                accessibilityLabel={`Open ${link.label}`}
                kind="text"
                small
                style={styles.link}
                labelStyle={styles.linkLabel}
                onPress={() => {
                  link.onPress()
                }}
              />
            ))}
          </View>
        )
      }
      end={
        onLeave == null ? undefined : (
          <DangerText
            label={action}
            accessibilityLabel={label}
            disabled={disabled}
            onPress={onLeave}
            style={{ minWidth: 48, alignItems: 'center' }}
          />
        )
      }
    />
  )
}
export function relationshipDetails(group: PublicGroup): string | undefined {
  const parts = [
    group.external ? 'Placeholder team' : null,
    group.kind === 'season' && group.startsOn != null && group.endsOn != null
      ? seasonPeriodLabel(group.startsOn, group.endsOn)
      : null,
    ...group.parentNames,
    group.locality == null ? null : localityLabel(group.locality)
  ]
  const details = parts.filter(Boolean).join(' · ')
  return details === '' ? undefined : details
}

const getStyles = cacheStyles((theme: Theme) => ({
  // One line of links, the first one's text at the title's left edge.
  links: {
    flexDirection: 'row',
    alignItems: 'center',
    marginLeft: -pillPadding(theme.rem(3))
  },
  // As tall as a line of text in the layout. Its 48-point target reaches
  // below the text only, by padding the negative margin hands back, so it
  // never covers the title above it.
  link: {
    flexShrink: 1,
    minWidth: 0,
    height: 'auto',
    minHeight: 0,
    paddingTop: 0,
    paddingBottom: theme.rem(1.875),
    marginBottom: -theme.rem(1.875)
  },
  // A second line reads in the regular weight, at the detail's size.
  linkLabel: {
    flexShrink: 1,
    fontFamily: theme.regularTextFont,
    fontWeight: '400',
    fontSize: theme.rem(0.875)
  },
  detail: {
    flexShrink: 0,
    paddingLeft: pillPadding(theme.rem(3)),
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875),
    color: theme.secondaryTextColor
  }
}))
