import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { describe, expect, it } from 'vitest'
import { renderToolCard, ToolPart } from '../app/components/ai-elements/tool-cards'

/**
 * The assistant used to drop every tool part except search hits, so a user
 * could not tell a grounded answer from a guess. These cover the dispatch that
 * replaced it: a bespoke card where one exists, the generic collapsible
 * otherwise, and never nothing.
 */

function renderInRouter(ui: ReactNode) {
  const router = createMemoryRouter([{ path: '/', element: ui }], { initialEntries: ['/'] })
  return render(<RouterProvider router={router} />)
}

const WS = 'ws_1'

describe('renderToolCard', () => {
  it('shows a running indicator while a tool is in flight', () => {
    renderInRouter(renderToolCard({ name: 'searchConfigs', state: 'loading', workspaceId: WS }))
    expect(screen.getByText(/Running/)).toBeInTheDocument()
    expect(screen.getByText('searchConfigs')).toBeInTheDocument()
  })

  it('renders search hits as links into the owning environment', () => {
    renderInRouter(
      renderToolCard({
        name: 'searchConfigs',
        state: 'complete',
        workspaceId: WS,
        output: [
          { key: 'checkout.timeout', environmentId: 'env_a', kind: 'config', score: 0.9 },
          { key: 'checkout.retries', environmentId: 'env_b', kind: 'config', score: 0.8 },
        ],
      }),
    )
    expect(screen.getByText('2 matching items')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /checkout\.timeout/ })).toHaveAttribute(
      'href',
      `/dashboard/${WS}/env/env_a`,
    )
  })

  it('says so plainly when a search found nothing', () => {
    renderInRouter(
      renderToolCard({
        name: 'searchConfigs',
        state: 'complete',
        workspaceId: WS,
        output: [],
      }),
    )
    expect(screen.getByText('No matching items')).toBeInTheDocument()
  })

  it('summarises recent activity in human words', () => {
    renderInRouter(
      renderToolCard({
        name: 'recentActivity',
        state: 'complete',
        workspaceId: WS,
        output: [
          {
            action: 'config.updated',
            resourceId: 'checkout.timeout',
            at: '2026-08-01T10:00:00.000Z',
          },
        ],
      }),
    )
    expect(screen.getByText('1 recent change')).toBeInTheDocument()
    expect(screen.getByText('updated')).toBeInTheDocument()
  })

  it('falls through to the generic card for an unknown tool', () => {
    // The point of the two-tier scheme: adding a tool server-side must never
    // make it invisible in the thread.
    const card = renderToolCard({
      name: 'somethingBrandNew',
      state: 'complete',
      workspaceId: WS,
      output: { fine: true },
    })
    expect(card).toBeNull()
  })

  it('falls through when a known tool returns an unrecognised shape', () => {
    const card = renderToolCard({
      name: 'searchConfigs',
      state: 'complete',
      workspaceId: WS,
      output: { unexpected: 'shape' },
    })
    expect(card).toBeNull()
  })
})

describe('ToolPart', () => {
  it('renders the generic collapsible when no bespoke card matches', () => {
    renderInRouter(
      <ToolPart
        name="somethingBrandNew"
        state="complete"
        workspaceId={WS}
        input={{ q: 'hi' }}
        output={{ ok: true }}
      />,
    )
    expect(screen.getByText('somethingBrandNew')).toBeInTheDocument()
    expect(screen.getByText('Done')).toBeInTheDocument()
    expect(screen.getByText('Parameters')).toBeInTheDocument()
    expect(screen.getByText('Result')).toBeInTheDocument()
  })

  it('surfaces a failure as an error, with the reason', () => {
    renderInRouter(
      <ToolPart
        name="searchConfigs"
        state="error"
        workspaceId={WS}
        input={{ query: 'x' }}
        errorText="Vectorize unavailable"
      />,
    )
    expect(screen.getByText('Failed')).toBeInTheDocument()
    expect(screen.getByText('Error')).toBeInTheDocument()
    expect(screen.getByText('Vectorize unavailable')).toBeInTheDocument()
  })

  it('labels a tool awaiting approval rather than showing it as done', () => {
    renderInRouter(<ToolPart name="proposeChange" state="waiting-approval" workspaceId={WS} />)
    expect(screen.getByText('Needs approval')).toBeInTheDocument()
  })
})
