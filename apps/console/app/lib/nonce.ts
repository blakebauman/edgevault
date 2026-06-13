import { createContext, useContext } from 'react'

// Per-request CSP nonce. entry.server generates it, sets it in the
// Content-Security-Policy header, and provides it here so <Scripts> and
// <ScrollRestoration> can stamp their inline scripts with the same value.
export const NonceContext = createContext<string | undefined>(undefined)

export function useNonce(): string | undefined {
  return useContext(NonceContext)
}
