import React from 'react'

import { outcomeAvailable } from './battedBall'
import { useDropMenu } from './dropMenu'
import { DropMenuView } from './DropMenuView'
import { OUT_TYPES, PRIMARY_OUTCOMES } from './outcomeChoices'
import type { OutcomePickerProps } from './outcomePickerProps'
import type { Outcome } from './scoringContract'
import {
  CONTROL_COLORS,
  ControlBackdrop,
  ControlFace,
  controlFrame
} from './ScoringControlAppearance'
import { OutTypeHeader } from './ScoringMenuAppearance'

const OUT = 'Batter Out'

/**
 * The phone's Ball in Play control: the web's menu, opened above the button
 * (`DropMenuView`). Dragged up, the outcomes list bottom to top, nearest the
 * finger first, and Batter Out opens how he was put out to its left.
 */
export function OutcomePicker({
  disabled,
  contactKind = 'swing',
  hasRunners = true,
  onChoose,
  onActive
}: OutcomePickerProps): React.ReactElement {
  const label = contactKind === 'bunt' ? 'Bunt in Play' : 'Swing in Play'
  const available = (value: string): boolean =>
    (contactKind !== 'bunt' || value !== 'Home Run') &&
    outcomeAvailable(value, hasRunners)
  const menu = useDropMenu({
    disabled,
    childKey: OUT,
    escape: false,
    onActive,
    canChoose: key =>
      (OUT_TYPES as readonly string[]).includes(key) || available(key),
    onChoose: key => {
      onChoose(key as Outcome)
    }
  })
  return (
    <DropMenuView
      menu={menu}
      label={label}
      disabled={disabled}
      side="right"
      width={{ share: 0.46, less: 0, most: 230 }}
      rows={PRIMARY_OUTCOMES.filter(available).map(value => ({
        key: value,
        label: value,
        submenu: value === OUT
      }))}
      childKey={OUT}
      childRows={OUT_TYPES.map(value => ({ key: value, label: value }))}
      childHeader={<OutTypeHeader />}
      panelLabel={`${label} outcomes`}
      childLabel="Batter Out options"
      dismissLabel="Dismiss outcomes"
      triggerStyle={{
        ...controlFrame,
        borderColor: CONTROL_COLORS.contact.border,
        backgroundColor: CONTROL_COLORS.contact.bottom,
        opacity: disabled ? 0.5 : 1
      }}
    >
      <ControlBackdrop kind="contact" />
      <ControlFace kind="contact" contact={contactKind} />
    </DropMenuView>
  )
}
