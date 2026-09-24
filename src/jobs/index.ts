import { viper } from './viper'

/** 職業專屬規則。新增職業時在 jobs/ 下建檔並加入 JOBS。 */
export interface JobModule {
  /** FFLogs actor 的 subType，例如 'Viper' */
  subType: string
  /** 中文名稱 */
  name: string
  isGcd(abilityId: number): boolean
}

const JOBS: JobModule[] = [viper]

export function getJob(subType: string): JobModule | undefined {
  return JOBS.find((job) => job.subType === subType)
}
