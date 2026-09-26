import { GCD_IDS, JOB_CATEGORIES } from './generated'
import { jobName } from './names'

/** 職業專屬規則。 */
export interface JobModule {
  /** FFLogs actor 的 subType，例如 'Viper' */
  subType: string
  /** 繁中名稱 */
  name: string
  isGcd(abilityId: number): boolean
  /**
   * 技能分類（見 roleActions.ts 的 AbilityCategory；職能技能已內建，這裡只列職業專屬技能）：
   * ignored 不紀錄；mitigation 自身減傷、partyMitigation 團隊減傷、movement 移動為重要的學習課題；utility 其他輔助
   */
  ignored?: ReadonlySet<number>
  mitigation?: ReadonlySet<number>
  partyMitigation?: ReadonlySet<number>
  movement?: ReadonlySet<number>
  utility?: ReadonlySet<number>
}

/**
 * 所有職業的基本規則，由遊戲資料產生（generated.ts，見 scripts/gen-job-data.mjs）：
 * GCD 以公共冷卻群組判斷，減傷／移動等分類依技能名稱查表。
 * 之後各職業的詳細分析（類似 xivanalysis）可在 jobs/ 下另建檔案擴充這裡的基本模組。
 */
const JOBS: JobModule[] = Object.entries(JOB_CATEGORIES).map(([subType, categories]) => ({
  subType,
  name: jobName(subType),
  isGcd: (id) => GCD_IDS.has(id),
  ...categories,
}))

export function getJob(subType: string): JobModule | undefined {
  return JOBS.find((job) => job.subType === subType)
}

/** 已有規則的職業（FFLogs subType）。 */
export function supportedJobs(): string[] {
  return JOBS.map((job) => job.subType)
}
