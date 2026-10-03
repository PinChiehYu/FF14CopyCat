// 比較結果中參考一方的稱呼：單一日誌為「參考」，前輩平均為「前輩平均」（Comparison.tsx 依參考模式提供）
import { createContext, useContext } from 'react'

export const RefLabelContext = createContext('參考')

export function useRefLabel(): string {
  return useContext(RefLabelContext)
}
