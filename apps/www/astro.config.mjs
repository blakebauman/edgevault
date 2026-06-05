import { defineConfig } from 'astro/config'

// Fully static build — no SSR adapter on purpose. The output in dist/ is
// served by an assets-only Worker (see wrangler.jsonc); the site ships 0 KB
// of client JS. Revisit only if a page ever needs an interactive island.
export default defineConfig({
  site: 'https://edgevault.io',
  output: 'static',
  build: {
    // match the previous static-site behaviour: /pricing → pricing.html
    // (wrangler assets html_handling auto-trailing-slash resolves it)
    format: 'file',
  },
  markdown: {
    // css-variables theme → code-block colors come from the brand tokens
    // defined in DocsLayout (Vault Depth panel, lilac/orchid syntax)
    shikiConfig: { theme: 'css-variables' },
  },
})
