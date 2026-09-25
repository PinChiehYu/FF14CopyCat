import { blackMage } from './blackMage'
import { paladin } from './paladin'
import { samurai } from './samurai'
import { viper } from './viper'

/** 職業專屬規則。新增職業時在 jobs/ 下建檔並加入 JOBS。 */
export interface JobModule {
  /** FFLogs actor 的 subType，例如 'Viper' */
  subType: string
  /** 中文名稱 */
  name: string
  isGcd(abilityId: number): boolean
  /**
   * 技能分類（見 roleActions.ts 的 AbilityCategory；職能技能已內建，這裡只列職業專屬技能）：
   * ignored 不紀錄；mitigation 減傷、movement 移動為重要的學習課題；utility 其他輔助技能
   */
  ignored?: ReadonlySet<number>
  mitigation?: ReadonlySet<number>
  movement?: ReadonlySet<number>
  utility?: ReadonlySet<number>
}

const JOBS: JobModule[] = [viper, samurai, paladin, blackMage]

export function getJob(subType: string): JobModule | undefined {
  return JOBS.find((job) => job.subType === subType)
}
