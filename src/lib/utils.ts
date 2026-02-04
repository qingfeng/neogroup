import { nanoid } from 'nanoid'

export function generateId(): string {
  return nanoid(12)
}

export function now(): Date {
  return new Date()
}

export function parseJson<T>(str: string | null | undefined, fallback: T): T {
  if (!str) return fallback
  try {
    return JSON.parse(str) as T
  } catch {
    return fallback
  }
}

export function toJson(obj: unknown): string {
  return JSON.stringify(obj)
}
