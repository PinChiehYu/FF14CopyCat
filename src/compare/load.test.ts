import { describe, expect, it } from 'vitest'
import type { Actor, Fight, Report } from '../fflogs/types'
import { incompatibility, type Selection } from './load'

function selection(encounterID: number, subType: string): Selection {
  const fight = { id: 1, name: `Boss ${encounterID}`, encounterID } as Fight
  const player = { id: 1, name: 'p', subType } as Actor
  return { report: {} as Report, fight, player }
}

describe('incompatibility', () => {
  it('accepts same encounter and job', () => {
    expect(incompatibility(selection(98, 'Viper'), selection(98, 'Viper'))).toBeNull()
  })

  it('rejects different encounters or jobs', () => {
    expect(incompatibility(selection(98, 'Viper'), selection(99, 'Viper'))).toMatch('Boss')
    expect(incompatibility(selection(98, 'Viper'), selection(98, 'Samurai'))).toMatch('職業')
  })
})
