import { jobName, jobRole } from '../jobs/names'

/** 職業繁中名稱徽章，依職能上色（坦克藍、治療綠、輸出紅）；角色選單與搜尋前輩日誌共用 */
export function JobBadge({ subType }: { subType: string }) {
  return <span className={`badge job ${jobRole(subType)}`}>{jobName(subType)}</span>
}
