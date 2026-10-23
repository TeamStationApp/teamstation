import React from 'react'

import { AttachPanel, type AttachPanelProps } from './AttachPanel'

export type AttachPickerProps = AttachPanelProps

/** The browser's +: a panel with a drop zone and a chooser. */
export function AttachPicker(props: AttachPickerProps): React.ReactElement {
  return <AttachPanel {...props} />
}
