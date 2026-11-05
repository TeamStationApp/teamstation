import type { OnProgressData } from 'react-native-video'

/** Apple's event includes endpoints because its range need not start at zero. */
export type NativeProgressData = OnProgressData & {
  seekableStart?: number
  seekableEnd?: number
}
