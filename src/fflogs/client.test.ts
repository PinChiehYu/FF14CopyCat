import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchReport, fightNameParts, translateFightName } from './client'

describe('translateFightName', () => {
  const names = new Map([
    ['Howling Blade', '呼嘯之劍'],
    ['living liquid', '有生命活水'],
    ['liquid hand', '活水之手'],
  ])

  it('translates a single boss name', () => {
    expect(translateFightName('Howling Blade', names)).toBe('呼嘯之劍')
  })

  it('translates each part of a multi-NPC fight name and keeps unknown parts', () => {
    expect(fightNameParts('living liquid / liquid hand / ... ')).toEqual(['living liquid', 'liquid hand', '...'])
    expect(translateFightName('living liquid / liquid hand / Cruise Chaser', names)).toBe('有生命活水 / 活水之手 / Cruise Chaser')
  })
})

describe('request timeout', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  // 不回應的請求：直到被取消才以 AbortError 結束
  const hanging = (_url: string, init: RequestInit) =>
    new Promise<Response>((_, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    })

  it('retries once when a request hangs, then succeeds', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(hanging).mockImplementationOnce(hanging).mockImplementationOnce(async () => Response.json({ code: 'abc' }))
    vi.stubGlobal('fetch', fetchMock)
    const pending = fetchReport('abc')
    await vi.advanceTimersByTimeAsync(45_000)
    await expect(pending).resolves.toEqual({ code: 'abc' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('reports an error instead of loading forever', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn(hanging))
    const pending = fetchReport('abc')
    const result = expect(pending).rejects.toThrow('伺服器沒有回應')
    await vi.advanceTimersByTimeAsync(90_000)
    await result
  })

  it('retries a 504 from the Worker', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ error: 'FFLogs did not respond' }, { status: 504 }))
      .mockResolvedValueOnce(Response.json({ code: 'abc' }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(fetchReport('abc')).resolves.toEqual({ code: 'abc' })
  })

  it('keeps AbortError when the caller cancels', async () => {
    vi.stubGlobal('fetch', vi.fn(hanging))
    const controller = new AbortController()
    const pending = fetchReport('abc', controller.signal)
    controller.abort()
    await expect(pending).rejects.toThrow('aborted')
  })
})