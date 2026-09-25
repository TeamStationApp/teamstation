import React from 'react'

import type { OutcomePickerProps } from './outcomePickerProps'
import { ScoringButton } from './ScoringSheet'
/** Native scoring has no renderer yet; the navigation does not expose this control. */
export function OutcomePicker(props: OutcomePickerProps): React.ReactElement {
  return (
    <ScoringButton
      label={props.contactKind === 'bunt' ? 'Bunt in Play' : 'Swing in Play'}
      control
      disabled
      onPress={() => undefined}
    />
  )
}
