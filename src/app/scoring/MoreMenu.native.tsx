import React from 'react'

import { useDropMenu } from './dropMenu'
import { DropMenuView } from './DropMenuView'
import {
  MORE_GROUPS,
  type MoreAction,
  moreEligibility,
  type MoreInput
} from './moreActions'
import type { MoreMenuProps } from './moreMenuProps'
import {
  CONTROL_COLORS,
  ControlBackdrop,
  ControlFace,
  controlFrame
} from './ScoringControlAppearance'

const BASE = 'Put Batter on Base'
const BASES = ['First', 'Second', 'Third'] as const

/** What a More row's key asks for: an action, or a base for Put Batter on Base. */
function inputOf(key: string): MoreInput {
  const base = Number(key)
  return [1, 2, 3].includes(base)
    ? { action: BASE, base }
    : { action: key as MoreAction }
}

/** The phone's More: the web's menu, opened above the button (`DropMenuView`). */
export function MoreMenu({
  state,
  disabled,
  onActive,
  onChoose
}: MoreMenuProps): React.ReactElement {
  const menu = useDropMenu({
    disabled,
    childKey: BASE,
    escape: true,
    onActive,
    canChoose: key => moreEligibility(state, inputOf(key).action) == null,
    onChoose: key => {
      const input = inputOf(key)
      onChoose(input)
    }
  })
  const rows = MORE_GROUPS.flatMap(group => group.actions)
    .filter(
      action =>
        !['Dropped Third Strike', BASE, 'Balk'].includes(action) ||
        moreEligibility(state, action) == null
    )
    .map(action => ({
      key: action,
      label: action,
      disabled: moreEligibility(state, action) != null,
      submenu: action === BASE
    }))
  return (
    <>
      <DropMenuView
        menu={menu}
        label="More"
        disabled={disabled}
        side="left"
        width={{ share: 0.5, less: 16, most: 300 }}
        rows={rows}
        childKey={BASE}
        childRows={BASES.map((label, index) => ({
          key: String(index + 1),
          label
        }))}
        panelLabel="More scoring actions"
        childLabel="Batter base"
        dismissLabel="Dismiss More"
        triggerStyle={{
          ...controlFrame,
          flex: 1,
          borderColor: CONTROL_COLORS.more.border,
          backgroundColor: CONTROL_COLORS.more.bottom,
          opacity: disabled ? 0.5 : 1
        }}
      >
        <ControlBackdrop kind="more" />
        <ControlFace kind="more" />
      </DropMenuView>
    </>
  )
}
