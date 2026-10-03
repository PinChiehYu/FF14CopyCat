// 簡中轉台灣正體（字元與異體字，不改用詞），技能與 Boss 名稱缺官方繁中時用。
// opencc 的字典與轉換器建立很花 CPU（Node 實測載入約 40 ms、建立轉換器約 45 ms）：只在第一次需要時載入，
// 定時工作與大多數請求（名稱都有官方繁中）不必付這個成本。
let converter: Promise<(text: string) => string> | null = null

export async function toTraditional(text: string): Promise<string> {
  converter ??= import('opencc-js/cn2t').then(({ Converter }) => Converter({ from: 'cn', to: 'tw' }))
  return (await converter)(text)
}
