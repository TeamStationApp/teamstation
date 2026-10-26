import React from 'react'

import { ChoiceSheet } from '../components/ChoiceSheet'
import { lstrings } from '../locales/strings'
import type { NativeAttachChoice } from './nativeAttachments'
import { pickNativeAttachment } from './pickAttachments.native'
import type { TessUpload } from './tessTypes'

export interface AttachPickerProps {
  /**
   * A file chosen, as it is picked and read: counted as uploading from the
   * choice, so nothing is sent without it. Null when the picker was
   * cancelled; a rejection says why it failed.
   */
  onAttach: (pending: Promise<TessUpload | null>) => void
  onClose: () => void
}

/**
 * iOS will not present a picker while the sheet's own dismissal is still
 * animating, so the picker opens once the sheet has gone.
 */
export const SHEET_DISMISS_MS = 500

/** The phone's +: a sheet offering a photo from the library or a file. */
export function AttachPicker({
  onAttach,
  onClose
}: AttachPickerProps): React.ReactElement {
  const choose = (choice: NativeAttachChoice): void => {
    onAttach(
      new Promise<void>(resolve => {
        setTimeout(resolve, SHEET_DISMISS_MS)
      }).then(async () => await pickNativeAttachment(choice))
    )
  }
  return (
    <ChoiceSheet
      title={lstrings.tess_attach_title}
      choices={[
        {
          label: lstrings.tess_attach_photo,
          onPress: () => {
            choose('photo')
          }
        },
        {
          label: lstrings.tess_attach_file,
          onPress: () => {
            choose('file')
          }
        }
      ]}
      onClose={onClose}
    />
  )
}
