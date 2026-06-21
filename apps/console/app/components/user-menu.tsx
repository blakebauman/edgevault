import { cn } from '@edgevault/ui'
import { useEffect, useRef, useState } from 'react'
import { Form, Link, useLocation } from 'react-router'
import { OrgNav, orgSectionForPath } from './org-nav'

export type OrgSummary = { id: string; name: string; role: string }

const ITEM =
  'rounded-sm px-2 py-1.5 text-left text-sm text-muted-foreground no-underline transition-colors hover:bg-muted hover:text-accent focus-visible:bg-muted focus-visible:text-accent focus-visible:outline-none'

/**
 * The account menu in the top bar: a dropdown holding account actions and the
 * org-settings sections (members/billing/domains/oidc/saml/scim) for every org
 * you administer — so settings are one click away from any page. Closes on
 * outside-click, Escape (returning focus to the trigger), and navigation;
 * arrow keys move between items.
 */
export function UserMenu({
  email,
  orgs,
  variant = 'topbar',
}: {
  email?: string
  orgs: OrgSummary[]
  variant?: 'topbar' | 'sidebar'
}) {
  const sidebar = variant === 'sidebar'
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const location = useLocation()

  // Close when the route changes — covers menu links and the nested OrgNav.
  // biome-ignore lint/correctness/useExhaustiveDependencies: closing on pathname change is the intent
  useEffect(() => setOpen(false), [location.pathname])

  // Move focus into the menu on open so it's keyboard-drivable immediately.
  useEffect(() => {
    if (open) panelRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  function onPanelKeyDown(e: React.KeyboardEvent) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const items = Array.from(
      panelRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [],
    )
    if (items.length === 0) return
    const idx = items.indexOf(document.activeElement as HTMLElement)
    const next =
      e.key === 'ArrowDown' ? (idx + 1) % items.length : (idx - 1 + items.length) % items.length
    items[next]?.focus()
  }

  const adminOrgs = orgs.filter((o) => o.role === 'owner' || o.role === 'admin')

  const initial = (email?.trim()[0] ?? 'A').toUpperCase()

  return (
    <div ref={ref} className={cn('relative', sidebar && 'w-full')}>
      {sidebar ? (
        <button
          ref={triggerRef}
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className={cn(
            'flex w-full items-center gap-2.5 rounded-sm px-2 py-1.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2',
            open ? 'bg-surface-2' : 'hover:bg-surface-2',
          )}
        >
          <span
            aria-hidden="true"
            className="grid size-7 flex-none place-items-center rounded-sm border border-border bg-vault text-xs font-semibold text-plaintext"
          >
            {initial}
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
            {email ?? 'Account'}
          </span>
          <span
            aria-hidden="true"
            className={cn(
              'flex-none text-xs text-muted-foreground-subtle transition-transform',
              open && 'rotate-180',
            )}
          >
            ▾
          </span>
        </button>
      ) : (
        <button
          ref={triggerRef}
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className={cn(
            'flex items-center gap-1 bg-transparent text-sm transition-colors focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2',
            open ? 'text-accent' : 'text-muted-foreground hover:text-accent',
          )}
        >
          Account
          <span
            aria-hidden="true"
            className={cn('text-xs transition-transform', open && 'rotate-180')}
          >
            ▾
          </span>
        </button>
      )}
      {open && (
        <div
          ref={panelRef}
          role="menu"
          aria-label="Account and organization settings"
          onKeyDown={onPanelKeyDown}
          className={cn(
            'ev-menu-in absolute z-50 flex max-h-[min(70vh,32rem)] w-64 max-w-[calc(100vw-2rem)] flex-col gap-0.5 overflow-y-auto rounded-sm border border-border bg-card p-2',
            sidebar ? 'bottom-full left-0 mb-2' : 'right-0 top-full mt-2',
          )}
        >
          {email && (
            <p className="m-0 truncate px-2 pb-1 font-mono text-xs text-muted-foreground">
              {email}
            </p>
          )}
          <Link to="/account/mfa" role="menuitem" className={ITEM}>
            Account Security
          </Link>
          <Link to="/share" role="menuitem" className={ITEM}>
            Share a Secret
          </Link>

          {adminOrgs.length > 0 && (
            <div className="mt-1 flex flex-col gap-2 border-t border-border pt-2">
              <p className="m-0 px-2 font-mono text-[0.65rem] uppercase tracking-widest text-muted-foreground">
                Organization Settings
              </p>
              {adminOrgs.map((org) => (
                <div key={org.id} className="flex flex-col gap-0.5">
                  <span className="truncate px-2 text-sm text-foreground">{org.name}</span>
                  <OrgNav
                    orgId={org.id}
                    orientation="stacked"
                    active={orgSectionForPath(org.id, location.pathname)}
                  />
                </div>
              ))}
            </div>
          )}

          <div className="mt-1 border-t border-border pt-1">
            <Form method="post" action="/logout">
              <button type="submit" role="menuitem" className={cn(ITEM, 'w-full')}>
                Sign Out
              </button>
            </Form>
          </div>
        </div>
      )}
    </div>
  )
}
