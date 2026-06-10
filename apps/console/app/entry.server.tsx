import { isbot } from 'isbot'
import { renderToReadableStream } from 'react-dom/server'
import type { AppLoadContext, EntryContext } from 'react-router'
import { ServerRouter } from 'react-router'
import { buildCsp, generateNonce } from './lib/csp'
import { NonceContext } from './lib/nonce'

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
  loadContext: AppLoadContext,
) {
  let shellRendered = false
  const userAgent = request.headers.get('user-agent')
  const nonce = generateNonce()

  const body = await renderToReadableStream(
    <NonceContext.Provider value={nonce}>
      <ServerRouter context={routerContext} url={request.url} nonce={nonce} />
    </NonceContext.Provider>,
    {
      nonce,
      onError(error: unknown) {
        responseStatusCode = 500
        // Log streaming render errors only after the shell has flushed.
        if (shellRendered) {
          console.error(error)
        }
      },
    },
  )
  shellRendered = true

  // Wait for the full document for bots/SPA so they receive complete markup.
  if ((userAgent && isbot(userAgent)) || routerContext.isSpaMode) {
    await body.allReady
  }

  responseHeaders.set('Content-Type', 'text/html')
  // Vite dev injects inline HMR scripts that a nonce policy would block.
  if (!import.meta.env.DEV) {
    responseHeaders.set(
      'Content-Security-Policy',
      buildCsp(nonce, loadContext.cloudflare.env.API_WS_BASE),
    )
  }
  return new Response(body, {
    headers: responseHeaders,
    status: responseStatusCode,
  })
}
