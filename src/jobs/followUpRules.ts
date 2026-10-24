// 追擊：前一招之後一定要接的能力技（沒有冷卻，次數跟著前一招）。
// 技能 ID 以官方 XIVAPI 查證；接續率以繁中服 PR 95+ 擊殺驗證（各規則 93～100%，見 TECH_NOTES.md「追擊的資料驗證」）。

export interface FollowUpRule {
  key: string
  /** 前一招（任一個用了之後就要接一次追擊） */
  parents: number[]
  /** 追擊 */
  followUp: number[]
}

/** 前一招之後這麼久內（且在下一次前一招之前）接上才算有接 */
export const FOLLOW_UP_WITHIN_MS = 10_000

/** 以 FFLogs subType 為鍵 */
export const FOLLOW_UP_RULES: Record<string, FollowUpRule[]> = {
  Viper: [
    // 飛蛇之牙 → 飛蛇連尾擊、飛蛇亂尾擊
    { key: 'uncoiled-twinfang', parents: [34633], followUp: [34644] },
    { key: 'uncoiled-twinblood', parents: [34633], followUp: [34645] },
    // 獵手之蛇／疾速之蛇（Coil）→ 雙牙連擊、雙牙亂擊
    { key: 'coil-twinfang', parents: [34621, 34622], followUp: [34636] },
    { key: 'coil-twinblood', parents: [34621, 34622], followUp: [34637] },
    // 範圍版（Den）→ 雙牙連擊・範圍、雙牙亂擊・範圍
    { key: 'den-twinfang', parents: [34624, 34625], followUp: [34638] },
    { key: 'den-twinblood', parents: [34624, 34625], followUp: [34639] },
    // 第三段連擊 → 死亡響尾；範圍第三段 → 末尾鞭擊
    { key: 'death-rattle', parents: [34610, 34611, 34612, 34613], followUp: [34634] },
    { key: 'last-lash', parents: [34618, 34619], followUp: [34635] },
    // 祖靈降臨的四段 → 對應的祖靈追擊
    { key: 'first-legacy', parents: [34627], followUp: [34640] },
    { key: 'second-legacy', parents: [34628], followUp: [34641] },
    { key: 'third-legacy', parents: [34629], followUp: [34642] },
    { key: 'fourth-legacy', parents: [34630], followUp: [34643] },
  ],
  Gunbreaker: [
    // 續劍：烈牙 → 撕喉、猛獸爪 → 裂膛、兇禽爪 → 穿目；爆發擊 → 超高速；命運之環 → 命運之印
    { key: 'jugular-rip', parents: [16146], followUp: [16156] },
    { key: 'abdomen-tear', parents: [16147], followUp: [16157] },
    { key: 'eye-gouge', parents: [16150], followUp: [16158] },
    { key: 'hypervelocity', parents: [16162], followUp: [25759] },
    { key: 'fated-brand', parents: [16163], followUp: [36936] },
  ],
}

/** 所有職業的追擊技能 ID（不另提「少用」：漏接由追擊規則判斷） */
export const FOLLOW_UP_IDS: ReadonlySet<number> = new Set(Object.values(FOLLOW_UP_RULES).flatMap((rules) => rules.flatMap((r) => r.followUp)))
