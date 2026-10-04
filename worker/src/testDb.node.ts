// Node 環境測試共用（使用 node:sqlite）：由 tsconfig.node.json 檢查，Worker 的 tsconfig 不含 Node 型別
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import type { DbLike, StatementLike } from './crawler.ts'

/** 以 Node 內建的 SQLite 實作 D1 的最小介面，套用與正式環境相同的 schema.sql。 */
export function memoryDb(): DbLike {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'))
  const statement = (sql: string, values: unknown[] = []): StatementLike => ({
    bind: (...next) => statement(sql, next),
    first: async <T>() => (sqlite.prepare(sql).get(...(values as never[])) as T) ?? null,
    all: async <T>() => ({ results: sqlite.prepare(sql).all(...(values as never[])) as T[] }),
    run: async () => sqlite.prepare(sql).run(...(values as never[])),
  })
  return {
    prepare: (sql) => statement(sql),
    batch: async (statements) => {
      for (const s of statements) await s.run()
    },
  }
}
