import { defineConfig } from 'vitest/config'

/**
 * Component tests for the console UI run in happy-dom under plain vitest — NOT
 * the Workers pool the api/auth tests use (these are browser-side React, not
 * worker code). A standalone config (taking precedence over vite.config.ts)
 * keeps the Cloudflare/React-Router build plugins out of the test run.
 *
 * @edgevault/ui ships raw .ts source, so it must be transformed (inlined)
 * rather than externalized; esbuild's automatic JSX runtime covers both it and
 * the app's .tsx (base tsconfig is jsx: react-jsx).
 */
export default defineConfig({
  esbuild: { jsx: 'automatic', jsxImportSource: 'react' },
  test: {
    environment: 'happy-dom',
    globals: true,
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.{ts,tsx}'],
    server: { deps: { inline: [/@edgevault\/ui/] } },
  },
})
