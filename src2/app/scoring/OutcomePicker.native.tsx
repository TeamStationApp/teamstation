import React from 'react'

import type { OutcomePickerProps } from './outcomePickerProps'
import { ScoringButton } from './ScoringSheet'
/** Native scoring has no renderer yet; the navigation does not expose this control. */
export function OutcomePicker(_props: OutcomePickerProps): React.ReactElement {
  return (
    <ScoringButton label="Ball in Play" disabled onPress={() => undefined} />
  )
}
