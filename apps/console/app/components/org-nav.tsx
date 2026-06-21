import { cn } from '@edgevault/ui'
import { Link } from 'react-router'

/** The org-settings sections, in one place so the workspaces list and every org
 * page share the same set and order. `path` is the route segment; `slug` keys
 * the active section. "oidc" is the friendly label for the /sso route. */
export const ORG_LINKS = [
  { slug: 'members', label: 'Members', path: 'members' },
  { slug: 'billing', label: 'Billing', path: 'billing' },
  { slug: 'domains', label: 'Domains', path: 'domains' },
  { slug: 'oidc', label: 'OIDC', path: 'sso' },
  { slug: 'saml', label: 'SAML', path: 'saml' },
  { slug: 'scim', label: 'SCIM', path: 'scim' },
] as const

export type OrgNavKey = (typeof ORG_LINKS)[number]['slug']

/** Which org section a path points at, e.g. `/orgs/abc/sso` → `oidc`. Lets the
 * account menu highlight the section you're currently on. */
export function orgSectionForPath(orgId: string, pathname: string): OrgNavKey | undefined {
  const prefix = `/orgs/${orgId}/`
  if (!pathname.startsWith(prefix)) return undefined
  const segment = pathname.slice(prefix.length).split('/')[0]
  return ORG_LINKS.find((l) => l.path === segment)?.slug
}

/**
 * One nav for the org-admin sections. `inline` (default) is the compact
 * dot-separated row used on the workspaces list and org-page headers; `stacked`
 * drops the separators and puts each section on its own row, for the account
 * dropdown. Pass `active` on an org page to mark the current section.
 */
export function OrgNav({
  orgId,
  active,
  orientation = 'inline',
  className,
}: {
  orgId: string
  active?: OrgNavKey
  orientation?: 'inline' | 'stacked'
  className?: string
}) {
  const stacked = orientation === 'stacked'
  return (
    <nav
      aria-label="Organization settings"
      className={cn(
        'flex',
        stacked ? 'flex-col gap-0.5 text-sm' : 'flex-wrap items-center gap-1 font-mono text-xs',
        className,
      )}
    >
      {ORG_LINKS.map((link, i) => {
        const current = link.slug === active
        if (stacked) {
          // Full-width menu rows for the account dropdown.
          return current ? (
            <span
              key={link.slug}
              aria-current="page"
              className="rounded-sm bg-muted px-2 py-1.5 text-accent"
            >
              {link.label}
            </span>
          ) : (
            <Link
              key={link.slug}
              to={`/orgs/${orgId}/${link.path}`}
              role="menuitem"
              className="rounded-sm px-2 py-1.5 text-muted-foreground no-underline transition-colors hover:bg-muted hover:text-accent focus-visible:bg-muted focus-visible:text-accent focus-visible:outline-none"
            >
              {link.label}
            </Link>
          )
        }
        return (
          <span key={link.slug} className="flex items-center gap-1">
            {i > 0 && (
              <span aria-hidden="true" className="text-muted-foreground">
                ·
              </span>
            )}
            {current ? (
              <span aria-current="page" className="text-accent">
                {link.label}
              </span>
            ) : (
              <Link
                to={`/orgs/${orgId}/${link.path}`}
                className="text-muted-foreground no-underline hover:text-accent"
              >
                {link.label}
              </Link>
            )}
          </span>
        )
      })}
    </nav>
  )
}
