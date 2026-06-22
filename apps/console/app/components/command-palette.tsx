import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'

type Env = { id: string; name: string; slug: string }
type Cmd = { id: string; label: string; group: string; keywords?: string; to: string }

/**
 * The workspace command palette (⌘K): keyboard-first navigation across the
 * workspace, a quick environment switcher, and actions (create config/flag/
 * secret via ?new, promote). Every command is a link; the create actions hand
 * off to ItemSection, which opens the create form on ?new=1. Always mounted in
 * the rail so the ⌘K shortcut works from any in-workspace page.
 */
export function CommandPalette({
  open,
  onOpenChange,
  workspaceId,
  envId,
  environments,
  workspaces = [],
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  workspaceId: string
  envId: string | null
  environments: Env[]
  /** Other workspaces the caller can jump to (current one excluded). */
  workspaces?: { id: string; name: string; orgName: string }[]
}) {
  const navigate = useNavigate()
  const location = useLocation()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const commands = useMemo<Cmd[]>(() => {
    const ws = `/dashboard/${workspaceId}`
    const env = envId ? `${ws}/env/${envId}` : null
    const cmds: Cmd[] = [
      { id: 'overview', label: 'Overview', group: 'Jump to', to: ws },
      { id: 'environments', label: 'Environments', group: 'Jump to', to: `${ws}/environments` },
      {
        id: 'compare',
        label: 'Compare environments',
        group: 'Jump to',
        keywords: 'diff drift promote',
        to: `${ws}/compare`,
      },
      {
        id: 'audit',
        label: 'Audit log',
        group: 'Jump to',
        keywords: 'history activity',
        to: `${ws}/audit`,
      },
      {
        id: 'notifications',
        label: 'Notifications',
        group: 'Jump to',
        keywords: 'channels alerts webhooks',
        to: `${ws}/notifications`,
      },
    ]
    if (env) {
      cmds.push(
        { id: 'config', label: 'Config', group: 'This environment', to: `${env}/config` },
        { id: 'flags', label: 'Feature Flags', group: 'This environment', to: `${env}/flags` },
        { id: 'content', label: 'Content', group: 'This environment', to: `${env}/content` },
        { id: 'secrets', label: 'Secrets', group: 'This environment', to: `${env}/secrets` },
        { id: 'keys', label: 'API keys', group: 'This environment', to: `${env}/keys` },
      )
      cmds.push(
        {
          id: 'new-config',
          label: 'Create config…',
          group: 'Actions',
          keywords: 'add new',
          to: `${env}/config?new=1`,
        },
        {
          id: 'new-flag',
          label: 'Create flag…',
          group: 'Actions',
          keywords: 'add new feature',
          to: `${env}/flags?new=1`,
        },
        {
          id: 'new-secret',
          label: 'Create secret…',
          group: 'Actions',
          keywords: 'add new',
          to: `${env}/secrets?new=1`,
        },
      )
    }
    cmds.push({
      id: 'promote',
      label: 'Promote between environments…',
      group: 'Actions',
      keywords: 'deploy drift compare',
      to: `${ws}/compare`,
    })
    // Switch environment, keeping the current section where possible.
    const seg = location.pathname.match(/\/env\/[^/]+\/([^/]+)/)?.[1]
    const section = !seg || seg === 'pages' ? 'config' : seg
    for (const e of environments) {
      if (e.id === envId) continue
      cmds.push({
        id: `env-${e.id}`,
        label: `Switch to ${e.name}`,
        group: 'Switch environment',
        keywords: `${e.slug} environment`,
        to: `${ws}/env/${e.id}/${section}`,
      })
    }
    // Jump to another workspace (lands on its overview).
    for (const w of workspaces) {
      cmds.push({
        id: `ws-${w.id}`,
        label: `Switch to ${w.name}`,
        group: 'Switch workspace',
        keywords: `${w.orgName} workspace`,
        to: `/dashboard/${w.id}`,
      })
    }
    return cmds
  }, [workspaceId, envId, environments, workspaces, location.pathname])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return commands
    return commands.filter((c) => `${c.label} ${c.keywords ?? ''}`.toLowerCase().includes(q))
  }, [commands, query])

  // Reset state each time the palette opens.
  useEffect(() => {
    if (open) {
      setQuery('')
      setActive(0)
      const t = setTimeout(() => inputRef.current?.focus(), 30)
      return () => clearTimeout(t)
    }
  }, [open])

  // ⌘K toggles from anywhere; Escape closes. Listener stays mounted (the early
  // return below is after the hooks) so the shortcut works while closed.
  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        onOpenChange(!open)
      } else if (open && e.key === 'Escape') {
        onOpenChange(false)
      }
    }
    function onDown(e: MouseEvent) {
      if (open && panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onOpenChange(false)
      }
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
    }
  }, [open, onOpenChange])

  if (!open) return null

  function run(cmd: Cmd | undefined) {
    if (!cmd) return
    onOpenChange(false)
    navigate(cmd.to)
  }

  function onInputKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => Math.min(i + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      run(filtered[active])
    }
  }

  let lastGroup = ''
  return (
    <div className="cmdk-scrim">
      <div
        ref={panelRef}
        className="cmdk"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
      >
        <div className="cmdk-input">
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder="Search or jump to…"
            aria-label="Search or jump to"
            autoComplete="off"
            // biome-ignore lint/a11y/noAutofocus: expected focus target for a command palette
            autoFocus
          />
        </div>
        <div className="cmdk-list">
          {filtered.length === 0 && <p className="cmdk-empty">No matches</p>}
          {filtered.map((c, i) => {
            const head = c.group !== lastGroup ? c.group : null
            lastGroup = c.group
            return (
              <div key={c.id}>
                {head && <p className="cmdk-group-label">{head}</p>}
                <button
                  type="button"
                  className="cmdk-item"
                  data-active={i === active}
                  onMouseMove={() => setActive(i)}
                  onClick={() => run(c)}
                >
                  {c.label}
                </button>
              </div>
            )
          })}
        </div>
        <div className="cmdk-foot">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> navigate
          </span>
          <span>
            <kbd>↵</kbd> open
          </span>
          <span className="grow" />
          <span>
            <kbd>esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  )
}
