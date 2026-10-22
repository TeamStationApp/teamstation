/**
 * The shared pieces every screen is built from.
 *
 * The designs drew the same handful of things several ways — four takes on a
 * tab strip, three on a list row, two on a bottom bar. Paul asked for one of
 * each, used everywhere, and this is the list of them. A screen that needs
 * something new adds it here rather than styling it in place, which is the only
 * thing that keeps the next screen looking like the last one.
 */
export {
  AnglePickerModal,
  type AnglePickerModalProps
} from './AnglePickerModal'
export {
  AnglesUnavailableModal,
  type AnglesUnavailableModalProps
} from './AnglesUnavailableModal'
export { AppHeader, type AppHeaderProps } from './AppHeader'
export {
  AppNav,
  FLOATING_BOTTOM_REM,
  NAV_CLEARANCE_REM,
  NAV_TABS,
  type NavTabId
} from './AppNav'
export { Badge, type BadgeTone } from './Badge'
export { Button, type ButtonKind } from './Button'
export { Card, CardContent, CardDivider } from './Card'
export { ListCard } from './ListCard'
export { Emblem, type EmblemProps } from './Emblem'
export { TeamEmblem } from './TeamEmblem'
export {
  GameHeroCard,
  type TeamStatLine,
  type GameHeroCardProps
} from './GameHeroCard'
export { GameRow, type GameRowProps } from './GameRow'
export { ScheduleRow, type ScheduleRowProps } from './ScheduleRow'
export { RsvpScheduleRow, type RsvpScheduleRowProps } from './RsvpScheduleRow'
export { SideCamera } from './SideCamera'
export { Icon, type IconName } from './Icon'
export { initialsOf } from './initials'
export { ListRow } from './ListRow'
export { ManageGear, type ManageGearProps } from './ManageGear'
export { SettingsGear } from './SettingsGear'
export { LivePill, type LivePillProps } from './LivePill'
export {
  adminLabel,
  flagLabel,
  RolesModal,
  type RolesModalProps
} from './RolesModal'
export { PillTabs, type PillTab } from './PillTabs'
export { Scoreboard } from './Scoreboard'
export { Screen, useScreenBottom } from './Screen'
export { SectionHeader } from './SectionHeader'
export { type StatFilter, StatFilterModal } from './StatFilterModal'
export { type Stat, StatGrid } from './StatGrid'
export { WideTable } from './WideTable'
export { StreamPanel, type StreamPanelProps } from './StreamPanel'
export { TextField } from './TextField'
export { VideoPoster, type VideoPosterProps } from './VideoPoster'
export {
  type Breakpoint,
  breakpointFor,
  columnsFor,
  useBreakpoint
} from './useBreakpoint'
export {
  HeaderSlotProvider,
  useHandoffSlot,
  useHeaderHandoff,
  useHeaderSlot
} from './headerSlot'
export { HandoffView } from './HandoffView'
export { HANDOFF_RAMP } from './handoff'
export { useHandoff, useHandoffStyle } from './useHandoff'
export { usePinnedHead } from './usePinnedHead'
export { usePinnedHandoff, usePinnedTabs } from './usePinnedTabs'
export { CardBand, PillBand, PinnedContent, PinnedSpacer } from './PinnedBands'
export { useContentInset } from './contentInset'
export { TsMark } from './TsMark'
export { glassStyle, webStyle } from './glass'
export { GlassView } from './GlassView'
export type { GlassViewProps } from './glassViewProps'

export { DangerText } from './DangerText'
export { HeroCard } from './HeroCard'
export { PictureSheet } from './PictureSheet'

export { TextWidthButton, type TextWidthButtonProps } from './TextWidthButton'
export { Checkbox, type CheckboxProps } from './Checkbox'
