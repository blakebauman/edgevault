import { isAssistantProposal } from '@edgevault/edge-protocol'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { formatTime, humanizeAction } from '../../lib/format'
import { Loader } from './loader'
import { ProposalCard } from './proposal-card'
import { Tool, type ToolState } from './tool'

/**
 * Per-tool result cards for the assistant thread.
 *
 * Two tiers: `renderToolCard` returns a compact, purpose-built card for the
 * tools worth reading at a glance, or `null` to fall through to the generic
 * collapsible in `tool.tsx`. Adding a tool costs nothing — it renders generically
 * until someone decides it deserves better — and no tool is ever silently
 * dropped, which is what the assistant did with everything but search hits.
 */

export type ToolCardProps = {
  name: string
  state: ToolState
  input?: unknown
  output?: unknown
  errorText?: string
  /** Workspace id, for linking results back into the console. */
  workspaceId: string
}

type ConfigHit = { key: string; environmentId: string; kind?: string; score?: number }
type ActivityEvent = { action: string; resourceType?: string; resourceId?: string; at?: string }

function isConfigHits(value: unknown): value is ConfigHit[] {
  return (
    Array.isArray(value) &&
    value.every(
      (h) =>
        h !== null &&
        typeof h === 'object' &&
        typeof (h as ConfigHit).key === 'string' &&
        typeof (h as ConfigHit).environmentId === 'string',
    )
  )
}

function isActivity(value: unknown): value is ActivityEvent[] {
  return (
    Array.isArray(value) &&
    value.every(
      (e) => e !== null && typeof e === 'object' && typeof (e as ActivityEvent).action === 'string',
    )
  )
}

/** Shared chrome so every bespoke card reads as the same kind of object. */
function Card({
  label,
  tone,
  children,
}: {
  label: ReactNode
  tone?: 'ok' | 'warn' | 'error'
  children?: ReactNode
}) {
  return (
    <div className="tool-mini" data-tone={tone}>
      <p className="tool-mini-head">{label}</p>
      {children}
    </div>
  )
}

/** Every tool shares the same in-flight and failed presentation. */
function Pending({ name }: { name: string }) {
  return (
    <div className="tool-mini" data-pending="true">
      <p className="tool-mini-head">
        <Loader size={11} />
        Running <code>{name}</code>…
      </p>
    </div>
  )
}

export function renderToolCard({
  name,
  state,
  output,
  errorText,
  workspaceId,
}: ToolCardProps): ReactNode | null {
  if (state === 'streaming' || state === 'loading') return <Pending name={name} />
  // Errors fall through to the full card — the arguments are usually the reason.
  if (state === 'error' || errorText) return null

  switch (name) {
    // The propose* tools write nothing; their output *is* the proposal, and the
    // card is where a human turns it into a real change. The guard is what keeps
    // the union closed — an output that isn't a shape we know falls through to
    // the generic collapsible rather than rendering model-authored UI.
    case 'proposeChange':
    case 'proposePromotion': {
      if (!isAssistantProposal(output)) return null
      return <ProposalCard proposal={output} workspaceId={workspaceId} />
    }

    case 'searchConfigs': {
      if (!isConfigHits(output)) return null
      if (output.length === 0) return <Card label="No matching items" />
      return (
        <Card label={`${output.length} matching ${output.length === 1 ? 'item' : 'items'}`}>
          <div className="hits">
            {output.map((hit) => (
              <Link
                key={`${hit.environmentId}:${hit.key}`}
                to={`/dashboard/${workspaceId}/env/${hit.environmentId}`}
                className="hit"
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M12 2 3 7v10l9 5 9-5V7z" />
                </svg>
                {hit.key}
              </Link>
            ))}
          </div>
        </Card>
      )
    }

    case 'recentActivity': {
      if (!isActivity(output)) return null
      if (output.length === 0) return <Card label="No recent changes" />
      const shown = output.slice(0, 5)
      return (
        <Card label={`${output.length} recent ${output.length === 1 ? 'change' : 'changes'}`}>
          <ul className="tool-rows">
            {shown.map((event, i) => (
              <li key={`${event.action}:${event.resourceId ?? i}`}>
                <span className="tool-row-action">{humanizeAction(event.action)}</span>
                {event.resourceId && <code>{event.resourceId}</code>}
                {event.at && <time>{formatTime(Date.parse(event.at))}</time>}
              </li>
            ))}
            {output.length > shown.length && (
              <li className="tool-row-more">+{output.length - shown.length} more</li>
            )}
          </ul>
        </Card>
      )
    }

    default:
      return null
  }
}

/** A tool part: the bespoke card when one exists, else the generic collapsible. */
export function ToolPart(props: ToolCardProps) {
  return (
    renderToolCard(props) ?? (
      <Tool
        name={props.name}
        state={props.state}
        input={props.input}
        output={props.output}
        errorText={props.errorText}
      />
    )
  )
}
