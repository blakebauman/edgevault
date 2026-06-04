#!/usr/bin/env node
// Generate the platform secrets EdgeVault needs, using only Node built-ins (no
// deps). Prints values + the `wrangler secret put` commands to set them. Run:
//   node scripts/gen-secrets.mjs
//
// NEVER commit these values. Prefer Secrets Store for production.

import { webcrypto as crypto } from 'node:crypto'

function b64(bytes) {
  return Buffer.from(bytes).toString('base64')
}
function b64url(bytes) {
  return Buffer.from(bytes).toString('base64url')
}

// RFC 7638 JWK thumbprint for an OKP (Ed25519) key → stable `kid`.
async function thumbprint(jwk) {
  const json = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x })
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(json))
  return b64url(new Uint8Array(digest))
}

async function main() {
  // EdDSA (Ed25519) signing key for the auth worker's JWT/JWKS.
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
  const exported = await crypto.subtle.exportKey('jwk', pair.privateKey)
  const kid = await thumbprint(exported)
  // Drop WebCrypto's key_ops/ext so the derived public JWK isn't pinned to "sign".
  const { key_ops: _ops, ext: _ext, ...privateJwk } = exported
  const jwtPrivateJwk = JSON.stringify({ ...privateJwk, alg: 'EdDSA', kid })

  const masterKek = b64(crypto.getRandomValues(new Uint8Array(32)))
  const internalToken = b64url(crypto.getRandomValues(new Uint8Array(32)))

  console.log(`
# ── EdgeVault platform secrets — DO NOT COMMIT ────────────────────────────────

# Auth signing key (EdDSA JWK) — auth worker
JWT_PRIVATE_JWK='${jwtPrivateJwk}'

# Envelope-encryption master key (base64, 32 bytes) — auth + api + ee/enterprise
# (must be IDENTICAL across those workers so secrets decrypt everywhere)
MASTER_KEK='${masterKek}'

# Internal mesh shared secret — console + auth + ee/enterprise
INTERNAL_TOKEN='${internalToken}'

# Set them (repeat MASTER_KEK/INTERNAL_TOKEN for each worker that needs them):
#   echo -n "$JWT_PRIVATE_JWK" | npx wrangler secret put JWT_PRIVATE_JWK --name edgevault-auth
#   echo -n "$MASTER_KEK"      | npx wrangler secret put MASTER_KEK      --name edgevault-auth
#   echo -n "$MASTER_KEK"      | npx wrangler secret put MASTER_KEK      --name edgevault-api
#   echo -n "$MASTER_KEK"      | npx wrangler secret put MASTER_KEK      --name edgevault-enterprise
#   echo -n "$INTERNAL_TOKEN"  | npx wrangler secret put INTERNAL_TOKEN  --name edgevault-auth
#   echo -n "$INTERNAL_TOKEN"  | npx wrangler secret put INTERNAL_TOKEN  --name edgevault-enterprise
#   echo -n "$INTERNAL_TOKEN"  | npx wrangler secret put INTERNAL_TOKEN  --name edgevault-console
#
# Provider/billing secrets (set the ones you use):
#   GITHUB_CLIENT_ID GITHUB_CLIENT_SECRET GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET  (edgevault-auth)
#   STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET                                       (edgevault-control-plane)
`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
