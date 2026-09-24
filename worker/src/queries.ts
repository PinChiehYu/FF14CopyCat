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
