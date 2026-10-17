import React from 'react'
import { Animated, Pressable, Text, View } from 'react-native'

import type { ProfileSection } from '../../common/api'
import { impliedRoles, type Role, ROLES } from '../../common/roles'
import { lstrings, sprintf } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { ListCard } from './ListCard'
import { flagLabel } from './RolesModal'
import { useConfirmedAction } from './useConfirmedAction'

/** What a row of a person's roles can be given or lose. */
export type RoleRowKind = Role | 'member'

export interface RoleRowsProps {
  section: ProfileSection
  /** Whether they can hold a role at all: an account that signs in. */
  canHoldRoles: boolean
  viewer: { manages: boolean; admin: boolean }
  /**
   * A player's own rows, on their Settings: while they are on the team, the
   * Member row reads Player with no toggle, as a player's place on the team
   * is the roster's to change.
   */
  player?: boolean
  busy?: boolean
  onAdd: (role: RoleRowKind) => void
  onRemove: (role: RoleRowKind, current?: () => boolean) => Promise<void> | void
  ownerLabel?: string
  ownerIdentity?: string
  owner?: unknown
}

/** `Admin`, `Coach`, … `Member`, `Follower`: one row each, in this order. */
const ROWS: ReadonlyArray<RoleRowKind | 'follower'> = [
  ...ROLES,
  'member',
  'follower'
]

/**
 * One level of what a person holds: Admin, the five staff roles, Member and
 * Follower, a row each.
 *
 * On the level being managed, each role has a toggle, on (green) for one they
 * hold and off (red) for one they lack, for a viewer who manages its people;
 * the Admin row only for an administrator, and turning off Member (which takes
 * every role here with it) not for an administrator's membership unless the
 * viewer is one. Follower is only ever a status: following is the person's
 * own. A role another of theirs brings with it at this level (`impliedRoles`:
 * every staff role with Admin, Songkeeper with Scorekeeper) reads "With Admin"
 * or "With Scorekeeper", with no toggle. Any other level, and any viewer who
 * does not manage, reads the rows only.
 */
export function RoleRows(props: RoleRowsProps): React.ReactElement {
  const {
    section,
    canHoldRoles,
    viewer,
    player = false,
    busy = false,
    onAdd,
    onRemove
  } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const confirmation = useConfirmedAction(
    props.owner ?? props.section.level,
    `${props.ownerIdentity ?? section.groups.map(g => g.id).join(',')}:${section.editable}:${viewer.manages}:${viewer.admin}:${section.roles.join(',')}:${section.member}`
  )
  const holdsAdmin = section.roles.includes('admin')
  const implied = impliedRoles(section.roles)
  return (
    <>
      <ListCard>
        {ROWS.map(row => {
          const held =
            row === 'follower'
              ? section.follower
              : row === 'member'
                ? section.member
                : section.roles.includes(row)
          const impliedBy =
            row === 'follower' || row === 'member' || row === 'admin'
              ? undefined
              : implied.get(row)
          // Read as Player only while they are on the team; anybody else's
          // Member row is the usual one.
          const playerRow = player && row === 'member' && section.member
          const changeable =
            impliedBy == null &&
            !playerRow &&
            section.editable &&
            viewer.manages &&
            (row !== 'admin' || viewer.admin) &&
            (row !== 'member' || !held || !holdsAdmin || viewer.admin) &&
            (row === 'member' || held || canHoldRoles)
          const label = labelOf(row)
          return (
            <View
              key={row}
              testID={`role-${section.level}-${row}`}
              style={styles.row}
            >
              <Text style={styles.label}>{label}</Text>
              {changeable && row !== 'follower' ? (
                <RoleToggle
                  testID={`role-${section.level}-${row}-switch`}
                  on={held}
                  label={label}
                  disabled={busy || confirmation.busy}
                  onPress={() => {
                    if (held)
                      confirmation.open({
                        title: `Remove ${label} from ${props.ownerLabel ?? 'this person'}?`,
                        detail:
                          row === 'member'
                            ? `They leave ${section.groups.map(g => g.name).join(', ')} and lose every role held directly there. Roles inherited elsewhere remain.`
                            : `Their ${label} role on ${section.groups.map(g => g.name).join(', ')} will be removed. Other memberships remain.`,
                        label: 'Remove',
                        accessibilityLabel: 'Confirm removal',
                        run: async current => {
                          await onRemove(row, current)
                        }
                      })
                    else onAdd(row)
                  }}
                />
              ) : (
                <Text
                  style={
                    held || impliedBy != null || playerRow
                      ? styles.held
                      : styles.notHeld
                  }
                >
                  {impliedBy != null
                    ? sprintf(lstrings.profile_with, labelOf(impliedBy))
                    : playerRow
                      ? lstrings.profile_player
                      : row === 'follower'
                        ? held
                          ? lstrings.profile_following
                          : lstrings.profile_not_following
                        : held
                          ? lstrings.profile_held
                          : lstrings.profile_not_held}
                </Text>
              )}
            </View>
          )
        })}
      </ListCard>
      {confirmation.sheet}
    </>
  )
}

/**
 * An iOS-style switch: a cream thumb inside a track of constant height, green
 * with the thumb to the right, red with it to the left. The pressable area
 * reaches past the track, which `hitSlop` does not do on the web.
 */
function RoleToggle(props: {
  testID: string
  on: boolean
  label: string
  disabled: boolean
  onPress: () => void
}): React.ReactElement {
  const { testID, on, label, disabled, onPress } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const [position] = React.useState(() => new Animated.Value(on ? 1 : 0))
  React.useEffect(() => {
    const slide = Animated.timing(position, {
      toValue: on ? 1 : 0,
      duration: 150,
      useNativeDriver: false
    })
    slide.start()
    return () => {
      slide.stop()
    }
  }, [on, position])
  return (
    <Pressable
      testID={testID}
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: on, disabled }}
      // react-native-web does not render `aria-checked` from the state above.
      aria-checked={on}
      disabled={disabled}
      onPress={onPress}
      style={[styles.toggle, disabled && styles.disabled]}
    >
      <View
        style={[
          styles.track,
          { backgroundColor: on ? theme.successColor : theme.dangerColor }
        ]}
      >
        <Animated.View
          style={[
            styles.thumb,
            {
              transform: [
                {
                  translateX: position.interpolate({
                    inputRange: [0, 1],
                    outputRange: [0, TRACK_WIDTH - THUMB_SIZE - 2 * THUMB_INSET]
                  })
                }
              ]
            }
          ]}
        />
      </View>
    </Pressable>
  )
}

const TRACK_WIDTH = 51
const TRACK_HEIGHT = 31
const THUMB_INSET = 2
const THUMB_SIZE = TRACK_HEIGHT - 2 * THUMB_INSET
const THUMB_CREAM = '#FBF6E9'
/** How far the pressable area reaches past the track on every side. */
const TOGGLE_SLOP = 8

function labelOf(row: RoleRowKind | 'follower'): string {
  if (row === 'admin') return lstrings.profile_admin
  if (row === 'member') return lstrings.profile_member
  if (row === 'follower') return lstrings.profile_follower
  return flagLabel(row)
}

const getStyles = cacheStyles((theme: Theme) => ({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.rem(theme.spaceSmRem),
    padding: theme.rem(theme.cardContentInsetRem)
  },
  label: {
    flex: 1,
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1),
    fontWeight: '600',
    color: theme.primaryTextColor
  },
  held: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.875),
    fontWeight: '600',
    color: theme.successColor
  },
  toggle: { padding: TOGGLE_SLOP, margin: -TOGGLE_SLOP, minHeight: 48 },
  track: {
    width: TRACK_WIDTH,
    height: TRACK_HEIGHT,
    borderRadius: TRACK_HEIGHT / 2,
    padding: THUMB_INSET,
    justifyContent: 'center'
  },
  thumb: {
    width: THUMB_SIZE,
    height: THUMB_SIZE,
    borderRadius: THUMB_SIZE / 2,
    backgroundColor: THUMB_CREAM,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.25,
    shadowRadius: 2,
    elevation: 2
  },
  disabled: { opacity: 0.5 },
  notHeld: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875),
    color: theme.secondaryTextColor
  }
}))
