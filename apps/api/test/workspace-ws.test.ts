import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import type { VaultDurableObject } from '../src/durable-objects/vault'

function workspace(name: string) {
  return env.WORKSPACE.get(env.WORKSPACE.idFromName(name)) as DurableObjectStub<VaultDurableObject>
}

async function openSocket(ws: DurableObjectStub<VaultDurableObject>, user: string, envId = '*') {
  const res = await ws.fetch(
    new Request(`https://do/ws?user=${user}&env=${envId}`, {
      headers: { Upgrade: 'websocket' },
    }),
  )
  expect(res.status).toBe(101)
  const socket = res.webSocket
  if (!socket) throw new Error('No WebSocket on upgrade response')
  socket.accept()
  return socket
}

function nextEvent(
  socket: WebSocket,
  type: string,
  timeoutMs = 4000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), timeoutMs)
    socket.addEventListener('message', (e) => {
      const data = JSON.parse(e.data as string) as Record<string, unknown>
      if (data.type === type) {
        clearTimeout(timer)
        resolve(data)
      }
    })
  })
}

describe('VaultDurableObject WebSocket', () => {
  it('pushes config.changed to a connected client', async () => {
    const ws = workspace('ws-rt')
    const e = await ws.createEnvironment({ name: 'Dev', slug: 'dev', userId: 'u1' })
    const socket = await openSocket(ws, 'u1', '*')

    const event = nextEvent(socket, 'config.changed')
    await ws.setConfig({ environmentId: e.id, key: 'k', content: '{"a":1}', userId: 'u1' })

    const data = await event
    expect(data).toMatchObject({ type: 'config.changed', key: 'k', environmentId: e.id })
  })

  it('only delivers events for the subscribed environment', async () => {
    const ws = workspace('ws-rt-filter')
    const dev = await ws.createEnvironment({ name: 'Dev', slug: 'dev', userId: 'u1' })
    const prod = await ws.createEnvironment({ name: 'Prod', slug: 'prod', userId: 'u1' })
    const socket = await openSocket(ws, 'u1', dev.id) // subscribed to dev only

    let unexpected = false
    socket.addEventListener('message', (e) => {
      const data = JSON.parse(e.data as string) as { type?: string; environmentId?: string }
      if (data.type === 'config.changed' && data.environmentId === prod.id) unexpected = true
    })

    const devEvent = nextEvent(socket, 'config.changed')
    await ws.setConfig({
      environmentId: prod.id,
      key: 'p',
      content: '1',
      contentType: 'text',
      userId: 'u1',
    })
    await ws.setConfig({
      environmentId: dev.id,
      key: 'd',
      content: '1',
      contentType: 'text',
      userId: 'u1',
    })

    const data = await devEvent
    expect(data).toMatchObject({ environmentId: dev.id, key: 'd' })
    expect(unexpected).toBe(false)
  })

  it('answers a client ping with a pong', async () => {
    const ws = workspace('ws-rt-ping')
    const socket = await openSocket(ws, 'u1')
    const pong = nextEvent(socket, 'pong')
    socket.send(JSON.stringify({ type: 'ping' }))
    expect(await pong).toMatchObject({ type: 'pong' })
  })
})
