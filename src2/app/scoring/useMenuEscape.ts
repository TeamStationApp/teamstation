import { useEffect } from 'react'
export function useMenuEscape(
  open: boolean,
  close: () => void,
  trigger: string
): void {
  useEffect(() => {
    if (!open) return
    const dismiss = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      close()
      document.querySelector<HTMLElement>(`[aria-label="${trigger}"]`)?.focus()
    }
    document.addEventListener('keydown', dismiss)
    return () => {
      document.removeEventListener('keydown', dismiss)
    }
  }, [open, close, trigger])
}
