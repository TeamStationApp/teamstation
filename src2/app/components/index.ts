/**
 * The shared pieces every screen is built from.
 *
 * The designs drew the same handful of things several ways — four takes on a
 * tab strip, three on a list row, two on a bottom bar. Paul asked for one of
 * each, used everywhere, and this is the list of them. A screen that needs
 * something new adds it here rather than styling it in place, which is the only
 * thing that keeps the next screen looking like the last one.
 */
export { AppHeader, type AppHeaderProps } from './AppHeader'
export { AppNav, NAV_CLEARANCE_REM, NAV_TABS, type NavTabId } from './AppNav'
export { Badge, type BadgeTone } from './Badge'
export { Button, type ButtonKind } from './Button'
export { Card } from './Card'
export { Emblem, type EmblemProps } from './Emblem'
export {
  GameHeroCard,
  type TeamStatLine,
  type GameHeroCardProps
} from './GameHeroCard'
export { GameRow, type GameRowProps } from './GameRow'
export { Icon, type IconName } from './Icon'
export { InvitePanel, type InvitePanelProps } from './InvitePanel'
export { initialsOf } from './initials'
export { ListRow } from './ListRow'
export { ManageGear, type ManageGearProps } from './ManageGear'
export { LivePill, type LivePillProps } from './LivePill'
export {
  adminLabel,
  memberLabel,
  RoleModal,
  type RoleModalProps
} from './RoleModal'
export { PillTabs, type PillTab } from './PillTabs'
export { Scoreboard } from './Scoreboard'
export { Screen } from './Screen'
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
export { useHandoff, useHandoffStyle } from './useHandoff'
export { GsMark } from './GsMark'
export { glassStyle, webStyle } from './glass'
export { GlassView } from './GlassView'
export type { GlassViewProps } from './glassViewProps'
