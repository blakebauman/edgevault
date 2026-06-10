import { describe, expect, it } from 'vitest'
import { configEmbeddingText } from '../src/embeddings'
import { redactCredentials } from '../src/redact'

describe('redactCredentials', () => {
  const cases: Array<[string, string, string]> = [
    ['aws access key', 'key=AKIAIOSFODNN7EXAMPLE', '[REDACTED'],
    ['aws sts key', 'ASIAIOSFODNN7EXAMPLE in text', '[REDACTED:aws-key]'],
    [
      'github classic token',
      'use ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789 here',
      '[REDACTED:github-token]',
    ],
    [
      'github fine-grained token',
      'github_pat_11ABCDEFG0123456789_abcdefghijklmnop',
      '[REDACTED:github-token]',
    ],
    ['provider sk- key', 'sk-abcdefghijklmnopqrstuvwxyz123456', '[REDACTED:provider-key]'],
    ['slack token', 'xoxb-123456789012-abcdefghijklmnop', '[REDACTED:slack-token]'],
    ['edgevault key', 'evk_live_abcdef123456', '[REDACTED:edgevault-key]'],
    [
      'jwt',
      'bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV',
      '[REDACTED:jwt]',
    ],
    [
      'url credentials',
      'postgres://admin:hunter2secret@db.internal:5432/app',
      '[REDACTED:password]',
    ],
    ['password pair', 'password = "correct-horse-battery"', '[REDACTED:credential]'],
    ['api key pair', 'API_KEY: 0123456789abcdef', '[REDACTED:credential]'],
  ]
  for (const [name, input, marker] of cases) {
    it(`redacts ${name}`, () => {
      const { text, redactions } = redactCredentials(input)
      expect(text).toContain(marker)
      expect(redactions).toBeGreaterThan(0)
    })
  }

  it('redacts PEM blocks', () => {
    const pem = `-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----`
    expect(redactCredentials(pem).text).toBe('[REDACTED:pem]')
  })

  it('redacts long high-entropy runs', () => {
    const generated = 'value is rQ8x2NfLp0Zw5Kc7Jh1Vm3Ys9Bd4Tg6Ue8Ia0Oq2Ws4Ed6Rf'
    expect(redactCredentials(generated).text).toContain('[REDACTED:high-entropy]')
  })

  it('leaves ordinary config content untouched (false-positive guard)', () => {
    const plain = [
      '{"timeout": 30, "retries": 3, "endpoint": "https://api.example.com/v2/items"}',
      'feature.checkout.enabled=true',
      'a sentence of perfectly normal prose about configuration management',
      'uuid: 01890a5d-ac96-774b-bcce-b302099a8057',
      '/var/lib/edgevault/data/workspace-snapshots/2026-06-09',
    ].join('\n')
    const { text, redactions } = redactCredentials(plain)
    expect(redactions).toBe(0)
    expect(text).toBe(plain)
  })

  it('configEmbeddingText embeds redacted content', () => {
    const text = configEmbeddingText({
      key: 'DATABASE_URL',
      kind: 'config',
      contentType: 'text',
      content: 'postgres://app:supersecretpw@host:5432/db',
    })
    expect(text).toContain('DATABASE_URL')
    expect(text).not.toContain('supersecretpw')
  })
})
