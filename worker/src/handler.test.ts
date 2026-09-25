import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleRequest, resetTokenCache, type Env } from './handler'

const ORIGIN = 'https://pinchiehyu.github.io'
const env: Env = {
  FFLOGS_CLIENT_ID: 'id',
  FFLOGS_CLIENT_SECRET: 'secret',
  ALLOWED_ORIGINS: `${ORIGIN}, http://localhost:5173`,
}
const ctx = { waitUntil: () => {} }

function get(path: string, origin = ORIGIN): Request {
  return new Request(`https://api.example${path}`, { headers: { Origin: origin } })
}

function mockFflogs(graphqlBody: unknown) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/oauth/token')) {
      return Response.json({ access_token: 'tok', expires_in: 3600 })
    }
    return Response.json(graphqlBody, { status: init?.method === 'POST' ? 200 : 405 })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

beforeEach(() => resetTokenCache())
afterEach(() => vi.unstubAllGlobals())

describe('handleRequest', () => {
  it('rejects disallowed origins', async () => {
    const res = await handleRequest(get('/reports/abc', 'https://evil.example'), env, ctx, null)
    expect(res.status).toBe(403)
  })

  it('answers CORS preflight', async () => {
    const req = new Request('https://api.example/reports/abc', { method: 'OPTIONS', headers: { Origin: ORIGIN } })
    const res = await handleRequest(req, env, ctx, null)
    expect(res.status).toBe(204)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN)
  })

  it('returns the report and reuses the token', async () => {
    const fetchMock = mockFflogs({ data: { reportData: { report: { code: 'abc', fights: [] } } } })

    const res = await handleRequest(get('/reports/abc'), env, ctx, null)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ code: 'abc', fights: [] })
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN)

    await handleRequest(get('/reports/abc'), env, ctx, null)
    const tokenCalls = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/oauth/token'))
    expect(tokenCalls).toHaveLength(1)
  })

  it('passes validated event parameters to the GraphQL query', async () => {
    const fetchMock = mockFflogs({
      data: { reportData: { report: { events: { data: [], nextPageTimestamp: null } } } },
    })

    const res = await handleRequest(
      get('/reports/abc/events?fight=3&start=100&end=200&source=7&dataType=Casts&hostility=Enemies'),
      env,
      ctx,
      null,
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ data: [], nextPageTimestamp: null })

    const [, init] = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/api/v2/client'))!
    expect(JSON.parse(String(init!.body)).variables).toEqual({
      code: 'abc',
      fightIDs: [3],
      startTime: 100,
      endTime: 200,
      sourceID: 7,
      dataType: 'Casts',
      hostilityType: 'Enemies',
    })
  })

  it('rejects invalid parameters without calling FFLogs', async () => {
    const fetchMock = mockFflogs({})
    const cases = [
      '/reports/bad$code',
      '/reports/abc/events?start=1&end=2',
      '/reports/abc/events?fight=1&start=1&end=2&dataType=Nope',
      '/graphql',
    ]
    for (const path of cases) {
      const res = await handleRequest(get(path), env, ctx, null)
      expect(res.status, path).toBeGreaterThanOrEqual(400)
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('maps GraphQL errors and missing reports', async () => {
    mockFflogs({ errors: [{ message: 'You do not have permission to view this report.' }] })
    const denied = await handleRequest(get('/reports/abc'), env, ctx, null)
    expect(denied.status).toBe(400)
    expect(await denied.json()).toEqual({ error: 'You do not have permission to view this report.' })

    mockFflogs({ data: { reportData: { report: null } } })
    expect((await handleRequest(get('/reports/abc'), env, ctx, null)).status).toBe(404)
  })

  it('serves cached responses with CORS headers for the current origin', async () => {
    const fetchMock = mockFflogs({})
    const cache = {
      match: vi.fn(async () => new Response('{"cached":true}', { headers: { 'Content-Type': 'application/json' } })),
      put: vi.fn(async () => {}),
    }
    const res = await handleRequest(get('/reports/abc', 'http://localhost:5173'), env, ctx, cache)
    expect(await res.json()).toEqual({ cached: true })
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns Traditional Chinese ability names, converting Simplified when missing', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      const rows =
        url.searchParams.get('language') === 'tc'
          ? [
              { row_id: 7490, fields: { Name: '必殺劍·震天' } },
              { row_id: 7487, fields: { Name: '_rsv_7487_-1_7_0_0_SE2DC5B04_EE2DC5B04' } },
              { row_id: 42672, fields: { Name: '' } },
            ]
          : [
              { row_id: 7487, fields: { Name: '纷乱雪月花' } },
              { row_id: 42672, fields: { Name: '' } },
            ]
      return Response.json({ rows })
    })
    vi.stubGlobal('fetch', fetchMock)

    const res = await handleRequest(get('/abilities?ids=7490,7487,42672'), env, ctx, null)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      7490: { name: '必殺劍·震天', source: 'tc' },
      7487: { name: '紛亂雪月花', source: 'chs' },
    })
    // 簡中只查繁中缺少的
    const chsUrl = new URL(String(fetchMock.mock.calls[1][0]))
    expect(chsUrl.searchParams.get('rows')).toBe('7487,42672')
  })

  it('looks up item names (potions) in the Item sheet and marks HQ', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      const rows = url.pathname.endsWith('/Item')
        ? [{ row_id: 45995, fields: { Name: '3級剛力之寶藥' } }]
        : [{ row_id: 7490, fields: { Name: '必殺劍·震天' } }]
      return Response.json({ rows })
    })
    vi.stubGlobal('fetch', fetchMock)

    // 34600427 = 0x2000000 + 1,000,000（HQ）+ 道具 45995
    const res = await handleRequest(get('/abilities?ids=7490,34600427'), env, ctx, null)
    expect(await res.json()).toEqual({
      7490: { name: '必殺劍·震天', source: 'tc' },
      34600427: { name: '3級剛力之寶藥（HQ）', source: 'tc' },
    })
    const itemUrl = fetchMock.mock.calls.map(([u]) => new URL(String(u))).find((u) => u.pathname.endsWith('/Item'))!
    expect(itemUrl.searchParams.get('rows')).toBe('45995')
  })

  it('translates boss names by searching the NPC name sheet', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/search')) {
        const found = url.searchParams.get('query') === 'Singular="Howling Blade"'
        return Response.json({ results: found ? [{ row_id: 13843 }] : [] })
      }
      // /sheet/BNpcName/13843
      return Response.json({ fields: { Singular: url.searchParams.get('language') === 'tc' ? '呼嘯之劍' : '' } })
    })
    vi.stubGlobal('fetch', fetchMock)

    const res = await handleRequest(get('/npc-names?name=Howling%20Blade&name=Unknown%20Boss'), env, ctx, null)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ 'Howling Blade': { name: '呼嘯之劍', source: 'tc' } })
  })

  it('falls back to English when the name lookup fails, caching only briefly', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('timeout')
      }),
    )
    const put = vi.fn(async (_req: Request, _res: Response) => {})
    const cache = { match: async () => undefined, put }
    const res = await handleRequest(get('/npc-names?name=Howling%20Blade'), env, ctx, cache)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({})
    expect(put.mock.calls[0][1].headers.get('Cache-Control')).toBe('public, max-age=60')
  })

  it('validates npc names', async () => {
    const fetchMock = mockFflogs({})
    for (const path of ['/npc-names', '/npc-names?name=a%22%20OR%201', `/npc-names?${'name=x&'.repeat(1)}${Array.from({ length: 21 }, (_, i) => `name=n${i}`).join('&')}`]) {
      expect((await handleRequest(get(path), env, ctx, null)).status, path).toBe(400)
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('validates ability ids', async () => {
    const fetchMock = mockFflogs({})
    // 5000000 既不在技能也不在道具的 ID 範圍
    for (const path of ['/abilities', '/abilities?ids=1,x', '/abilities?ids=5000000']) {
      expect((await handleRequest(get(path), env, ctx, null)).status, path).toBe(400)
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('enforces the rate limiter', async () => {
    const limited: Env = { ...env, RATE_LIMITER: { limit: async () => ({ success: false }) } }
    expect((await handleRequest(get('/reports/abc'), limited, ctx, null)).status).toBe(429)
  })
})
