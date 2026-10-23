import React from 'react'

import { ChoiceSheet } from '../components/ChoiceSheet'
import { lstrings } from '../locales/strings'
import type { NativeAttachChoice } from './nativeAttachments'
import { pickNativeAttachment } from './pickAttachments.native'
import type { TessUpload } from './tessTypes'

export interface AttachPickerProps {
  onAttach: (upload: TessUpload) => void
  onError: (message: string) => void
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
  onError,
  onClose
}: AttachPickerProps): React.ReactElement {
  const choose = (choice: NativeAttachChoice): void => {
    setTimeout(() => {
      pickNativeAttachment(choice).then(
        upload => {
          if (upload != null) onAttach(upload)
        },
        (error: unknown) => {
          onError(
            error instanceof Error
              ? error.message
              : lstrings.tess_attach_unreadable
          )
        }
      )
    }, SHEET_DISMISS_MS)
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
