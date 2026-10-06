import {
  ACCOUNT_PICTURE_TYPES,
  type AccountPicture,
  checkAccountPicture
} from '../../common/accountSettings'

/** The input stays in the document until selection or cancellation finishes. */
export async function pickAccountPhoto(): Promise<AccountPicture | null> {
  return await new Promise((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = ACCOUNT_PICTURE_TYPES.join(',')
    input.style.display = 'none'
    input.setAttribute('aria-label', 'Choose profile picture')
    const finish = (picture: AccountPicture | null, error?: unknown): void => {
      input.remove()
      if (error != null)
        reject(
          error instanceof Error
            ? error
            : new Error('That picture could not be read')
        )
      else resolve(picture)
    }
    input.oncancel = () => {
      finish(null)
    }
    input.onchange = () => {
      const file = input.files?.[0]
      if (file == null) {
        finish(null)
        return
      }
      try {
        checkAccountPicture(file.type, file.size)
      } catch (error) {
        finish(null, error)
        return
      }
      const reader = new FileReader()
      reader.onerror = () => {
        finish(null, new Error('That picture could not be read'))
      }
      reader.onload = () => {
        const base64 =
          typeof reader.result === 'string'
            ? reader.result.split(',')[1]
            : undefined
        if (base64 == null) {
          finish(null, new Error('That picture could not be read'))
          return
        }
        finish({ contentType: file.type, base64 })
      }
      reader.readAsDataURL(file)
    }
    document.body.appendChild(input)
    input.click()
  })
}
