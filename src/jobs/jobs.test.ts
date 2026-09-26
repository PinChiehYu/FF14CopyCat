import { describe, expect, it } from 'vitest'
import { getJob, supportedJobs } from './index'
import { abilityCategory } from './roleActions'

const job = (subType: string) => {
  const module = getJob(subType)
  if (!module) throw new Error(`no module for ${subType}`)
  return module
}

describe('job modules', () => {
  it('covers every combat job with its Traditional Chinese name', () => {
    expect(supportedJobs()).toHaveLength(21)
    expect(job('BlackMage').name).toBe('黑魔道士')
    expect(job('Viper').name).toBe('毒蛇劍士')
    expect(job('DarkKnight').name).toBe('暗黑騎士')
    expect(getJob('LimitBreak')).toBeUndefined()
  })

  // 以下 ID 皆以實際日誌的 GCD 間隔驗證過（見 docs/TECH_NOTES.md）
  it.each([
    ['Samurai', [36963, 7478, 7479, 7480, 7481, 7482, 7487, 7489, 16486, 25781, 25782, 36966, 36968]],
    ['Paladin', [9, 15, 3539, 16460, 36918, 36919, 7384, 16459, 25748, 25749, 25750, 3538]],
    ['BlackMage', [152, 154, 3576, 3577, 16505, 16506, 16507, 25797, 36986, 36989]],
    ['Viper', [34606, 34620, 34626, 34633]],
  ])('%s GCDs', (subType, ids) => {
    for (const id of ids) expect(job(subType).isGcd(id), String(id)).toBe(true)
  })

  it.each([
    ['Samurai', [7490, 7492, 7495, 7499, 16481, 16482, 16487, 36962, 36964, 7546, 34600427]],
    ['Paladin', [20, 23, 25747, 16461, 36921, 36922, 25746, 36920, 34600427]],
    ['BlackMage', [149, 157, 158, 3573, 7421, 25796, 36988, 7561, 34600430]],
    ['Viper', [34634, 34647, 34646]],
  ])('%s oGCDs', (subType, ids) => {
    for (const id of ids) expect(job(subType).isGcd(id), String(id)).toBe(false)
  })

  it('treats abilities that trigger the GCD as GCDs', () => {
    // Meditate 是 60 秒冷卻的能力，但同時觸發公共冷卻（AdditionalCooldownGroup 58）
    expect(job('Samurai').isGcd(7497)).toBe(true)
  })
})

describe('abilityCategory', () => {
  it('ignores tank provoke, shirk and stance toggles', () => {
    for (const id of [7533, 7537, 28, 32065, 48, 32066, 3629, 32067, 16142, 32068]) {
      expect(abilityCategory(id, job('Paladin')), String(id)).toBe('ignored')
    }
    expect(abilityCategory(38, job('Paladin'))).toBe('normal') // Berserk（戰士）
  })

  it('classifies role actions for any job', () => {
    expect(abilityCategory(7531, job('Warrior'))).toBe('mitigation') // Rampart
    expect(abilityCategory(7549, job('Monk'))).toBe('partyMitigation') // Feint
    expect(abilityCategory(3, job('Sage'))).toBe('movement') // Sprint
    expect(abilityCategory(7546, job('Samurai'))).toBe('utility') // True North
    expect(abilityCategory(7531)).toBe('mitigation') // 沒有職業模組時也適用
  })

  it('classifies job mitigation and movement from generated data', () => {
    expect(abilityCategory(36920, job('Paladin'))).toBe('mitigation') // Guardian
    expect(abilityCategory(7385, job('Paladin'))).toBe('partyMitigation') // Passage of Arms
    expect(abilityCategory(188, job('Scholar'))).toBe('partyMitigation') // Sacred Soil
    expect(abilityCategory(3541, job('Paladin'))).toBe('utility') // Clemency
    expect(abilityCategory(36962, job('Samurai'))).toBe('mitigation') // Tengentsu
    // 暗影步：日誌記錄的是沒有職業歸屬的變體 38512，同樣是移動（只位移、不帶傷害）
    expect(abilityCategory(36926, job('DarkKnight'))).toBe('movement')
    expect(abilityCategory(38512, job('DarkKnight'))).toBe('movement')
    expect(abilityCategory(157, job('BlackMage'))).toBe('mitigation') // Manaward
    expect(abilityCategory(36988, job('BlackMage'))).toBe('movement') // Retrace
    expect(abilityCategory(34646, job('Viper'))).toBe('movement') // Slither
    expect(abilityCategory(3573, job('BlackMage'))).toBe('normal') // Ley Lines 是輸出技能
  })
})
