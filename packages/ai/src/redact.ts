/**
 * Deterministic credential redaction for every model boundary (risk prompts,
 * embeddings, assistant context). Secrets proper never reach these paths —
 * this catches credential-looking strings living inside plain config values.
 * Boring on purpose: patterns + an entropy fallback, no model in the loop.
 */

interface Pattern {
  type: string
  re: RegExp
}

const PATTERNS: Pattern[] = [
  // PEM blocks (keys, certs) — multi-line, greedy within the block.
  {
    type: 'pem',
    re: /-----BEGIN [A-Z0-9 ]+-----[\s\S]+?-----END [A-Z0-9 ]+-----/g,
  },
  // AWS access key ids (long-term and STS).
  { type: 'aws-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  // GitHub tokens (classic + fine-grained).
  { type: 'github-token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g },
  { type: 'github-token', re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g },
  // Common "sk-..." style provider keys (32+ chars after the prefix).
  { type: 'provider-key', re: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  // Slack tokens.
  { type: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  // Our own keys (evk_) and webhook secrets (evw_).
  { type: 'edgevault-key', re: /\bev[kw]_[A-Za-z0-9_-]{8,}\b/g },
  // JWT shape: three base64url segments, the first decoding to a header.
  {
    type: 'jwt',
    re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
  // URL credentials: scheme://user:password@host
  { type: 'url-credentials', re: /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+(@)/gi },
  // key=value / key: value pairs whose key smells like a credential.
  {
    type: 'credential-pair',
    re: /\b((?:password|passwd|secret|token|api[_-]?key|private[_-]?key|client[_-]?secret|access[_-]?key)\w*\s*[=:]\s*["']?)[^\s"',;]{6,}/gi,
  },
]

/** Shannon entropy per character, in bits. */
function entropy(s: string): number {
  const counts = new Map<string, number>()
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1)
  let h = 0
  for (const n of counts.values()) {
    const p = n / s.length
    h -= p * Math.log2(p)
  }
  return h
}

// High-entropy fallback: long unbroken base64url/hex runs that look generated.
// '/' is deliberately excluded — filesystem paths are long charset-compatible
// runs, and standard-base64 credentials still trip the other patterns.
// Threshold ~4 bits/char keeps prose and UUIDs (3.6–3.8) out.
const ENTROPY_RUN = /[A-Za-z0-9+=_-]{32,}/g
const ENTROPY_THRESHOLD = 4.2

export interface RedactionResult {
  text: string
  redactions: number
}

/** Replace credential-looking substrings with `[REDACTED:{type}]`. */
export function redactCredentials(input: string): RedactionResult {
  let text = input
  let redactions = 0

  for (const { type, re } of PATTERNS) {
    text = text.replace(re, (_match, ...groups) => {
      redactions++
      // Patterns with capture groups keep their prefix/suffix context.
      if (type === 'url-credentials') return `${groups[0]}[REDACTED:password]${groups[1]}`
      if (type === 'credential-pair') return `${groups[0]}[REDACTED:credential]`
      return `[REDACTED:${type}]`
    })
  }

  text = text.replace(ENTROPY_RUN, (match) => {
    // Already-redacted markers and low-entropy runs pass through.
    if (match.includes('REDACTED') || entropy(match) < ENTROPY_THRESHOLD) return match
    redactions++
    return '[REDACTED:high-entropy]'
  })

  return { text, redactions }
}
