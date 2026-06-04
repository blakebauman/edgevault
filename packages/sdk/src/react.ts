/**
 * @edgevault/sdk/react — optional React bindings.
 *
 * Import only if you use React; the core SDK has no React dependency.
 *
 *   const ev = new EdgeVault({ apiKey })
 *   function Banner() {
 *     const { enabled } = useFlag(ev, 'feature.banner')
 *     return enabled ? <NewBanner /> : null
 *   }
 */
import { useEffect, useState } from 'react'
import type { ConfigRecord, EdgeVault } from './index'

export interface AsyncState<T> {
  data: T
  loading: boolean
  error: Error | null
}

/** Subscribe a component to a config record. Refetches when `key` changes. */
export function useConfig(client: EdgeVault, key: string): AsyncState<ConfigRecord | null> {
  const [state, setState] = useState<AsyncState<ConfigRecord | null>>(loadingState(null))
  useEffect(() => track(() => client.config(key), null, setState), [client, key])
  return state
}

/** Subscribe a component to a config's parsed value. */
export function useValue<T = string>(client: EdgeVault, key: string): AsyncState<T | null> {
  const [state, setState] = useState<AsyncState<T | null>>(loadingState(null))
  useEffect(() => track(() => client.value<T>(key), null, setState), [client, key])
  return state
}

/** Subscribe a component to a feature flag (boolean). */
export function useFlag(
  client: EdgeVault,
  key: string,
  fallback = false,
): { enabled: boolean; loading: boolean; error: Error | null } {
  const [state, setState] = useState<AsyncState<boolean>>(loadingState(fallback))
  useEffect(
    () => track(() => client.flag(key, fallback), fallback, setState),
    [client, key, fallback],
  )
  return { enabled: state.data, loading: state.loading, error: state.error }
}

function loadingState<T>(initial: T): AsyncState<T> {
  return { data: initial, loading: true, error: null }
}

/**
 * Run an async producer and push its outcome into React state, ignoring the
 * result if the component unmounted or the inputs changed first. Returns the
 * effect cleanup.
 */
function track<T>(
  run: () => Promise<T>,
  initial: T,
  setState: (s: AsyncState<T>) => void,
): () => void {
  let active = true
  setState(loadingState(initial))
  run().then(
    (data) => {
      if (active) setState({ data, loading: false, error: null })
    },
    (err: unknown) => {
      if (active) {
        setState({
          data: initial,
          loading: false,
          error: err instanceof Error ? err : new Error(String(err)),
        })
      }
    },
  )
  return () => {
    active = false
  }
}
