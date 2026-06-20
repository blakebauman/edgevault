import { env } from 'cloudflare:test'
import { pageCacheKey } from '@edgevault/edge-protocol'
import { describe, expect, it } from 'vitest'
import { publishWithRender } from '../src/content-render'
import type { VaultDurableObject } from '../src/durable-objects/vault'

function workspace(name: string) {
  return env.WORKSPACE.get(env.WORKSPACE.idFromName(name)) as DurableObjectStub<VaultDurableObject>
}

describe('render at publish', () => {
  it('renders a content document to HTML in KV, composing reusable blocks', async () => {
    const ws = workspace('ws-render')
    const dev = await ws.createEnvironment({ name: 'Dev', slug: 'dev', userId: 'u1' })

    await ws.setConfig({
      environmentId: dev.id,
      key: 'block.hero',
      kind: 'content',
      content: JSON.stringify({ type: 'hero', props: { heading: 'Welcome' } }),
      userId: 'u1',
    })
    const doc = await ws.setConfig({
      environmentId: dev.id,
      key: 'doc.home',
      kind: 'content',
      content: JSON.stringify({
        layout: 'page',
        blocks: ['${block.hero}', { type: 'cta', props: { label: 'Docs', href: 'https://x.io' } }],
      }),
      userId: 'u1',
    })

    const { targets } = await ws.collectPublishTargets(dev.id, 'doc.home')
    await publishWithRender(env, ws, 'ws-render', targets)

    const html = await env.CONFIGS_CACHE.get(pageCacheKey('ws-render', dev.id, 'doc.home'))
    expect(html).not.toBeNull()
    expect(html).toContain('<!doctype html>') // page layout shell applied
    expect(html).toContain('<section class="hero"><h1>Welcome</h1></section>') // composed block
    // External link got the HTMLRewriter post-process pass.
    expect(html).toContain('rel="noopener noreferrer"')
    expect(html).toContain('target="_blank"')

    // A block on its own is not a page — no html: key is written for it.
    const blockHtml = await env.CONFIGS_CACHE.get(pageCacheKey('ws-render', dev.id, 'block.hero'))
    expect(blockHtml).toBeNull()

    // Editing the shared block re-renders the dependent document.
    await ws.setConfig({
      environmentId: dev.id,
      key: 'block.hero',
      kind: 'content',
      content: JSON.stringify({ type: 'hero', props: { heading: 'Welcome back' } }),
      userId: 'u1',
    })
    const fanout = await ws.collectPublishTargets(dev.id, 'block.hero')
    await publishWithRender(env, ws, 'ws-render', fanout.targets)
    const updated = await env.CONFIGS_CACHE.get(pageCacheKey('ws-render', dev.id, 'doc.home'))
    expect(updated).toContain('<h1>Welcome back</h1>')
    expect(doc.kind).toBe('content')
  })
})
