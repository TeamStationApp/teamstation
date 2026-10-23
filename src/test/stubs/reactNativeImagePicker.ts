/**
 * `react-native-image-picker` for the native specs
 * (`scripts/build-player-native-tests.mjs`), where the real module would look
 * for a native module that a browser bundle does not have.
 *
 * `launchImageLibrary` records the options it was given and answers whatever
 * the spec put in `imagePicker.next`: a response, or an error to throw.
 */
import type {
  ImageLibraryOptions,
  ImagePickerResponse
} from 'react-native-image-picker'

export const imagePicker: {
  next: ImagePickerResponse | { throws: unknown }
  calls: ImageLibraryOptions[]
} = { next: { didCancel: true }, calls: [] }

export async function launchImageLibrary(
  options: ImageLibraryOptions
): Promise<ImagePickerResponse> {
  imagePicker.calls.push(options)
  const next = imagePicker.next
  if ('throws' in next) throw next.throws
  return next
}
