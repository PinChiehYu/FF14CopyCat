// 各職業的技能窗口規則，移植自 xivanalysis（MIT）dawntrail 分支的職業模組
// （src/parser/jobs/<job>/modules；source 欄位記錄對應的模組）。
// 技能與效果 ID 取自 xivanalysis 的資料表，並以遊戲資料（Action／Status 表）與實際日誌查證（見 TECH_NOTES.md）。
// 只移植能以「效果期間／技能後固定時間」＋「GCD 數、應使用、不應使用」表達的規則；
// 依量譜、MP、召喚獸階段或寵物施放判斷的模組（黑魔的循環檢查、召喚的召喚獸階段、暗黑騎士的影子〔寵物〕施放等）不移植。
import type { WindowRule } from './windows'

/** 效果 ID：FFLogs 以「遊戲狀態 ID＋1,000,000」表示 */
const status = (id: number) => 1_000_000 + id

// 爆發藥（強化藥）
const MEDICATED = status(49)

// 問題說明直接列出技能的官方繁中名稱，不另寫分組名稱
const each = (ids: number[], count = 1, extra: { openerCount?: number; onlyIf?: number[] } = {}) => ({
  ids,
  mode: 'each' as const,
  count,
  ...extra,
})
const total = (ids: number[], count: number, extra: { openerCount?: number } = {}) => ({
  ids,
  mode: 'total' as const,
  count,
  ...extra,
})

// ---- 坦克 ----

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
  EXPIACION: 25747,
  CIRCLE_OF_SCORN: 23,
  INTERVENE: 16461,
  CLEMENCY: 3541,
}

const WAR = {
  PRIMAL_REND: 25753,
  PRIMAL_RUINATION: 36925,
  PRIMAL_WRATH: 36924,
  ONSLAUGHT: 7386,
  UPHEAVAL: 7387,
  OROGENY: 25752,
  INNER_CHAOS: 16465,
  CHAOTIC_CYCLONE: 16463,
  FELL_CLEAVE: 3549,
  DECIMATE: 3550,
}

const DRK = {
  SCARLET_DELIRIUM: 36928,
  COMEUPPANCE: 36929,
  TORCLEAVER: 36930,
  IMPALEMENT: 36931,
  BLOODSPILLER: 7392,
  QUIETUS: 7391,
  SHADOWBRINGER: 25757,
  CARVE_AND_SPIT: 3643,
  ABYSSAL_DRAIN: 3641,
  DISESTEEM: 36932,
  EDGE_OF_SHADOW: 16470,
  FLOOD_OF_SHADOW: 16469,
}

const GNB = {
  GNASHING_FANG: 16146,
  SAVAGE_CLAW: 16147,
  WICKED_TALON: 16150,
  DOUBLE_DOWN: 25760,
  SONIC_BREAK: 16153,
  BLASTING_ZONE: 16165,
  BOW_SHOCK: 16159,
  LION_HEART: 36939,
  BLOODFEST: 16164,
}

// ---- 治療 ----

const WHM = { ASSIZE: 3571, DIA: 16532, GLARE_IV: 37009 }

const AST = { LORD_OF_CROWNS: 7444, ORACLE: 37029, COMBUST_III: 16554, DIVINATION: 16552 }

const SGE = {
  PNEUMA: 24318,
  DIAGNOSIS: 24284,
  EUKRASIAN_DIAGNOSIS: 24291,
  PROGNOSIS: 24286,
  EUKRASIAN_PROGNOSIS: 24292,
  EUKRASIAN_PROGNOSIS_II: 37034,
  PHLEGMA_III: 24313,
  EUKRASIAN_DOSIS_III: 24314,
  PSYCHE: 37033,
}

// ---- 近戰 ----

const MNK = {
  SIX_SIDED_STAR: 16476,
  STEELED_MEDITATION: 36940,
  FORBIDDEN_MEDITATION: 36942,
  ENLIGHTENED_MEDITATION: 36943,
  FORM_SHIFT: 4262,
}

const DRG = {
  HIGH_JUMP: 16478,
  MIRAGE_DIVE: 7399,
  DRAGONFIRE_DIVE: 96,
  RISE_OF_THE_DRAGON: 36953,
  GEIRSKOGUL: 3555,
  NASTROND: 7400,
  STARDIVER: 16480,
  STARCROSS: 36956,
}
// 不含龍炎衝、龍炎昇（兩分鐘冷卻，隔一次窗口才有）的輸出能力技
const DRG_OGCDS = [DRG.HIGH_JUMP, DRG.MIRAGE_DIVE, DRG.GEIRSKOGUL, DRG.NASTROND, DRG.STARDIVER, DRG.STARCROSS]

const NIN = {
  MUDRAS: [2259, 18805, 2261, 18806, 2263, 18807], // 天之印、地之印、人之印（各含兩種 ID）
  TEN_CHI_JIN: 7403,
  HYOSHO_RANRYU: 16492,
  GOKA_MEKKYAKU: 16491,
  RAITON: 2267,
  DREAM_WITHIN_A_DREAM: 3566,
  TENRI_JINDO: 36961,
  ARMOR_CRUSH: 3563,
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

const RPR = {
  REAPINGS: [24396, 24395, 24397], // 交錯收割、虛無收割、陰冷收割
  LEMURES: [24399, 24400], // 夜遊魂切割、夜遊魂收割
  SACRIFICIUM: 36969,
  PLENTIFUL_HARVEST: 24385,
  COMMUNIO: 24398,
}

const VPR = {
  REAWAKEN: 34626,
  GENERATIONS: [34627, 34628, 34629, 34630],
  LEGACIES: [34640, 34641, 34642, 34643],
  OUROBOROS: 34631,
  SERPENTS_IRE: 34647,
}

// ---- 遠程物理 ----

const BRD = {
  APEX_ARROW: 16496,
  BLAST_ARROW: 25784,
  RADIANT_ENCORE: 36977,
  RESONANT_ARROW: 36976,
  EMPYREAL_ARROW: 3558,
  SIDEWINDER: 3562,
  HEARTBREAK_SHOT: 36975,
  RAIN_OF_DEATH: 117,
  IRON_JAWS: 3560,
  BARRAGE: 107,
}

const MCH = { WILDFIRE: 2878, FULL_METAL_FIELD: 36982, BLAZING_SHOT: 36978 }

const DNC = {
  DANCE_MOVES: [16000, 15999, 16001, 16002], // 小鳥交疊跳、薔薇曲腳步、綠葉小踢腿、金冠趾尖轉
  TECHNICAL_FINISHES: [16004, 16193, 16194, 16195, 16196],
  DANCE_OF_THE_DAWN: 36985,
  FINISHING_MOVE: 36984,
  STARFALL_DANCE: 25792,
  TILLANA: 25790,
  LAST_DANCE: 36983,
  SABER_DANCE: 16005,
  FAN_DANCE_IV: 25791,
  FILLERS: [15989, 15991, 15990, 15993, 15995, 15994], // 瀑瀉、逆瀑瀉、噴泉、風車、升風車、落刃雨（填充技）
}

// ---- 魔法 ----

const SMN = { SEARING_FLASH: 36991 }

const RDM = {
  MELEE: [7527, 45960, 7528, 45961, 7529, 45962, 7530, 37002, 37003], // 魔回刺、魔交擊斬、魔連攻（各含魔元化版本）、魔劃圓斬一～三段
  FINISHERS: [7526, 7525, 16530, 25858], // 赤神聖、赤火光、焦熱、決斷
  RUSH_CASTS: [25856, 7511, 25855, 7510, 37006, 37004], // 窗口快結束時可用的詠唱：赤大勁風、赤巨岩、赤大雷電、赤火焰、顯貴衝擊、激盪
  OTHER: [16528, 7514, 16525, 16524], // 魔續斬、赤療傷、赤中勁風、赤中雷電
  IMPACT: 16526,
  VERRAISE: 7523,
}

const PCT = {
  HAMMERS: [34678, 34679, 34680], // 重錘敲章、重錘掠刷、重錘拋光
  STAR_PRISM: 34681,
  RAINBOW_DRIP: 34688,
  COMET_IN_BLACK: 34663,
  MOG_OR_MADEEN: [34676, 34677], // 莫古利激流、馬蒂恩懲罰
  ADDITIVES: [34650, 34651, 34652, 34656, 34657, 34658, 34662], // 火焰之紅、勁風之綠、水花之藍（含中級）、神聖之白
}

export const RULES: Record<string, WindowRule[]> = {
  Paladin: [
    {
      key: 'fight-or-flight',
      statusId: status(76), // 戰逃反應
      expectedGcds: 8,
      ignoredGcds: [PLD.CLEMENCY],
      expectedActions: [
        each([PLD.GORING_BLADE, PLD.CONFITEOR, PLD.BLADE_OF_FAITH, PLD.BLADE_OF_TRUTH, PLD.BLADE_OF_VALOR]),
        total([PLD.ROYAL_AUTHORITY, PLD.ATONEMENT, PLD.SUPPLICATION, PLD.SEPULCHRE, PLD.HOLY_SPIRIT], 3),
        each([PLD.BLADE_OF_HONOR, PLD.EXPIACION, PLD.CIRCLE_OF_SCORN, PLD.INTERVENE]),
      ],
      source: 'pld/FightOrFlight',
    },
    {
      key: 'requiescat',
      statusId: status(1368), // 安魂祈禱（Imperator #36921 也施加此效果）
      expectedActions: [
        each([PLD.CONFITEOR, PLD.BLADE_OF_FAITH, PLD.BLADE_OF_TRUTH, PLD.BLADE_OF_VALOR]),
      ],
      source: 'pld/Requiescat',
    },
    {
      key: 'tincture',
      statusId: MEDICATED,
      expectedGcds: 12,
      ignoredGcds: [PLD.CLEMENCY],
      expectedActions: [
        each([
          PLD.EXPIACION,
          PLD.CIRCLE_OF_SCORN,
          PLD.GORING_BLADE,
          PLD.CONFITEOR,
          PLD.BLADE_OF_FAITH,
          PLD.BLADE_OF_TRUTH,
          PLD.BLADE_OF_VALOR,
          PLD.HOLY_SPIRIT,
        ]),
      ],
      source: 'pld/Tincture',
    },
  ],
  Warrior: [
    {
      key: 'tincture',
      statusId: MEDICATED,
      expectedGcds: 12,
      expectedActions: [
        total([WAR.PRIMAL_REND], 1),
        total([WAR.PRIMAL_RUINATION], 1),
        total([WAR.PRIMAL_WRATH], 1),
        total([WAR.ONSLAUGHT], 3),
        total([WAR.UPHEAVAL, WAR.OROGENY], 1),
        total([WAR.INNER_CHAOS, WAR.CHAOTIC_CYCLONE], 2),
        total([WAR.FELL_CLEAVE, WAR.DECIMATE], 3),
      ],
      source: 'war/Tincture',
    },
  ],
  DarkKnight: [
    {
      key: 'delirium',
      statusId: status(3836), // 血亂
      // 3 個血亂強化 GCD：單體連擊或換成範圍的蔑視厭惡
      expectedActions: [
        total([DRK.SCARLET_DELIRIUM, DRK.COMEUPPANCE, DRK.TORCLEAVER, DRK.IMPALEMENT], 3),
      ],
      source: 'drk/Delirium',
    },
    {
      key: 'tincture',
      statusId: MEDICATED,
      expectedActions: [
        total([DRK.SCARLET_DELIRIUM, DRK.COMEUPPANCE, DRK.TORCLEAVER, DRK.IMPALEMENT], 3),
        total([DRK.BLOODSPILLER, DRK.QUIETUS], 2, { openerCount: 1 }),
        total([DRK.SHADOWBRINGER], 2),
        total([DRK.CARVE_AND_SPIT, DRK.ABYSSAL_DRAIN], 1),
        total([DRK.DISESTEEM], 1),
        total([DRK.EDGE_OF_SHADOW, DRK.FLOOD_OF_SHADOW], 5),
      ],
      source: 'drk/Tincture',
    },
  ],
  Gunbreaker: [
    {
      key: 'no-mercy',
      statusId: status(1831), // 無情
      expectedGcds: 9,
      expectedActions: [
        each([GNB.SAVAGE_CLAW, GNB.WICKED_TALON, GNB.DOUBLE_DOWN, GNB.SONIC_BREAK, GNB.BLASTING_ZONE, GNB.BOW_SHOCK]),
        // 7.4 以前：窗口內用了血壤才要求終結之心（基準日誌為 7.4 以前的版本）
        each([GNB.LION_HEART], 1, { onlyIf: [GNB.BLOODFEST] }),
      ],
      source: 'gnb/NoMercy',
    },
    {
      key: 'tincture',
      statusId: MEDICATED,
      expectedActions: [
        each([GNB.SONIC_BREAK, GNB.DOUBLE_DOWN, GNB.LION_HEART, GNB.BOW_SHOCK, GNB.BLASTING_ZONE]),
        each([GNB.GNASHING_FANG], 2),
      ],
      source: 'gnb/Tincture',
    },
  ],
  WhiteMage: [
    {
      key: 'tincture',
      statusId: MEDICATED,
      expectedActions: [
        each([WHM.ASSIZE]),
        each([WHM.DIA], 1, { openerCount: 2 }),
        each([WHM.GLARE_IV], 3),
      ],
      source: 'whm/Tincture',
    },
  ],
  Astrologian: [
    {
      key: 'divination',
      statusId: status(1878), // 占卜
      expectedGcds: 8,
      // xivanalysis 的這條規則只在表格顯示、不產生建議；焚灼常在占卜前補上，實測高手也常「缺少」，不列入
      expectedActions: [each([AST.LORD_OF_CROWNS, AST.ORACLE])],
      source: 'ast/Divination',
    },
    {
      key: 'tincture',
      statusId: MEDICATED,
      expectedActions: [each([AST.COMBUST_III, AST.DIVINATION, AST.ORACLE, AST.LORD_OF_CROWNS])],
      source: 'ast/Tincture',
    },
  ],
  Sage: [
    {
      key: 'zoe',
      statusId: status(2611), // 活化
      expectedGcds: 1,
      stacks: true,
      // 只看治療 GCD：活化應用在治療 GCD 上
      trackedGcds: [
        SGE.PNEUMA,
        SGE.DIAGNOSIS,
        SGE.EUKRASIAN_DIAGNOSIS,
        SGE.PROGNOSIS,
        SGE.EUKRASIAN_PROGNOSIS,
        SGE.EUKRASIAN_PROGNOSIS_II,
      ],
      source: 'sge/Zoe',
    },
    {
      key: 'tincture',
      statusId: MEDICATED,
      expectedActions: [
        each([SGE.PHLEGMA_III], 2),
        each([SGE.EUKRASIAN_DOSIS_III, SGE.PSYCHE]),
      ],
      source: 'sge/Tincture',
    },
  ],
  Monk: [
    {
      key: 'riddle-of-fire',
      statusId: status(1181), // 紅蓮極意
      expectedGcds: 11,
      gcdAdjust: { ids: [MNK.SIX_SIDED_STAR], perUse: -1 }, // 六合星導腳算兩個 GCD
      limitedActions: [
        {
          ids: [MNK.STEELED_MEDITATION, MNK.FORBIDDEN_MEDITATION, MNK.ENLIGHTENED_MEDITATION, MNK.FORM_SHIFT],
        },
      ],
      source: 'mnk/RiddleOfFire',
    },
    {
      key: 'brotherhood',
      statusId: status(1185), // 義結金蘭
      expectedGcds: 10,
      gcdAdjust: { ids: [MNK.SIX_SIDED_STAR], perUse: -1 },
      source: 'mnk/Brotherhood',
    },
  ],
  Dragoon: [
    {
      key: 'battle-litany',
      statusId: status(786), // 戰鬥連禱
      expectedGcds: 8,
      expectedActions: [each([...DRG_OGCDS, DRG.DRAGONFIRE_DIVE, DRG.RISE_OF_THE_DRAGON])],
      source: 'drg/BattleLitany',
    },
    {
      key: 'lance-charge',
      statusId: status(1864), // 猛槍
      expectedGcds: 8,
      expectedActions: [each(DRG_OGCDS)],
      source: 'drg/LanceCharge',
    },
    {
      key: 'life-of-the-dragon',
      action: { id: DRG.GEIRSKOGUL, durationMs: 20_000 }, // 武神槍後 20 秒（xivanalysis 的 Life of the Dragon）
      expectedGcds: 8,
      expectedActions: [each(DRG_OGCDS)],
      source: 'drg/BloodOfTheDragon',
    },
  ],
  Ninja: [
    {
      key: 'kunais-bane',
      statusId: status(3906), // 百雷銃（施加在敵人身上）
      expectedGcds: 7,
      ignoredGcds: NIN.MUDRAS,
      gcdAdjust: { ids: [NIN.TEN_CHI_JIN], perUse: 1 },
      openerMs: 12_000,
      expectedActions: [
        total([NIN.HYOSHO_RANRYU, NIN.GOKA_MEKKYAKU], 1),
        each([NIN.RAITON], 2, { openerCount: 1 }),
        each([NIN.DREAM_WITHIN_A_DREAM]),
        each([NIN.TENRI_JINDO], 1, { onlyIf: [NIN.TEN_CHI_JIN] }),
      ],
      limitedActions: [{ ids: [NIN.ARMOR_CRUSH], openerAllowed: 1 }],
      source: 'nin/KunaisBaneWindow',
    },
  ],
  Samurai: [
    {
      key: 'meikyo',
      statusId: status(1233), // 明鏡止水
      expectedGcds: 3,
      stacks: true,
      // 只看連擊技：居合術、燕返、奧義斬浪不消耗明鏡止水
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
  Reaper: [
    {
      key: 'arcane-circle',
      statusId: status(2599), // 神秘環
      openerMs: 15_000,
      expectedActions: [
        total(RPR.REAPINGS, 7, { openerCount: 4 }),
        total(RPR.LEMURES, 4, { openerCount: 2 }),
        total([RPR.SACRIFICIUM], 2, { openerCount: 1 }),
        total([RPR.PLENTIFUL_HARVEST], 1),
        total([RPR.COMMUNIO], 2, { openerCount: 1 }),
      ],
      source: 'rpr/ArcaneCircle',
    },
    {
      key: 'enshroud',
      statusId: status(2593), // 夜遊魂
      stacks: true,
      expectedActions: [
        total(RPR.REAPINGS, 4),
        total(RPR.LEMURES, 2),
        total([RPR.SACRIFICIUM], 1),
        total([RPR.COMMUNIO], 1),
      ],
      source: 'rpr/Enshroud',
    },
    {
      key: 'tincture',
      statusId: MEDICATED,
      openerMs: 15_000,
      expectedActions: [each([RPR.COMMUNIO], 2, { openerCount: 1 })],
      source: 'rpr/Tincture',
    },
  ],
  Viper: [
    {
      key: 'reawaken',
      statusId: status(3670), // 祖靈降臨
      stacks: true,
      expectedActions: [
        total(VPR.GENERATIONS, 4),
        total(VPR.LEGACIES, 4),
        total([VPR.OUROBOROS], 1),
      ],
      source: 'vpr/Reawaken',
    },
    {
      key: 'serpents-ire',
      action: { id: VPR.SERPENTS_IRE, durationMs: 30_000 },
      openerMs: 30_000,
      expectedActions: [each([VPR.REAWAKEN, VPR.OUROBOROS], 2, { openerCount: 1 })],
      source: 'vpr/SerpentsIre',
    },
    {
      key: 'tincture',
      statusId: MEDICATED,
      openerMs: 30_000,
      expectedActions: [each([VPR.REAWAKEN, VPR.OUROBOROS], 2, { openerCount: 1 })],
      source: 'vpr/Tincture',
    },
  ],
  Bard: [
    {
      key: 'burst',
      allOf: [status(125), status(141), status(2964)], // 猛者強擊、戰鬥之聲、光明神的最終樂章同時存在
      expectedGcds: 7,
      stacks: true, // xivanalysis 的 RequiredGcdCount：不依窗口長度封頂
      openerMs: 60_000,
      expectedActions: [
        each([BRD.APEX_ARROW, BRD.BLAST_ARROW], 1, { openerCount: 0 }),
        each([BRD.RADIANT_ENCORE, BRD.RESONANT_ARROW, BRD.EMPYREAL_ARROW, BRD.SIDEWINDER, BRD.IRON_JAWS, BRD.BARRAGE]),
        total([BRD.HEARTBREAK_SHOT, BRD.RAIN_OF_DEATH], 3),
      ],
      source: 'brd/BurstWindow',
    },
  ],
  Machinist: [
    {
      key: 'tincture',
      statusId: MEDICATED,
      expectedActions: [
        each([MCH.WILDFIRE, MCH.FULL_METAL_FIELD]),
        each([MCH.BLAZING_SHOT], 10, { openerCount: 5 }),
      ],
      source: 'mch/Tincture',
    },
  ],
  Dancer: [
    {
      key: 'technical-finish',
      statusId: status(1822), // 技巧舞步結束
      expectedGcds: 8,
      ignoredGcds: [...DNC.DANCE_MOVES, ...DNC.TECHNICAL_FINISHES],
      expectedActions: [
        each([DNC.DANCE_OF_THE_DAWN, DNC.FINISHING_MOVE, DNC.STARFALL_DANCE, DNC.TILLANA, DNC.FAN_DANCE_IV]),
        // xivanalysis 為 4 次、窗口內沒用填充技時減為 3；這裡取寬鬆的 3 次
        total([DNC.LAST_DANCE, DNC.SABER_DANCE], 3),
      ],
      limitedActions: [{ ids: DNC.FILLERS }],
      source: 'dnc/Technicalities',
    },
  ],
  Summoner: [
    {
      key: 'searing-light',
      statusId: status(2703), // 灼熱之光
      expectedActions: [each([SMN.SEARING_FLASH])],
      source: 'smn/SearingLight',
    },
  ],
  RedMage: [
    {
      key: 'manafication',
      statusId: status(1971), // 魔元化
      expectedGcds: 6,
      stacks: true,
      trackedGcds: [...RDM.MELEE, ...RDM.FINISHERS, ...RDM.RUSH_CASTS, ...RDM.OTHER, RDM.IMPACT, RDM.VERRAISE],
      allowedGcds: [...RDM.MELEE, ...RDM.FINISHERS, ...RDM.RUSH_CASTS, ...RDM.OTHER],
      source: 'rdm/Manafication',
    },
  ],
  Pictomancer: [
    {
      key: 'starry-muse',
      statusId: status(3685), // 星空構想
      expectedActions: [
        total(PCT.HAMMERS, 3),
        each([PCT.STAR_PRISM, PCT.RAINBOW_DRIP, PCT.COMET_IN_BLACK]),
        total(PCT.MOG_OR_MADEEN, 1),
      ],
      limitedActions: [{ ids: PCT.ADDITIVES }],
      source: 'pct/StarryMuse',
    },
  ],
}
