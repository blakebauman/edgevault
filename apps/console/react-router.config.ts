import type { Config } from '@react-router/dev/config'

export default {
  // Server-side render by default; the Worker streams HTML from the edge.
  ssr: true,
  future: {
    // Required for compatibility with the @cloudflare/vite-plugin (aligns the
    // build with Vite's Environment API).
    v8_viteEnvironmentApi: true,
  },
} satisfies Config
