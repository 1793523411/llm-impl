import { promises as fs } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(process.env.CASES_DIR ?? './cases')

function safeJoin(rel: string): string | null {
  // prevent path traversal
  const cleaned = rel.replace(/^\/+/, '')
  const abs = path.resolve(ROOT, cleaned)
  if (!abs.startsWith(ROOT + path.sep) && abs !== ROOT) return null
  return abs
}

export type CaseEntry = {
  path: string
  type: 'file' | 'dir'
  children?: CaseEntry[]
}

async function walk(dir: string, rel: string): Promise<CaseEntry[]> {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: CaseEntry[] = []
  entries.sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory()) return -1
    if (!a.isDirectory() && b.isDirectory()) return 1
    return a.name.localeCompare(b.name)
  })
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    const childRel = rel ? `${rel}/${e.name}` : e.name
    const childAbs = path.join(dir, e.name)
    if (e.isDirectory()) {
      out.push({
        path: childRel,
        type: 'dir',
        children: await walk(childAbs, childRel),
      })
    } else if (e.isFile() && e.name.endsWith('.json')) {
      out.push({ path: childRel, type: 'file' })
    }
  }
  return out
}

export async function listCases(): Promise<CaseEntry[]> {
  await fs.mkdir(ROOT, { recursive: true })
  return walk(ROOT, '')
}

export async function readCase(rel: string): Promise<unknown | null> {
  const abs = safeJoin(rel)
  if (!abs) return null
  try {
    const content = await fs.readFile(abs, 'utf8')
    return JSON.parse(content)
  } catch {
    return null
  }
}

export async function writeCase(rel: string, data: unknown): Promise<void> {
  const abs = safeJoin(rel)
  if (!abs) throw new Error('invalid path')
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, JSON.stringify(data, null, 2), 'utf8')
}

export async function createCaseDir(rel: string): Promise<void> {
  const abs = safeJoin(rel)
  if (!abs) throw new Error('invalid path')
  const existing = await fs.stat(abs).catch(() => null)
  if (existing) throw new Error('target already exists')
  await fs.mkdir(abs, { recursive: true })
}

export async function moveCaseEntry(fromRel: string, toRel: string): Promise<boolean> {
  const fromAbs = safeJoin(fromRel)
  const toAbs = safeJoin(toRel)
  if (!fromAbs || !toAbs || fromAbs === ROOT) throw new Error('invalid path')
  if (fromAbs === toAbs) return true

  const stat = await fs.stat(fromAbs).catch(() => null)
  if (!stat) return false

  if (stat.isFile() && !fromAbs.endsWith('.json')) {
    throw new Error('only JSON case files can be moved')
  }
  if (stat.isFile() && !toAbs.endsWith('.json')) {
    throw new Error('target case path must end with .json')
  }
  if (stat.isDirectory() && (toAbs === fromAbs || toAbs.startsWith(fromAbs + path.sep))) {
    throw new Error('cannot move a folder into itself')
  }

  const targetExists = await fs.stat(toAbs).catch(() => null)
  if (targetExists) throw new Error('target already exists')

  await fs.mkdir(path.dirname(toAbs), { recursive: true })
  await fs.rename(fromAbs, toAbs)
  return true
}

export async function deleteCase(rel: string): Promise<boolean> {
  const abs = safeJoin(rel)
  if (!abs || abs === ROOT) return false
  const stat = await fs.stat(abs).catch(() => null)
  if (!stat) return false
  if (stat.isDirectory()) {
    await fs.rm(abs, { recursive: true })
    return true
  }
  if (stat.isFile()) {
    if (!abs.endsWith('.json')) throw new Error('only JSON case files can be deleted')
    await fs.unlink(abs)
    return true
  }
  return false
}
