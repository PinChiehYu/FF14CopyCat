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
  /** 防禦、減傷、輔助等依攻略使用的技能；次數與時機不同不代表輸出問題 */
  utility?: ReadonlySet<number>
}

const JOBS: JobModule[] = [viper, samurai, paladin]

export function getJob(subType: string): JobModule | undefined {
  return JOBS.find((job) => job.subType === subType)
}
