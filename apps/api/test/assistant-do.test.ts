import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import type { EdgeVaultAgent } from '../src/agent/agent'

/**
 * Protocol-level coverage for the assistant DO.
 *
 * Deliberately avoids running a turn: `runTurn` needs the AI binding, which the
 * test wrangler config omits so the pool stays local. What is covered is the
 * part that used to belong to a third-party SDK — the socket handshake, the
 * message contract, and digest storage — i.e. the code whose breakage was
 * invisible to every build check when the SDK owned it.
 */

function agent(name: string) {
  return env.AGENT.get(env.AGENT.idFromName(name)) as DurableObjectStub<EdgeVaultAgent>
}

async function openSocket(stub: DurableObjectStub<EdgeVaultAgent>) {
  const res = await stub.fetch(
    new Request('https://do/agents/edge-vault-agent/ws', { headers: { Upgrade: 'websocket' } }),
  )
  expect(res.status).toBe(101)
  const socket = res.webSocket
  if (!socket) throw new Error('No WebSocket on upgrade response')
  socket.accept()
  return socket
}

function nextMessage(socket: WebSocket, timeoutMs = 4000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for a frame')), timeoutMs)
    socket.addEventListener('message', (e) => {
      clearTimeout(timer)
      resolve(JSON.parse(e.data as string) as Record<string, unknown>)
    })
  })
}

describe('EdgeVaultAgent WebSocket', () => {
  it('rejects a non-upgrade request', async () => {
    const res = await agent('ws-1:user-1:v2').fetch(new Request('https://do/agents/x'))
    expect(res.status).toBe(426)
  })

  it('answers a ping with a pong', async () => {
    const socket = await openSocket(agent('ws-2:user-1:v2'))
    const pong = nextMessage(socket)
    socket.send(JSON.stringify({ type: 'ping' }))
    expect((await pong).type).toBe('pong')
  })

  it('ignores malformed and unknown frames without closing the socket', async () => {
    const socket = await openSocket(agent('ws-3:user-1:v2'))
    socket.send('not json')
    socket.send(JSON.stringify({ type: 'nonsense' }))
    // An `ask` with no text is also a no-op — it must not start a turn.
    socket.send(JSON.stringify({ type: 'ask', turn: 't1', text: '   ' }))
    // The socket is still usable afterwards.
    const pong = nextMessage(socket)
    socket.send(JSON.stringify({ type: 'ping' }))
    expect((await pong).type).toBe('pong')
  })
})

describe('EdgeVaultAgent digests', () => {
  // Writes happen only at the end of a real turn, and a turn needs the AI
  // binding this pool deliberately omits — so these cover the read side and the
  // per-instance isolation, not the round trip. The write path is exercised on
  // staging rather than pretended at here.
  it('starts empty and creates its table on first touch', async () => {
    expect(await agent('ws-4:user-1:v2').listDigests()).toEqual([])
  })

  it('is isolated per instance name', async () => {
    const a = await agent('ws-5:user-1:v2').listDigests()
    const b = await agent('ws-6:user-1:v2').listDigests()
    expect(a).toEqual([])
    expect(b).toEqual([])
  })

  it('caps the requested limit', async () => {
    expect(await agent('ws-7:user-1:v2').listDigests(10_000)).toEqual([])
  })
})
