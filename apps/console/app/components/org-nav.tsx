import { cn } from '@edgevault/ui'
import { Link } from 'react-router'

/**
 * The org-settings sections, in one place so the rail, the workspaces list, and
 * the account menu share the same set and order.
 *
 * Grouped rather than flat, and named by function. Four of these were bare
 * acronyms in a six-item list — "OIDC · SAML · SCIM" tells you nothing unless
 * you already know what you're looking for, which is the opposite of what an
 * evaluating admin needs. There is deliberately no "Enterprise" group: nothing
 * here is gated, and an upsell label on an unlocked feature reads as one.
 *
 * `path` is the route segment; `slug` keys the active section.
 */
export type OrgNavKey =
  | 'overview'
  | 'members'
  | 'billing'
  | 'security'
  | 'oidc'
  | 'saml'
  | 'scim'
  | 'domains'

export interface OrgLink {
  slug: OrgNavKey
  label: string
  /** Route segment; the overview is the index, so its segment is empty. */
  path: string
}

export interface OrgGroup {
  label: string
  links: OrgLink[]
}

export const ORG_GROUPS: OrgGroup[] = [
  {
    label: 'Organization',
    links: [
      { slug: 'overview', label: 'Overview', path: '' },
      { slug: 'members', label: 'Members', path: 'members' },
      { slug: 'billing', label: 'Billing', path: 'billing' },
    ],
  },
  {
    label: 'Identity & access',
    links: [
      { slug: 'security', label: 'Security', path: 'security' },
      { slug: 'oidc', label: 'Single sign-on', path: 'sso' },
      { slug: 'saml', label: 'SAML', path: 'saml' },
      { slug: 'scim', label: 'Directory sync', path: 'scim' },
    ],
  },
  {
    label: 'Delivery',
    links: [{ slug: 'domains', label: 'Domains', path: 'domains' }],
  },
]

/** Flattened, for consumers that want one list (account menu, ⌘K palette). */
export const ORG_LINKS: OrgLink[] = ORG_GROUPS.flatMap((g) => g.links)

/** Which org section a path points at, e.g. `/orgs/abc/sso` → `oidc`. Lets the
 * account menu highlight the section you're currently on. */
export function orgSectionForPath(orgId: string, pathname: string): OrgNavKey | undefined {
  const prefix = `/orgs/${orgId}`
  if (!pathname.startsWith(prefix)) return undefined
  const segment = pathname.slice(prefix.length).replace(/^\//, '').split('/')[0] ?? ''
  return ORG_LINKS.find((l) => l.path === segment)?.slug
}

/** Build the href for a section — the overview's empty path is the org root. */
export function orgLinkTo(orgId: string, path: string): string {
  return path ? `/orgs/${orgId}/${path}` : `/orgs/${orgId}`
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
              to={orgLinkTo(orgId, link.path)}
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
                to={orgLinkTo(orgId, link.path)}
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
