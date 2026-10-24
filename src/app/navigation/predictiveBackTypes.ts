/**
 * What the stack navigator does with Android's back gesture.
 *
 * `onProgress` is the gesture's progress, 0 to 1; `onInvoke` is Back let go,
 * after a drag or as a plain press, and says whether it took the press: one it
 * did not take goes where Back goes without the gesture.
 */
export interface PredictiveBackHandlers {
  enabled: boolean
  onStart: () => void
  onProgress: (progress: number) => void
  onCancel: () => void
  onInvoke: () => boolean
}
