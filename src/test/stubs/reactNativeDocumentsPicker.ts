/**
 * `@react-native-documents/picker` for the native specs
 * (`scripts/build-player-native-tests.mjs`), where the real module would look
 * for a native module that a browser bundle does not have.
 *
 * `pick` records the options it was given and answers whatever the spec put
 * in `documentPicker.next`: the picked files, or an error to throw.
 */
import type {
  DocumentPickerOptions,
  DocumentPickerResponse
} from '@react-native-documents/picker'

export const documentPicker: {
  next: DocumentPickerResponse[] | { throws: unknown }
  calls: DocumentPickerOptions[]
} = { next: [], calls: [] }

export async function pick(
  options: DocumentPickerOptions
): Promise<DocumentPickerResponse[]> {
  documentPicker.calls.push(options)
  const next = documentPicker.next
  if ('throws' in next) throw next.throws
  return next
}
