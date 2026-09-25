import React, { useEffect, useState } from 'react'
import { View } from 'react-native'

import { OutcomePicker } from './OutcomePicker'
import type { OutcomePickerProps } from './outcomePickerProps'
import type { ContactKind, Outcome } from './scoringContract'

/** One active picker owns both menus, including delayed pointer releases. */
export function OutcomeControls({
  onActive,
  onChoose,
  ...props
}: Omit<OutcomePickerProps, 'onChoose' | 'contactKind'> & {
  onChoose: (outcome: Outcome, contactKind: ContactKind) => void
}): React.ReactElement {
  const [active, setActive] = useState<ContactKind>()
  useEffect(() => {
    onActive(active != null)
  }, [active, onActive])
  return (
    <View style={{ gap: 8, height: 112 }}>
      {(['swing', 'bunt'] as const).map(kind => (
        <OutcomePicker
          {...props}
          key={kind}
          contactKind={kind}
          disabled={props.disabled || (active != null && active !== kind)}
          onActive={value => {
            setActive(current =>
              value ? kind : current === kind ? undefined : current
            )
          }}
          onChoose={outcome => {
            onChoose(outcome, kind)
          }}
        />
      ))}
    </View>
  )
}
