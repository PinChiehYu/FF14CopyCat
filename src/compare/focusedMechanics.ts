import { useCallback, useEffect, useState } from 'react'
import { mainMechanicGroups, occurrenceOf, type MechanicOccurrence } from '../analysis/mainMechanics'

// 使用者取消勾選（不關注）的機制時間點（MechanicOccurrence.id），依 Boss 記在瀏覽器；
// 搜尋前輩日誌的「機制相同的排前面」只比對關注的時間點，比較結果依此高光
const STORAGE_KEY = 'finder-ignored-occurrences:'
// 同一頁的其他元件（搜尋面板改了 → 比較結果更新）
const CHANGE_EVENT = 'focused-mechanics-change'

function load(encounter: number): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY + encounter)
    return new Set(raw ? (JSON.parse(raw) as string[]) : [])
  } catch {
    return new Set()
  }
}

/** 不關注的時間點與更新函式；搜尋面板與比較結果共用（改了會通知同一頁的其他使用者） */
export function useIgnoredOccurrences(encounter: number): [Set<string>, (next: Set<string>) => void] {
  const [state, setState] = useState<{ encounter: number; ids: Set<string> }>(() => ({ encounter, ids: load(encounter) }))
  const ids = state.encounter === encounter ? state.ids : load(encounter)
  useEffect(() => {
    const onChange = (e: Event) => {
      if ((e as CustomEvent<number>).detail === encounter) setState({ encounter, ids: load(encounter) })
    }
    window.addEventListener(CHANGE_EVENT, onChange)
    return () => window.removeEventListener(CHANGE_EVENT, onChange)
  }, [encounter])
  const update = useCallback(
    (next: Set<string>) => {
      setState({ encounter, ids: next })
      try {
        localStorage.setItem(STORAGE_KEY + encounter, JSON.stringify([...next]))
      } catch {
        // 無法儲存（私密瀏覽等）時只在這次有效
      }
      window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: encounter }))
    },
    [encounter],
  )
  return [ids, update]
}

/**
 * 比較結果的高光判斷：技能 ID 與我的時間 → 是否為關注的時間點。
 * 只在使用者取消勾選過我這場的至少一個時間點時才有（預設全部關注時不高光，避免整頁都亮）；否則回傳 null。
 * cactbot 沒列、但與主要機制同名的技能（同一招的後續判定，例如 M8S 掃擊群狼劍 #43282 之後 0.2 秒的 #43297）
 * 以英文名稱對到該機制；同名的機制可能有好幾個（例如圓形與扇形的群狼劍），任一個對到關注的時間點就算。
 * @param englishName 技能的英文名稱（FFLogs 報告的名稱，兩邊日誌相同）
 */
export function focusChecker(
  encounter: number,
  occurrences: MechanicOccurrence[],
  ignored: Set<string>,
  englishName: (abilityId: number) => string | undefined,
): ((abilityId: number, mineT: number) => boolean) | null {
  if (!occurrences.some((o) => ignored.has(o.id))) return null
  const groups = mainMechanicGroups(encounter)
  if (!groups) return null
  const keysByName = new Map<string, Set<number>>()
  for (const [id, key] of groups) {
    const name = englishName(id)
    if (name) keysByName.set(name, (keysByName.get(name) ?? new Set()).add(key))
  }
  const keysOf = (abilityId: number): number[] => {
    const key = groups.get(abilityId)
    if (key !== undefined) return [key]
    const name = englishName(abilityId)
    return name ? [...(keysByName.get(name) ?? [])] : []
  }
  return (abilityId, mineT) =>
    keysOf(abilityId).some((key) => {
      const id = occurrenceOf(occurrences, key, mineT)
      return id !== null && !ignored.has(id)
    })
}
