import { FFLOGS_API_URL } from '../config'
import { getAccessToken } from './auth'

export class NotLoggedInError extends Error {
  constructor() {
    super('尚未登入 FFLogs')
  }
}

/** 對 FFLogs v2 GraphQL API 送出查詢。 */
export async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const token = getAccessToken()
  if (!token) throw new NotLoggedInError()

  const res = await fetch(FFLOGS_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables }),
  })
  if (!res.ok) throw new Error(`FFLogs API 錯誤：${res.status}`)

  const body = (await res.json()) as { data?: T; errors?: { message: string }[] }
  if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join('\n'))
  return body.data as T
}
