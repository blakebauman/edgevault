import { describe, expect, it } from 'vitest'
import {
  decryptSecret,
  encryptSecret,
  generateMasterKey,
  isSecretEnvelope,
  rewrapEnvelope,
} from '../src/index'

const master = generateMasterKey()
const ws = 'workspace-1'

describe('envelope encryption', () => {
  it('round-trips a secret', async () => {
    const env = await encryptSecret(master, ws, 'super-secret-value')
    expect(env.v).toBe(1)
    expect(env.ciphertext).not.toContain('super-secret-value')
    expect(await decryptSecret(master, ws, env)).toBe('super-secret-value')
  })

  it('produces a unique DEK/iv per encryption', async () => {
    const a = await encryptSecret(master, ws, 'same')
    const b = await encryptSecret(master, ws, 'same')
    expect(a.ciphertext).not.toBe(b.ciphertext)
    expect(a.wrappedDek).not.toBe(b.wrappedDek)
  })

  it('fails to decrypt with the wrong master key', async () => {
    const env = await encryptSecret(master, ws, 'secret')
    await expect(decryptSecret(generateMasterKey(), ws, env)).rejects.toThrow()
  })

  it('fails to decrypt under a different workspace (KEK is workspace-scoped)', async () => {
    const env = await encryptSecret(master, ws, 'secret')
    await expect(decryptSecret(master, 'other-workspace', env)).rejects.toThrow()
  })

  it('rotates the master key by re-wrapping the DEK (payload unchanged)', async () => {
    const env = await encryptSecret(master, ws, 'rotate-me')
    const newMaster = generateMasterKey()
    const rewrapped = await rewrapEnvelope(master, newMaster, ws, env)

    expect(rewrapped.kekVersion).toBe(env.kekVersion + 1)
    expect(rewrapped.ciphertext).toBe(env.ciphertext) // payload not re-encrypted
    expect(rewrapped.wrappedDek).not.toBe(env.wrappedDek)
    expect(await decryptSecret(newMaster, ws, rewrapped)).toBe('rotate-me')
    await expect(decryptSecret(master, ws, rewrapped)).rejects.toThrow() // old key no longer works
  })

  it('recognizes a secret envelope', () => {
    expect(isSecretEnvelope({ v: 1, ciphertext: 'x' })).toBe(true)
    expect(isSecretEnvelope({ foo: 'bar' })).toBe(false)
  })
})
