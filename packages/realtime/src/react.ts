import { useEffect, useRef, useState } from 'react'
import { type ConnectionStatus, WorkspaceEventsClient } from './client'
import type { WorkspaceEvent } from './events'

/**
 * Subscribe a React component to workspace events. Pass `null` for the url to
 * stay disconnected (e.g. before auth is ready). Returns the connection status.
 */
export function useWorkspaceEvents(
  url: string | null,
  onEvent: (event: WorkspaceEvent) => void,
): ConnectionStatus {
  const [status, setStatus] = useState<ConnectionStatus>('closed')
  const handler = useRef(onEvent)
  handler.current = onEvent

  useEffect(() => {
    if (!url) {
      setStatus('closed')
      return
    }
    const client = new WorkspaceEventsClient({
      url,
      onEvent: (event) => handler.current(event),
      onStatus: setStatus,
    })
    client.connect()
    return () => client.close()
  }, [url])

  return status
}
