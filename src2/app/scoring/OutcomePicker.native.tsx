import React from 'react'
import { Pressable } from 'react-native'

import type { OutcomePickerProps } from './outcomePickerProps'
import {
  CONTROL_COLORS,
  ControlBackdrop,
  ControlFace,
  controlFrame
} from './ScoringControlAppearance'

/** Native scoring has no renderer yet; the navigation does not expose this control. */
export function OutcomePicker(props: OutcomePickerProps): React.ReactElement {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        props.contactKind === 'bunt' ? 'Bunt in Play' : 'Swing in Play'
      }
      disabled
      style={{
        ...controlFrame,
        borderColor: CONTROL_COLORS.contact.border,
        backgroundColor: CONTROL_COLORS.contact.bottom,
        opacity: 0.5
      }}
    >
      <ControlBackdrop kind="contact" />
      <ControlFace kind="contact" contact={props.contactKind} />
    </Pressable>
  )
}
