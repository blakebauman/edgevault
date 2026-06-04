import type { Route } from './+types/home'

export function meta(_: Route.MetaArgs) {
  return [
    { title: 'EdgeVault Console' },
    { name: 'description', content: 'Edge-native configuration, secrets, and feature flags.' },
  ]
}

export function loader({ context }: Route.LoaderArgs) {
  return { environment: context.cloudflare.env.ENVIRONMENT ?? 'development' }
}

export default function Home({ loaderData }: Route.ComponentProps) {
  return (
    <main className="shell">
      <section className="hero">
        <p className="eyebrow">EdgeVault Console</p>
        <h1>Configuration, secrets &amp; feature flags at the edge.</h1>
        <p className="lede">
          Phase 0 scaffold — React Router 7 on Cloudflare Workers. Real-time updates, AI authoring,
          and the MCP server arrive in later phases.
        </p>
        <p className="badge">environment: {loaderData.environment}</p>
      </section>
    </main>
  )
}
