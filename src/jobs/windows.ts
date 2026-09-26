// 技能窗口規則：某個效果（Buff）期間應該做到的事，參考 xivanalysis（MIT）的職業模組
// （src/parser/jobs/<job>/modules，dawntrail 分支）。技能與狀態 ID 已用遊戲資料查證（見 TECH_NOTES.md）。

/** 效果 ID：FFLogs 以「遊戲狀態 ID＋1,000,000」表示 */
const status = (id: number) => 1_000_000 + id

export interface ExpectedActions {
  /** 顯示用分組名稱（例如「高威力 GCD」） */
  label: string
  ids: number[]
  /** each：每個技能各要用 count 次；total：這組技能合計要用 count 次 */
  mode: 'each' | 'total'
  count: number
}

export interface WindowRule {
  key: string
  /** 觸發窗口的效果 ID */
  statusId: number
  /** 窗口內應打的 GCD 數 */
  expectedGcds?: number
  /**
   * 只計算這些 GCD（GCD 數與 allowedGcds 都只看這些）；例如明鏡止水只影響武士的連擊技，
   * 居合術、燕返、奧義斬浪不消耗明鏡止水，不列入判斷
   */
  trackedGcds?: number[]
  /** 窗口內只能使用這些 GCD */
  allowedGcds?: number[]
  /** 窗口內應使用的技能 */
  expectedActions?: ExpectedActions[]
  /** 不計入 GCD 數的技能（例如騎士的深仁厚澤是治療） */
  ignoredGcds?: number[]
  /** 規則出處（xivanalysis 模組） */
  source: string
}

const SAM = {
  HAKAZE: 7477,
  GYOFU: 36963,
  JINPU: 7478,
  SHIFU: 7479,
  FUKO: 25780,
  GEKKO: 7481,
  KASHA: 7482,
  YUKIKAZE: 7480,
  MANGETSU: 7484,
  OKA: 7485,
}

const PLD = {
  GORING_BLADE: 3538,
  CONFITEOR: 16459,
  BLADE_OF_FAITH: 25748,
  BLADE_OF_TRUTH: 25749,
  BLADE_OF_VALOR: 25750,
  ROYAL_AUTHORITY: 3539,
  ATONEMENT: 16460,
  SUPPLICATION: 36918,
  SEPULCHRE: 36919,
  HOLY_SPIRIT: 7384,
  BLADE_OF_HONOR: 36922,
  EXPIATION: 25747,
  CIRCLE_OF_SCORN: 23,
  INTERVENE: 16461,
  CLEMENCY: 3541,
}

const RULES: Record<string, WindowRule[]> = {
  Samurai: [
    {
      key: 'meikyo',
      statusId: status(1233), // 明鏡止水
      expectedGcds: 3,
      trackedGcds: [
        SAM.HAKAZE,
        SAM.GYOFU,
        SAM.JINPU,
        SAM.SHIFU,
        SAM.FUKO,
        SAM.GEKKO,
        SAM.KASHA,
        SAM.YUKIKAZE,
        SAM.MANGETSU,
        SAM.OKA,
      ],
      allowedGcds: [SAM.GEKKO, SAM.KASHA, SAM.YUKIKAZE, SAM.MANGETSU, SAM.OKA],
      source: 'sam/Meikyo',
    },
  ],
  Paladin: [
    {
      key: 'fight-or-flight',
      statusId: status(76), // 戰逃反應
      expectedGcds: 8,
      ignoredGcds: [PLD.CLEMENCY],
      expectedActions: [
        {
          label: '高威力 GCD',
          ids: [PLD.GORING_BLADE, PLD.CONFITEOR, PLD.BLADE_OF_FAITH, PLD.BLADE_OF_TRUTH, PLD.BLADE_OF_VALOR],
          mode: 'each',
          count: 1,
        },
        {
          label: '其他 GCD',
          ids: [PLD.ROYAL_AUTHORITY, PLD.ATONEMENT, PLD.SUPPLICATION, PLD.SEPULCHRE, PLD.HOLY_SPIRIT],
          mode: 'total',
          count: 3,
        },
        {
          label: '能力技',
          ids: [PLD.BLADE_OF_HONOR, PLD.EXPIATION, PLD.CIRCLE_OF_SCORN, PLD.INTERVENE],
          mode: 'each',
          count: 1,
        },
      ],
      source: 'pld/FightOrFlight',
    },
    {
      key: 'requiescat',
      statusId: status(1368), // 安魂祈禱（Imperator #36921 也施加此效果）
      expectedActions: [
        {
          label: '安魂祈禱連擊',
          ids: [PLD.CONFITEOR, PLD.BLADE_OF_FAITH, PLD.BLADE_OF_TRUTH, PLD.BLADE_OF_VALOR],
          mode: 'each',
          count: 1,
        },
      ],
      source: 'pld/Requiescat',
    },
  ],
}

/** 職業的技能窗口規則；還沒有規則的職業回傳空陣列。 */
export function windowRules(subType: string): WindowRule[] {
  return RULES[subType] ?? []
}
