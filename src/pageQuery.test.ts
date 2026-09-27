import { describe, expect, it } from 'vitest'
import type { Selection } from './compare/load'
import { parseReportUrl } from './fflogs/url'
import { shareUrl } from './pageQuery'

const selection = (code: string, fight: number, player: number) =>
  ({ report: { code }, fight: { id: fight }, player: { id: player } }) as unknown as Selection

describe('shareUrl', () => {
  it('builds links for the current fights and players that parse back to the same selection', () => {
    const url = new URL(shareUrl(selection('AAA', 3, 16), selection('BBB', 11, 6), 'https://pinchiehyu.github.io/FF14CopyCat/'))
    expect(url.pathname).toBe('/FF14CopyCat/')
    expect(parseReportUrl(url.searchParams.get('mine')!)).toMatchObject({ reportCode: 'AAA', fight: 3, sourceId: 16 })
    expect(parseReportUrl(url.searchParams.get('ref')!)).toMatchObject({ reportCode: 'BBB', fight: 11, sourceId: 6 })
  })
})
