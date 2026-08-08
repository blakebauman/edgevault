import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigation } from 'react-router'

/**
 * Chrome shared by the two shells (workspace and org): the off-canvas nav
 * drawer's behaviour, and the route-transition indicator. Both shells render
 * the same rail markup, so the interaction rules live here rather than being
 * duplicated (and drifting) in each route module.
 */

/**
 * Off-canvas drawer state for the mobile rail.
 *
 * The drawer is hidden with CSS (`visibility: hidden` under the 860px
 * breakpoint), which is what keeps its links out of the tab order and away
 * from screen readers even before hydration — this hook only adds the
 * keyboard affordances on top: Escape dismisses, opening moves focus into the
 * rail so the next Tab lands on a nav item, and an explicit dismissal returns
 * focus to the button that opened it. Closing because the route changed does
 * NOT restore focus: the user is on their way to a new page, and yanking focus
 * back to the burger would fight the navigation.
 */
export function useNavDrawer() {
  const { pathname } = useLocation()
  const [open, setOpen] = useState(false)
  const sidebarRef = useRef<HTMLElement>(null)
  const burgerRef = useRef<HTMLButtonElement>(null)

  // Closing on pathname change is the intent
  useEffect(() => setOpen(false), [pathname])

  /** Dismiss and hand focus back to the trigger — for Escape and the scrim. */
  const dismiss = () => {
    setOpen(false)
    burgerRef.current?.focus()
  }

  useEffect(() => {
    if (!open) return
    sidebarRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setOpen(false)
      burgerRef.current?.focus()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  return { open, setOpen, dismiss, sidebarRef, burgerRef }
}

/**
 * The route-transition indicator: a determinate-looking bar under the shell
 * header while React Router is loading a route or running an action.
 *
 * It waits ~150ms before showing so a warm, fast transition never flashes a
 * bar — only navigations the user would otherwise experience as a dead click
 * get one.
 */
export function useRoutePending() {
  const navigation = useNavigation()
  const busy = navigation.state !== 'idle'
  const [pending, setPending] = useState(false)

  useEffect(() => {
    if (!busy) {
      setPending(false)
      return
    }
    const t = setTimeout(() => setPending(true), 150)
    return () => clearTimeout(t)
  }, [busy])

  return pending
}

export function RouteProgress({ pending }: { pending: boolean }) {
  return (
    <div className="route-progress" data-pending={pending || undefined} aria-hidden="true">
      <span className="route-progress-bar" />
    </div>
  )
}

/** Screen-reader announcement for the same transition the bar shows visually. */
export function RoutePendingStatus({ pending }: { pending: boolean }) {
  return (
    <span className="sr-only" role="status">
      {pending ? 'Loading…' : ''}
    </span>
  )
}
