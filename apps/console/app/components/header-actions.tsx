import { type ReactNode, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

/**
 * Renders its children into the workspace header's action slot
 * (`#ws-header-actions`, in WorkspaceShell) so a deep page can place its primary
 * action up in the top bar beside the assistant. The portal keeps the React tree
 * intact, so the buttons' handlers still belong to the page that rendered them.
 *
 * Client-only: the slot is owned by the shell and the actions are interactive,
 * so SSR renders nothing here and the portal attaches after hydration.
 */
export function HeaderActions({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<HTMLElement | null>(null)
  useEffect(() => {
    setTarget(document.getElementById('ws-header-actions'))
    return () => setTarget(null)
  }, [])
  return target ? createPortal(children, target) : null
}
