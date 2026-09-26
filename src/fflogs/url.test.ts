import { describe, expect, it } from 'vitest'
import { parseReportUrl, reportUrl } from './url'

describe('reportUrl', () => {
  it('builds a link that parses back to the same fight and source', () => {
    const url = reportUrl('FXLkqaK32PhQH8Ac', 1, 6)
    expect(url).toBe('https://www.fflogs.com/reports/FXLkqaK32PhQH8Ac?fight=1&source=6')
    expect(parseReportUrl(url)).toEqual({ reportCode: 'FXLkqaK32PhQH8Ac', fight: 1, sourceId: 6 })
  })
})

describe('parseReportUrl', () => {
  it('parses report code, fight and source from the hash', () => {
    expect(
      parseReportUrl('https://www.fflogs.com/reports/AbCd1234EfGh5678#fight=5&type=damage-done&source=3'),
    ).toEqual({ reportCode: 'AbCd1234EfGh5678', fight: 5, sourceId: 3 })
  })

  it('accepts fight=last and query-string params', () => {
    expect(parseReportUrl('https://fflogs.com/reports/xyz123/?fight=last')).toEqual({
      reportCode: 'xyz123',
      fight: 'last',
    })
  })

  it('accepts regional subdomains and anonymized codes', () => {
    expect(parseReportUrl('https://tw.fflogs.com/reports/a:Q1w2E3')).toEqual({ reportCode: 'a:Q1w2E3' })
  })

  it('rejects non-report or non-fflogs URLs', () => {
    expect(parseReportUrl('https://www.fflogs.com/character/na/gilgamesh/foo')).toBeNull()
    expect(parseReportUrl('https://evil.example/reports/abc')).toBeNull()
    expect(parseReportUrl('not a url')).toBeNull()
  })
})
