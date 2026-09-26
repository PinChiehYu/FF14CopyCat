// 代理只會送出這裡定義的查詢；前端無法送任意 GraphQL。

export const REPORT_QUERY = /* GraphQL */ `
  query Report($code: String!) {
    reportData {
      report(code: $code) {
        code
        title
        startTime
        endTime
        fights {
          id
          name
          encounterID
          difficulty
          kill
          startTime
          endTime
          friendlyPlayers
        }
        masterData {
          actors {
            id
            name
            type
            subType
            server
            petOwner
            gameID
          }
          abilities {
            gameID
            name
            icon
            type
          }
        }
      }
    }
  }
`

// 敵方普通攻擊（名稱為 attack）對每位玩家造成的傷害，用來判斷誰在坦 Boss（MT）
export const AUTO_ATTACKS_TAKEN_QUERY = /* GraphQL */ `
  query AutoAttacksTaken($code: String!, $fightIDs: [Int]) {
    reportData {
      report(code: $code) {
        table(
          fightIDs: $fightIDs
          dataType: DamageTaken
          hostilityType: Friendlies
          filterExpression: "ability.name = 'attack'"
        )
      }
    }
  }
`

/** 一場戰鬥的傷害表（每位角色的總傷害；FFLogs 有計算時也含 rDPS 等欄位）。 */
export const DAMAGE_DONE_QUERY = /* GraphQL */ `
  query DamageDone($code: String!, $fightIDs: [Int]) {
    reportData {
      report(code: $code) {
        table(fightIDs: $fightIDs, dataType: DamageDone)
      }
    }
  }
`

export const EVENTS_QUERY = /* GraphQL */ `
  query Events(
    $code: String!
    $fightIDs: [Int]
    $startTime: Float
    $endTime: Float
    $sourceID: Int
    $dataType: EventDataType
    $hostilityType: HostilityType
  ) {
    reportData {
      report(code: $code) {
        events(
          fightIDs: $fightIDs
          startTime: $startTime
          endTime: $endTime
          sourceID: $sourceID
          dataType: $dataType
          hostilityType: $hostilityType
          includeResources: true
          limit: 10000
        ) {
          data
          nextPageTimestamp
        }
      }
    }
  }
`
