import { cloudflare } from '@cloudflare/vite-plugin'
import { reactRouter } from '@react-router/dev/vite'
import tailwindcss from '@tailwindcss/vite'
import agents from 'agents/vite'
import { defineConfig } from 'vite'
import tsconfigPaths from 'vite-tsconfig-paths'

export default defineConfig({
  plugins: [
    cloudflare({ viteEnvironment: { name: 'ssr' } }),
    // Required by the Agents SDK and missing since the assistant was added.
    // Without it the `agents` client can be bundled more than once — the
    // dual-package hazard behind cloudflare/workers-sdk#14555 — which is the
    // likeliest cause of the assistant streaming every token twice
    // ("HelloHello!!"): two module instances, two subscriptions to one turn.
    // https://developers.cloudflare.com/agents/getting-started/add-to-existing-project/
    agents(),
    tailwindcss(),
    reactRouter(),
    tsconfigPaths(),
  ],
})
