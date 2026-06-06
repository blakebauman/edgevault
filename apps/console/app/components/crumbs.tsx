import { Link } from 'react-router'

export interface Crumb {
  label: string
  to?: string
}

/** Where am I: a breadcrumb trail under the page eyebrow. The last crumb is
 * the current page (not a link). Replaces the bare "← Workspace" buttons so
 * location is visible instead of recalled. */
export function Crumbs({ items }: { items: Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb" className="mb-1 font-mono text-xs text-muted-foreground">
      <ol className="m-0 flex list-none flex-wrap items-center gap-1 p-0">
        {items.map((item, i) => (
          <li key={`${item.to ?? ''}-${item.label}`} className="flex items-center gap-1">
            {i > 0 && <span aria-hidden="true">/</span>}
            {item.to ? (
              <Link to={item.to} className="text-muted-foreground no-underline hover:text-accent">
                {item.label}
              </Link>
            ) : (
              <span aria-current="page" className="text-foreground">
                {item.label}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  )
}
