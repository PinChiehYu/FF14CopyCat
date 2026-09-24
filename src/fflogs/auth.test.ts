import { describe, expect, it } from 'vitest'
import { codeChallenge, randomString } from './auth'

describe('PKCE helpers', () => {
  it('computes the RFC 7636 S256 challenge', async () => {
    // RFC 7636 附錄 B 的範例
    expect(await codeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    )
  })

  it('produces URL-safe random strings', () => {
    expect(randomString()).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })
})
