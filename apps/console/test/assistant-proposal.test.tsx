import type { AssistantProposal } from '@edgevault/edge-protocol'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProposalCard } from '../app/components/ai-elements/proposal-card'

/**
 * The assistant can propose a change but never make one. These cover the two
 * properties that make that safe to put in front of a user: the card reconciles
 * against the live item before offering a button (so stale chat history can't
 * invite a silent revert), and applying goes out as a request the console's own
 * BFF authorizes.
 */

const WS = 'ws_1'
const PROPOSAL: AssistantProposal = {
  kind: 'config-change',
  environmentId: 'env_a',
  key: 'checkout.timeout',
  itemKind: 'config',
  content: '{"ms":3000}',
  rationale: 'The current value times out before the upstream does.',
}

function renderInRouter(ui: ReactNode) {
  const router = createMemoryRouter([{ path: '/', element: ui }], { initialEntries: ['/'] })
  return render(<RouterProvider router={router} />)
}

/** Stub the two calls the card makes: GET to reconcile, POST to apply. */
function stubFetch(handlers: { current?: unknown; apply?: unknown; applyOk?: boolean }) {
  const calls: Array<{ url: string; method: string; body?: string }> = []
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body as string | undefined })
    if ((init?.method ?? 'GET') === 'GET') {
      return new Response(JSON.stringify(handlers.current ?? { exists: false }), { status: 200 })
    }
    return new Response(JSON.stringify(handlers.apply ?? { applied: true }), {
      status: handlers.applyOk === false ? 403 : 200,
    })
  })
  vi.stubGlobal('fetch', fetchMock)
  return calls
}

afterEach(() => vi.unstubAllGlobals())

describe('ProposalCard', () => {
  it('offers Apply for a new item, and shows the proposed value', async () => {
    stubFetch({ current: { exists: false } })
    renderInRouter(<ProposalCard proposal={PROPOSAL} workspaceId={WS} />)

    expect(await screen.findByRole('button', { name: 'Apply' })).toBeInTheDocument()
    expect(screen.getByText('New config')).toBeInTheDocument()
    expect(screen.getByText('{"ms":3000}')).toBeInTheDocument()
    expect(screen.getByText(PROPOSAL.rationale)).toBeInTheDocument()
  })

  it('reports Applied instead of a button when the live value already matches', async () => {
    // The case that matters for durable chat history: reopening an old thread
    // must not invite someone to redo work that is already done.
    stubFetch({ current: { exists: true, version: 4, content: '{"ms":3000}' } })
    renderInRouter(<ProposalCard proposal={PROPOSAL} workspaceId={WS} />)

    expect(await screen.findByText('Applied')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Apply' })).not.toBeInTheDocument()
  })

  it('ignores whitespace-only differences when reconciling', async () => {
    stubFetch({ current: { exists: true, version: 4, content: '  {"ms":3000}\n' } })
    renderInRouter(<ProposalCard proposal={PROPOSAL} workspaceId={WS} />)
    expect(await screen.findByText('Applied')).toBeInTheDocument()
  })

  it('shows the current value beside the proposed one when they differ', async () => {
    // There is no "superseded" badge, by design — showing what would be
    // overwritten is the check, rather than a status we cannot actually prove.
    stubFetch({ current: { exists: true, version: 4, content: '{"ms":1000}' } })
    renderInRouter(<ProposalCard proposal={PROPOSAL} workspaceId={WS} />)

    expect(await screen.findByRole('button', { name: 'Apply' })).toBeInTheDocument()
    expect(screen.getByText('Current')).toBeInTheDocument()
    expect(screen.getByText('{"ms":1000}')).toBeInTheDocument()
    expect(screen.getByText('Proposed')).toBeInTheDocument()
  })

  it('applies through the console BFF, posting the proposal verbatim', async () => {
    const calls = stubFetch({ current: { exists: false } })
    renderInRouter(<ProposalCard proposal={PROPOSAL} workspaceId={WS} />)

    await userEvent.click(await screen.findByRole('button', { name: 'Apply' }))
    await waitFor(() => expect(screen.getByText('Applied')).toBeInTheDocument())

    const post = calls.find((c) => c.method === 'POST')
    expect(post?.url).toBe(`/dashboard/${WS}/assistant/proposal`)
    expect(JSON.parse(post?.body ?? '{}')).toEqual(PROPOSAL)
  })

  it("surfaces the server's refusal rather than claiming success", async () => {
    stubFetch({
      current: { exists: false },
      applyOk: false,
      apply: { error: 'Your role does not allow this change.' },
    })
    renderInRouter(<ProposalCard proposal={PROPOSAL} workspaceId={WS} />)

    await userEvent.click(await screen.findByRole('button', { name: 'Apply' }))
    await waitFor(() =>
      expect(screen.getByText('Your role does not allow this change.')).toBeInTheDocument(),
    )
    expect(screen.queryByText('Applied')).not.toBeInTheDocument()
  })

  it('renders a promotion as a move between environments', async () => {
    stubFetch({ current: { exists: false } })
    const promotion: AssistantProposal = {
      kind: 'promotion',
      sourceEnvironmentId: 'env_staging',
      targetEnvironmentId: 'env_prod',
      key: 'checkout.timeout',
      rationale: 'Staging has been stable for a week.',
    }
    renderInRouter(<ProposalCard proposal={promotion} workspaceId={WS} />)

    expect(await screen.findByRole('button', { name: 'Apply' })).toBeInTheDocument()
    expect(screen.getByText('Promotion')).toBeInTheDocument()
    expect(screen.getByText('env_staging')).toBeInTheDocument()
    expect(screen.getByText('env_prod')).toBeInTheDocument()
  })

  it('does not offer a button it cannot honour when reconciliation fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 })),
    )
    renderInRouter(<ProposalCard proposal={PROPOSAL} workspaceId={WS} />)

    expect(await screen.findByText('Could not read the current value.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Apply' })).not.toBeInTheDocument()
  })
})
