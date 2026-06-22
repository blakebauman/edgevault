import { cn } from '@edgevault/ui'
import { useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router'
import type { SwitcherOrg } from '../lib/workspace.server'

/**
 * The rail-top workspace switcher: a dropdown that lists every workspace the
 * caller can see, grouped by org, so you jump between them in place instead of
 * routing through the workspaces page. The trigger reuses the `.ws-switch`
 * chrome (mark + name + chevron); the chevron now delivers what it promises.
 * Closes on outside-click, Escape (focus returns to the trigger), and route
 * change; arrow keys move between workspaces.
 */
export function WorkspaceSwitcher({
  orgs,
  currentWorkspaceId,
  name,
  sublabel,
  initial,
}: {
  orgs: SwitcherOrg[]
  /** The active workspace (highlighted + checked), if a workspace is in scope. */
  currentWorkspaceId?: string
  /** Primary line in the trigger — the workspace or org name. */
  name: string
  /** Secondary line in the trigger. */
  sublabel: string
  /** Single-letter mark. */
  initial: string
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const location = useLocation()

  // Close when the route changes — covers picking a workspace and the footer link.
  // biome-ignore lint/correctness/useExhaustiveDependencies: closing on pathname change is the intent
  useEffect(() => setOpen(false), [location.pathname])

  // Focus the active (or first) workspace on open so it's keyboard-drivable.
  useEffect(() => {
    if (!open) return
    const panel = panelRef.current
    const active = panel?.querySelector<HTMLElement>('[data-current="true"]')
    ;(active ?? panel?.querySelector<HTMLElement>('[role="menuitem"]'))?.focus()
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

  const totalWorkspaces = orgs.reduce((n, o) => n + o.workspaces.length, 0)

  return (
    <div ref={ref} className="relative">
      <button
        ref={triggerRef}
        type="button"
        className="ws-switch ws-switch-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Switch workspace"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="ws-mark" aria-hidden="true">
          {initial}
        </span>
        <span className="ws-switch-meta">
          <span className="ws-switch-name">{name}</span>
          <span className="ws-switch-sub">{sublabel}</span>
        </span>
        <svg
          className="ws-chev"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m8 9 4-4 4 4M16 15l-4 4-4-4" />
        </svg>
      </button>

      {open && (
        <div
          ref={panelRef}
          role="menu"
          aria-label="Switch workspace"
          onKeyDown={onPanelKeyDown}
          className="ev-menu-in absolute left-2.5 right-2.5 top-full z-50 mt-1 flex max-h-[min(70vh,32rem)] flex-col gap-0.5 overflow-y-auto rounded-sm border border-border bg-card p-2"
        >
          {totalWorkspaces === 0 && (
            <p className="m-0 px-2 py-1.5 text-sm text-muted-foreground">No workspaces yet.</p>
          )}
          {orgs.map((org) =>
            org.workspaces.length === 0 ? null : (
              <div key={org.id} className="flex flex-col gap-0.5 [&:not(:first-child)]:mt-1">
                <p className="m-0 truncate px-2 pt-1 font-mono text-[0.65rem] uppercase tracking-widest text-muted-foreground-subtle">
                  {org.name}
                </p>
                {org.workspaces.map((ws) => {
                  const isCurrent = ws.id === currentWorkspaceId
                  return (
                    <Link
                      key={ws.id}
                      to={`/dashboard/${ws.id}`}
                      role="menuitem"
                      data-current={isCurrent}
                      className={cn(
                        'flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm no-underline transition-colors focus-visible:outline-none',
                        isCurrent
                          ? 'bg-surface-2 text-foreground'
                          : 'text-muted-foreground hover:bg-muted hover:text-accent focus-visible:bg-muted focus-visible:text-accent',
                      )}
                    >
                      <span className="min-w-0 flex-1 truncate">{ws.name}</span>
                      <span className="truncate font-mono text-xs text-muted-foreground-subtle">
                        /{ws.slug}
                      </span>
                      {isCurrent && (
                        <span aria-hidden="true" className="flex-none text-accent">
                          ✓
                        </span>
                      )}
                    </Link>
                  )
                })}
              </div>
            ),
          )}

          <div className="mt-1 border-t border-border pt-1">
            <Link
              to="/"
              role="menuitem"
              className="flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-muted-foreground no-underline transition-colors hover:bg-muted hover:text-accent focus-visible:bg-muted focus-visible:text-accent focus-visible:outline-none"
            >
              <span aria-hidden="true">↗</span> All workspaces
            </Link>
          </div>
        </div>
      )}
    </div>
  )
}
