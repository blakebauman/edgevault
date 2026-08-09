import type { AssistantProposal } from '@edgevault/edge-protocol'
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router'
import { Loader } from './loader'

/**
 * A change the assistant proposed, and the button that applies it.
 *
 * Two things make this safe to show. The model only ever produced the JSON —
 * approving posts to the console's own BFF, which calls the same control-plane
 * endpoint the config editor calls, with the user's session. And the card
 * reconciles against the live item before offering the button, so a proposal
 * sitting in month-old chat history reads "Applied" — or shows what it would
 * overwrite — rather than quietly inviting someone to revert a later edit.
 */

/**
 * There is deliberately no "superseded" state. Detecting that someone edited
 * the item *after* the proposal was made would need the value as of proposal
 * time, which nothing stores — the model's reading of it isn't trustworthy
 * enough to serve as a baseline. Instead the card always shows the live current
 * value beside the proposed one, so the human sees exactly what they would
 * overwrite. That's the real check; a status badge would only imply a guarantee
 * we can't make.
 */
type Reconciled =
  /** Haven't looked yet. */
  | { status: 'checking' }
  /** The item's current value already equals what was proposed. */
  | { status: 'applied' }
  /** Applicable: either a new item, or an existing one with a different value. */
  | { status: 'actionable'; current?: string; exists: boolean }
  | { status: 'error'; message: string }

type Applied = { done: boolean; error?: string; busy: boolean }

function proposalKey(proposal: AssistantProposal): { environmentId: string; key: string } {
  return proposal.kind === 'promotion'
    ? { environmentId: proposal.targetEnvironmentId, key: proposal.key }
    : { environmentId: proposal.environmentId, key: proposal.key }
}

/** Trim-insensitive compare; the model routinely differs only in trailing space. */
function sameValue(a: string | undefined, b: string): boolean {
  return (a ?? '').trim() === b.trim()
}

export function ProposalCard({
  proposal,
  workspaceId,
}: {
  proposal: AssistantProposal
  workspaceId: string
}) {
  const [state, setState] = useState<Reconciled>({ status: 'checking' })
  const [applied, setApplied] = useState<Applied>({ done: false, busy: false })
  const target = proposalKey(proposal)
  const base = `/dashboard/${encodeURIComponent(workspaceId)}/assistant/proposal`

  // Reconcile against the live item on mount. A promotion has no proposed
  // content to compare, so it is always actionable — promoting twice is
  // idempotent in effect, and the control plane records the revision either way.
  useEffect(() => {
    let cancelled = false
    const params = new URLSearchParams({ environmentId: target.environmentId, key: target.key })
    fetch(`${base}?${params}`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((body) => {
        if (cancelled) return
        const current = body as { exists: boolean; content?: string }
        if (proposal.kind === 'promotion') {
          setState({ status: 'actionable', exists: current.exists })
          return
        }
        if (current.exists && sameValue(current.content, proposal.content)) {
          setState({ status: 'applied' })
          return
        }
        setState({ status: 'actionable', current: current.content, exists: current.exists })
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'error', message: 'Could not read the current value.' })
      })
    return () => {
      cancelled = true
    }
  }, [base, target.environmentId, target.key, proposal])

  const apply = useCallback(async () => {
    setApplied({ done: false, busy: true })
    try {
      const res = await fetch(base, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(proposal),
      })
      const body = (await res.json().catch(() => null)) as { error?: string } | null
      if (!res.ok) {
        setApplied({
          done: false,
          busy: false,
          error: body?.error ?? 'Could not apply the change.',
        })
        return
      }
      setApplied({ done: true, busy: false })
    } catch {
      setApplied({ done: false, busy: false, error: 'Could not reach the server.' })
    }
  }, [base, proposal])

  const settled = applied.done || state.status === 'applied'

  return (
    <div className="prop-card" data-settled={settled ? 'true' : undefined}>
      <p className="prop-head">
        <span className="prop-tag">{proposal.kind === 'promotion' ? 'Promotion' : 'Change'}</span>
        <code>{target.key}</code>
        {settled && <span className="prop-state">Applied</span>}
      </p>

      <p className="prop-why">{proposal.rationale}</p>

      {proposal.kind === 'config-change' ? (
        <ChangeBody proposal={proposal} state={state} />
      ) : (
        <p className="prop-move">
          <code>{proposal.sourceEnvironmentId}</code> → <code>{proposal.targetEnvironmentId}</code>
        </p>
      )}

      {state.status === 'error' && <p className="prop-err">{state.message}</p>}
      {applied.error && <p className="prop-err">{applied.error}</p>}

      <div className="prop-acts">
        {state.status === 'checking' && (
          <span className="prop-state">
            <Loader size={11} /> Checking current value…
          </span>
        )}

        {!settled && state.status === 'actionable' && (
          <button type="button" className="prop-apply" onClick={apply} disabled={applied.busy}>
            {applied.busy ? 'Applying…' : 'Apply'}
          </button>
        )}

        {settled && (
          <Link className="prop-link" to={`/dashboard/${workspaceId}/env/${target.environmentId}`}>
            View item
          </Link>
        )}
      </div>
    </div>
  )
}

function ChangeBody({
  proposal,
  state,
}: {
  proposal: Extract<AssistantProposal, { kind: 'config-change' }>
  state: Reconciled
}) {
  const current = state.status === 'actionable' ? state.current : undefined
  const isNew = state.status === 'actionable' && !state.exists

  return (
    <div className="prop-diff">
      {isNew ? (
        <p className="prop-new">New {proposal.itemKind}</p>
      ) : (
        current !== undefined && (
          <>
            <p className="prop-cap">Current</p>
            <pre data-side="before">{current}</pre>
          </>
        )
      )}
      <p className="prop-cap">Proposed</p>
      <pre data-side="after">{proposal.content}</pre>
    </div>
  )
}
