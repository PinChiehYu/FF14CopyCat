// 冷卻技是否好了就用：每個職業要追蹤的冷卻技，移植自 xivanalysis（MIT）dawntrail 分支各職業的 CooldownDowntime 模組（commit b240252）。
// 技能 ID、冷卻時間與充能次數取自 xivanalysis 的 src/data/ACTIONS（root＋版本層）。
// 有充能（charges > 1）的技能，xivanalysis 核心會忽略 allowedDowntimeMs（視為 0，以累積充能的時間當作容許延遲）；此處仍照原值記錄。
export interface CooldownGroup {
  /** 同一職業內唯一；不同版本的同一技能組用相同 key、以 patches 區分 */
  key: string
  /** 共用冷卻的技能（例如不同等級的升級版、共用充能的技能） */
  ids: number[]
  cooldownMs: number
  /** 最大充能次數（沒有充能為 1） */
  charges: number
  /** 開場預期第一次使用的時間（毫秒）；負值代表開打前使用 */
  firstUseOffsetMs?: number
  /** 冷卻好後可以延遲不算浪費的時間（毫秒）；有充能的技能 xivanalysis 視為 0 */
  allowedDowntimeMs: number
  /** 使用這些技能會縮短冷卻 refundMs 毫秒 */
  resetBy?: { ids: number[]; refundMs: number }
  /** 只在建議中提（xivanalysis 的 suggestionOnlyCooldowns），不列入 checklist */
  suggestionOnly?: boolean
  /** 適用的國際服版本範圍（from 含、before 不含），用在冷卻時間或充能因版本而異時 */
  patches?: { from?: string; before?: string }
  /** xivanalysis 模組，例如 'pld/CooldownDowntime' */
  source: string
}

/** 以 FFLogs subType（Paladin、Warrior、DarkKnight、Gunbreaker、WhiteMage、Scholar、Astrologian、Sage、Monk、Dragoon、Ninja、Samurai、Reaper、Viper、Bard、Machinist、Dancer、BlackMage、Summoner、RedMage、Pictomancer）為鍵 */
export const COOLDOWN_RULES: Record<string, CooldownGroup[]> = {
  Paladin: [
    { key: 'fight-or-flight', ids: [20], cooldownMs: 60000, charges: 1, firstUseOffsetMs: 7500, allowedDowntimeMs: 1250, source: 'pld/CooldownDowntime' },
    { key: 'imperator', ids: [36921], cooldownMs: 60000, charges: 1, firstUseOffsetMs: 7500, allowedDowntimeMs: 1250, source: 'pld/CooldownDowntime' },
    { key: 'expiacion', ids: [25747], cooldownMs: 30000, charges: 1, firstUseOffsetMs: 10000, allowedDowntimeMs: 1250, source: 'pld/CooldownDowntime' },
    { key: 'circle-of-scorn', ids: [23], cooldownMs: 30000, charges: 1, firstUseOffsetMs: 10000, allowedDowntimeMs: 1250, source: 'pld/CooldownDowntime' },
    { key: 'intervene', ids: [16461], cooldownMs: 30000, charges: 2, firstUseOffsetMs: 12500, allowedDowntimeMs: 1250, source: 'pld/CooldownDowntime' },
  ],

  Warrior: [
    {
      key: 'infuriate', ids: [52], cooldownMs: 60000, charges: 2, firstUseOffsetMs: 2500, allowedDowntimeMs: 1250,
      // Fell Cleave、Decimate、Chaotic Cyclone、Inner Chaos 各縮短 5 秒
      resetBy: { ids: [3549, 3550, 16463, 16465], refundMs: 5000 },
      source: 'war/OGCDDowntime',
    },
    { key: 'inner-release', ids: [7389], cooldownMs: 60000, charges: 1, firstUseOffsetMs: 15000, allowedDowntimeMs: 2500, source: 'war/OGCDDowntime' },
    { key: 'upheaval', ids: [7387, 25752], cooldownMs: 30000, charges: 1, firstUseOffsetMs: 12500, allowedDowntimeMs: 1250, source: 'war/OGCDDowntime' },
    { key: 'onslaught', ids: [7386], cooldownMs: 30000, charges: 3, firstUseOffsetMs: 18500, allowedDowntimeMs: 1250, source: 'war/OGCDDowntime' },
  ],

  DarkKnight: [
    { key: 'delirium', ids: [7390], cooldownMs: 60000, charges: 1, firstUseOffsetMs: 10000, allowedDowntimeMs: 1250, source: 'drk/OGCDDowntime' },
    { key: 'salted-earth', ids: [3639], cooldownMs: 90000, charges: 1, firstUseOffsetMs: 12500, allowedDowntimeMs: 1250, source: 'drk/OGCDDowntime' },
    { key: 'carve-and-spit', ids: [3643, 3641], cooldownMs: 60000, charges: 1, firstUseOffsetMs: 17500, allowedDowntimeMs: 1250, source: 'drk/OGCDDowntime' },
    { key: 'shadowbringer', ids: [25757], cooldownMs: 60000, charges: 2, firstUseOffsetMs: 20000, allowedDowntimeMs: 1250, source: 'drk/OGCDDowntime' },
    // 注意：xivanalysis 以 Scorn 效果的施加次數計算使用次數（可抓到開打前的 Living Shadow，FFLogs 不記錄開打前的施放），取兩者較大值；此處未重現
    { key: 'living-shadow', ids: [16472], cooldownMs: 120000, charges: 1, firstUseOffsetMs: 5000, allowedDowntimeMs: 1250, source: 'drk/OGCDDowntime' },
  ],

  Gunbreaker: [
    // 7.4 起 Gnashing Fang 變為 2 次充能
    { key: 'gnashing-fang', ids: [16146], cooldownMs: 30000, charges: 1, firstUseOffsetMs: 12500, allowedDowntimeMs: 1250, patches: { before: '7.4' }, source: 'gnb/Cooldowns' },
    { key: 'gnashing-fang', ids: [16146], cooldownMs: 30000, charges: 2, firstUseOffsetMs: 12500, allowedDowntimeMs: 1250, patches: { from: '7.4' }, source: 'gnb/Cooldowns' },
    { key: 'blasting-zone', ids: [16165, 16144], cooldownMs: 30000, charges: 1, firstUseOffsetMs: 12500, allowedDowntimeMs: 1250, source: 'gnb/Cooldowns' },
    { key: 'no-mercy', ids: [16138], cooldownMs: 60000, charges: 1, firstUseOffsetMs: 5000, allowedDowntimeMs: 1250, source: 'gnb/Cooldowns' },
    // 注意：xivanalysis 原始碼把 firstUseOffset 拼成 firseUseOffset（12500 未生效），實際以 0 計算；此處照實際行為不設
    { key: 'sonic-break', ids: [16153], cooldownMs: 60000, charges: 1, allowedDowntimeMs: 1250, source: 'gnb/Cooldowns' },
    { key: 'bow-shock', ids: [16159], cooldownMs: 60000, charges: 1, firstUseOffsetMs: 10000, allowedDowntimeMs: 1250, source: 'gnb/Cooldowns' },
    { key: 'double-down', ids: [25760], cooldownMs: 60000, charges: 1, firstUseOffsetMs: 10000, allowedDowntimeMs: 1250, source: 'gnb/Cooldowns' },
    // 7.4 起冷卻 60 秒且應好了就用（容許延遲 0）；之前可延後 10 秒對齊 No Mercy
    { key: 'bloodfest', ids: [16164], cooldownMs: 120000, charges: 1, firstUseOffsetMs: 2500, allowedDowntimeMs: 10000, patches: { before: '7.4' }, source: 'gnb/Cooldowns' },
    { key: 'bloodfest', ids: [16164], cooldownMs: 60000, charges: 1, firstUseOffsetMs: 2500, allowedDowntimeMs: 0, patches: { from: '7.4' }, source: 'gnb/Cooldowns' },
  ],

  WhiteMage: [
    { key: 'assize', ids: [3571], cooldownMs: 40000, charges: 1, allowedDowntimeMs: 1250, source: 'whm/oGCDs' },
    { key: 'presence-of-mind', ids: [136], cooldownMs: 120000, charges: 1, allowedDowntimeMs: 1250, source: 'whm/oGCDs' },
    // 注意：以下只用於建議，xivanalysis 依少用次數分級（Divine Benison 少 8／12 次，其他少 2／3 次）
    { key: 'liturgy-of-the-bell', ids: [25862], cooldownMs: 180000, charges: 1, allowedDowntimeMs: 1250, suggestionOnly: true, source: 'whm/oGCDs' },
    { key: 'asylum', ids: [3569], cooldownMs: 90000, charges: 1, allowedDowntimeMs: 1250, suggestionOnly: true, source: 'whm/oGCDs' },
    { key: 'aquaveil', ids: [25861], cooldownMs: 60000, charges: 1, allowedDowntimeMs: 1250, suggestionOnly: true, source: 'whm/oGCDs' },
    { key: 'divine-benison', ids: [7432], cooldownMs: 30000, charges: 2, allowedDowntimeMs: 1250, suggestionOnly: true, source: 'whm/oGCDs' },
    { key: 'temperance', ids: [16536], cooldownMs: 120000, charges: 1, allowedDowntimeMs: 1250, suggestionOnly: true, source: 'whm/oGCDs' },
  ],

  Scholar: [
    { key: 'chain-stratagem', ids: [7436], cooldownMs: 120000, charges: 1, firstUseOffsetMs: 10000, allowedDowntimeMs: 1250, source: 'sch/CooldownDowntime' },
    { key: 'aetherflow', ids: [166], cooldownMs: 60000, charges: 1, firstUseOffsetMs: 7500, allowedDowntimeMs: 1250, source: 'sch/CooldownDowntime' },
  ],

  Astrologian: [
    { key: 'divination', ids: [16552], cooldownMs: 120000, charges: 1, allowedDowntimeMs: 2500, source: 'ast/oGCDs' },
    // 注意：Oracle 本身冷卻 1 秒，由 Divination 觸發；xivanalysis 把冷卻改成 Divination 的冷卻來追蹤
    { key: 'oracle', ids: [37029], cooldownMs: 120000, charges: 1, allowedDowntimeMs: 2500, source: 'ast/oGCDs' },
  ],

  Sage: [
    { key: 'phlegma-iii', ids: [24313], cooldownMs: 40000, charges: 2, allowedDowntimeMs: 1250, source: 'sge/CooldownDowntime' },
    { key: 'psyche', ids: [37033], cooldownMs: 60000, charges: 1, allowedDowntimeMs: 1250, source: 'sge/CooldownDowntime' },
  ],

  Monk: [
    { key: 'brotherhood', ids: [7396], cooldownMs: 120000, charges: 1, firstUseOffsetMs: 7000, allowedDowntimeMs: 2425, source: 'mnk/CooldownDowntime' },
    { key: 'perfect-balance', ids: [69], cooldownMs: 40000, charges: 2, firstUseOffsetMs: 3000, allowedDowntimeMs: 2425, source: 'mnk/CooldownDowntime' },
    { key: 'riddle-of-fire', ids: [7395], cooldownMs: 60000, charges: 1, firstUseOffsetMs: 5000, allowedDowntimeMs: 2425, source: 'mnk/CooldownDowntime' },
    { key: 'riddle-of-wind', ids: [25766], cooldownMs: 90000, charges: 1, firstUseOffsetMs: 10000, allowedDowntimeMs: 2425, source: 'mnk/CooldownDowntime' },
  ],

  Dragoon: [
    { key: 'high-jump', ids: [16478], cooldownMs: 30000, charges: 1, firstUseOffsetMs: 14500, allowedDowntimeMs: 1250, source: 'drg/OGCDDowntime' },
    { key: 'geirskogul', ids: [3555], cooldownMs: 60000, charges: 1, firstUseOffsetMs: 14500, allowedDowntimeMs: 1250, source: 'drg/OGCDDowntime' },
    { key: 'dragonfire-dive', ids: [96], cooldownMs: 120000, charges: 1, firstUseOffsetMs: 14500, allowedDowntimeMs: 1250, source: 'drg/OGCDDowntime' },
    { key: 'life-surge', ids: [83], cooldownMs: 40000, charges: 2, firstUseOffsetMs: 12000, allowedDowntimeMs: 1250, source: 'drg/OGCDDowntime' },
    { key: 'lance-charge', ids: [85], cooldownMs: 60000, charges: 1, firstUseOffsetMs: 7000, allowedDowntimeMs: 1250, source: 'drg/OGCDDowntime' },
    { key: 'battle-litany', ids: [3557], cooldownMs: 120000, charges: 1, firstUseOffsetMs: 7000, allowedDowntimeMs: 1250, source: 'drg/OGCDDowntime' },
  ],

  Ninja: [
    { key: 'kassatsu', ids: [2264], cooldownMs: 60000, charges: 1, firstUseOffsetMs: 1000, allowedDowntimeMs: 1250, source: 'nin/OGCDDowntime' },
    { key: 'dokumori', ids: [36957], cooldownMs: 120000, charges: 1, firstUseOffsetMs: 6000, allowedDowntimeMs: 1250, source: 'nin/OGCDDowntime' },
    { key: 'bunshin', ids: [16493], cooldownMs: 90000, charges: 1, firstUseOffsetMs: 7000, allowedDowntimeMs: 1250, source: 'nin/OGCDDowntime' },
    { key: 'kunais-bane', ids: [36958], cooldownMs: 60000, charges: 1, firstUseOffsetMs: 10000, allowedDowntimeMs: 1250, source: 'nin/OGCDDowntime' },
    // 注意：Dream Within a Dream 一次施放會產生多筆同時間的事件，xivanalysis 以時間戳去重後才計數
    { key: 'dream-within-a-dream', ids: [3566], cooldownMs: 60000, charges: 1, firstUseOffsetMs: 12250, allowedDowntimeMs: 1250, source: 'nin/OGCDDowntime' },
    { key: 'ten-chi-jin', ids: [7403], cooldownMs: 120000, charges: 1, firstUseOffsetMs: 17250, allowedDowntimeMs: 1250, source: 'nin/OGCDDowntime' },
    { key: 'meisui', ids: [16489], cooldownMs: 120000, charges: 1, firstUseOffsetMs: 20750, allowedDowntimeMs: 1250, source: 'nin/OGCDDowntime' },
  ],

  Samurai: [
    { key: 'meikyo-shisui', ids: [7499], cooldownMs: 55000, charges: 2, allowedDowntimeMs: 4360, source: 'sam/OGCDDowntime' },
    { key: 'hissatsu-guren', ids: [7496, 16481], cooldownMs: 60000, charges: 1, firstUseOffsetMs: 13400, allowedDowntimeMs: 2180, source: 'sam/OGCDDowntime' },
    { key: 'ikishoten', ids: [16482], cooldownMs: 120000, charges: 1, firstUseOffsetMs: 2500, allowedDowntimeMs: 2180, source: 'sam/OGCDDowntime' },
  ],

  Reaper: [
    { key: 'arcane-circle', ids: [24405], cooldownMs: 120000, charges: 1, firstUseOffsetMs: 5000, allowedDowntimeMs: 1250, source: 'rpr/CooldownDowntime' },
    { key: 'soul-slice', ids: [24380, 24381], cooldownMs: 30000, charges: 2, firstUseOffsetMs: 4000, allowedDowntimeMs: 1250, source: 'rpr/CooldownDowntime' },
    { key: 'gluttony', ids: [24393], cooldownMs: 60000, charges: 1, firstUseOffsetMs: 6000, allowedDowntimeMs: 1250, source: 'rpr/CooldownDowntime' },
  ],

  Viper: [
    { key: 'serpents-ire', ids: [34647], cooldownMs: 120000, charges: 1, firstUseOffsetMs: 2500, allowedDowntimeMs: 2180, source: 'vpr/OGCDDowntime' },
    // 7.05 前 xivanalysis 稱為 Dreadwinder／Pit of Dread，技能 ID、冷卻與充能相同，合併為一組
    { key: 'vicewinder', ids: [34620, 34623], cooldownMs: 40000, charges: 2, firstUseOffsetMs: 7500, allowedDowntimeMs: 2180, source: 'vpr/OGCDDowntime' },
  ],

  Bard: [
    { key: 'empyreal-arrow', ids: [3558], cooldownMs: 15000, charges: 1, firstUseOffsetMs: 4000, allowedDowntimeMs: 1, source: 'brd/OGCDDowntime' },
    { key: 'battle-voice', ids: [118], cooldownMs: 120000, charges: 1, firstUseOffsetMs: 7500, allowedDowntimeMs: 1250, source: 'brd/OGCDDowntime' },
    { key: 'radiant-finale', ids: [25785], cooldownMs: 110000, charges: 1, firstUseOffsetMs: 7500, allowedDowntimeMs: 10000, source: 'brd/OGCDDowntime' },
    { key: 'raging-strikes', ids: [101], cooldownMs: 120000, charges: 1, firstUseOffsetMs: 2500, allowedDowntimeMs: 1250, source: 'brd/OGCDDowntime' },
    { key: 'barrage', ids: [107], cooldownMs: 120000, charges: 1, firstUseOffsetMs: 12000, allowedDowntimeMs: 1250, source: 'brd/OGCDDowntime' },
    { key: 'sidewinder', ids: [3562], cooldownMs: 60000, charges: 1, firstUseOffsetMs: 12000, allowedDowntimeMs: 1250, source: 'brd/OGCDDowntime' },
  ],

  Machinist: [
    { key: 'wildfire', ids: [2878], cooldownMs: 120000, charges: 1, firstUseOffsetMs: 10000, allowedDowntimeMs: 1250, source: 'mch/GeneralCDDowntime' },
    { key: 'barrel-stabilizer', ids: [7414], cooldownMs: 120000, charges: 1, firstUseOffsetMs: 3000, allowedDowntimeMs: 1250, source: 'mch/GeneralCDDowntime' },
    { key: 'reassemble', ids: [2876], cooldownMs: 55000, charges: 2, firstUseOffsetMs: -3000, allowedDowntimeMs: 5000, source: 'mch/GeneralCDDowntime' },
    { key: 'air-anchor', ids: [16500], cooldownMs: 40000, charges: 1, firstUseOffsetMs: 0, allowedDowntimeMs: 100, source: 'mch/GeneralCDDowntime' },
    { key: 'drill', ids: [16498, 16499], cooldownMs: 20000, charges: 2, firstUseOffsetMs: 2500, allowedDowntimeMs: 100, source: 'mch/GeneralCDDowntime' },
    { key: 'chain-saw', ids: [25788], cooldownMs: 60000, charges: 1, firstUseOffsetMs: 12500, allowedDowntimeMs: 100, source: 'mch/GeneralCDDowntime' },
    // Blazing Shot、Heat Blast 各縮短 15 秒
    { key: 'double-check', ids: [36979], cooldownMs: 30000, charges: 3, firstUseOffsetMs: 3000, allowedDowntimeMs: 1250, resetBy: { ids: [36978, 7410], refundMs: 15000 }, source: 'mch/GeneralCDDowntime' },
    { key: 'checkmate', ids: [36980], cooldownMs: 30000, charges: 3, firstUseOffsetMs: 3000, allowedDowntimeMs: 1250, resetBy: { ids: [36978, 7410], refundMs: 15000 }, source: 'mch/GeneralCDDowntime' },
  ],

  Dancer: [
    // 舞步本身是 GCD，容許延遲只給 250 毫秒
    { key: 'technical-step', ids: [15998], cooldownMs: 120000, charges: 1, allowedDowntimeMs: 250, source: 'dnc/OGCDDowntime' },
    // 開打前 15 秒起跳；xivanalysis 對單次充能且 firstUseOffset 為負的技能，若第二次使用距第一次不到一個冷卻，會補算一次開打前使用
    { key: 'standard-step', ids: [15997, 36984], cooldownMs: 30000, charges: 1, firstUseOffsetMs: -15000, allowedDowntimeMs: 250, source: 'dnc/OGCDDowntime' },
    { key: 'devilment', ids: [16011], cooldownMs: 120000, charges: 1, allowedDowntimeMs: 1250, source: 'dnc/OGCDDowntime' },
    { key: 'flourish', ids: [16013], cooldownMs: 60000, charges: 1, allowedDowntimeMs: 1250, source: 'dnc/OGCDDowntime' },
  ],

  BlackMage: [
    // 7.1 起 Ley Lines 變為 2 次充能
    { key: 'ley-lines', ids: [3573], cooldownMs: 120000, charges: 1, firstUseOffsetMs: 15000, allowedDowntimeMs: 5000, patches: { before: '7.1' }, source: 'blm/OGCDDowntime' },
    { key: 'ley-lines', ids: [3573], cooldownMs: 120000, charges: 2, firstUseOffsetMs: 15000, allowedDowntimeMs: 5000, patches: { from: '7.1' }, source: 'blm/OGCDDowntime' },
    { key: 'manafont', ids: [158], cooldownMs: 100000, charges: 1, firstUseOffsetMs: 25000, allowedDowntimeMs: 5000, source: 'blm/OGCDDowntime' },
    // 7.2 起不再追蹤 Triplecast（已非 DPS 提升）
    { key: 'triplecast', ids: [7421], cooldownMs: 60000, charges: 2, firstUseOffsetMs: 15000, allowedDowntimeMs: 5000, patches: { before: '7.2' }, source: 'blm/OGCDDowntime' },
    { key: 'amplifier', ids: [25796], cooldownMs: 120000, charges: 1, firstUseOffsetMs: 15000, allowedDowntimeMs: 5000, source: 'blm/OGCDDowntime' },
  ],

  Summoner: [
    { key: 'summon-bahamut', ids: [7427, 25831, 36992], cooldownMs: 60000, charges: 1, firstUseOffsetMs: 4500, allowedDowntimeMs: 1250, source: 'smn/GeneralCDDowntime' },
    { key: 'energy-drain', ids: [16508, 16510], cooldownMs: 60000, charges: 1, firstUseOffsetMs: 7500, allowedDowntimeMs: 1250, source: 'smn/GeneralCDDowntime' },
    { key: 'searing-light', ids: [25801], cooldownMs: 120000, charges: 1, firstUseOffsetMs: 3500, allowedDowntimeMs: 1250, source: 'smn/GeneralCDDowntime' },
  ],

  RedMage: [
    { key: 'acceleration', ids: [7518], cooldownMs: 55000, charges: 2, allowedDowntimeMs: 4000, source: 'rdm/GeneralCDDowntime' },
    { key: 'manafication', ids: [7521], cooldownMs: 110000, charges: 1, firstUseOffsetMs: 17500, allowedDowntimeMs: 1000, source: 'rdm/GeneralCDDowntime' },
    { key: 'embolden', ids: [7520], cooldownMs: 120000, charges: 1, firstUseOffsetMs: 7500, allowedDowntimeMs: 1000, source: 'rdm/GeneralCDDowntime' },
    { key: 'fleche', ids: [7517], cooldownMs: 25000, charges: 1, allowedDowntimeMs: 1000, source: 'rdm/GeneralCDDowntime' },
    { key: 'contre-sixte', ids: [7519], cooldownMs: 35000, charges: 1, allowedDowntimeMs: 1000, source: 'rdm/GeneralCDDowntime' },
    { key: 'corps-a-corps', ids: [7506], cooldownMs: 35000, charges: 2, allowedDowntimeMs: 1000, source: 'rdm/GeneralCDDowntime' },
    { key: 'engagement', ids: [16527, 7515], cooldownMs: 35000, charges: 2, allowedDowntimeMs: 1000, source: 'rdm/GeneralCDDowntime' },
  ],

  Pictomancer: [
    { key: 'pom-muse', ids: [34670, 34671, 34672, 34673], cooldownMs: 40000, charges: 3, allowedDowntimeMs: 1250, source: 'pct/CooldownDowntime' },
    // 7.2 期間不追蹤 Striking Muse（該版本不一定是提升）
    { key: 'striking-muse', ids: [34674], cooldownMs: 60000, charges: 2, allowedDowntimeMs: 1250, patches: { before: '7.2' }, source: 'pct/CooldownDowntime' },
    { key: 'striking-muse', ids: [34674], cooldownMs: 60000, charges: 2, allowedDowntimeMs: 1250, patches: { from: '7.3' }, source: 'pct/CooldownDowntime' },
    { key: 'starry-muse', ids: [34675], cooldownMs: 120000, charges: 1, allowedDowntimeMs: 1250, source: 'pct/CooldownDowntime' },
  ],
}
