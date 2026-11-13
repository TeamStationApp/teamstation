import React from 'react'
import { Platform } from 'react-native'

import { IosWheel } from './IosWheel'
import { ScrollWheel } from './ScrollWheel'
import type { WheelProps } from './wheelProps'

export type { WheelProps } from './wheelProps'

/**
 * One column of a pop-up spinner: the hour, minute and period of a time, or a
 * setting's value. On iOS it is the system's spinning wheel; on Android and in
 * a browser, a scrolling column. Safari has no wheel for one list (it shows a
 * `<select>` as a menu), so a browser on iOS keeps the scrolling column too;
 * the time pop-up uses Safari's own time wheel instead (`TimePicker`).
 */
export function Wheel(props: WheelProps): React.ReactElement {
  return Platform.OS === 'ios' ? (
    <IosWheel {...props} />
  ) : (
    <ScrollWheel {...props} />
  )
}
