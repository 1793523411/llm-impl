import { promises as fs } from 'node:fs'
import path from 'node:path'

const STATE_DIR = path.resolve(process.env.STATE_DIR ?? './state')
const FILE = path.join(STATE_DIR, 'workspace.json')

export async function readWorkspace(): Promise<unknown | null> {
  try {
    const content = await fs.readFile(FILE, 'utf8')
    return JSON.parse(content)
  } catch {
    return null
  }
}

export async function writeWorkspace(data: unknown): Promise<void> {
  await fs.mkdir(STATE_DIR, { recursive: true })
  await fs.writeFile(FILE, JSON.stringify(data, null, 2), 'utf8')
}
