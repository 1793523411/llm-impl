import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { SkillConfig } from '@llm-impl/shared'

const FRONTMATTER_REG = /^---\r?\n([\s\S]*?)\r?\n---/
const NAME_REG = /^name:\s*["']?([^"'\n]+)["']?\s*$/m
const DESC_LINE_REG = /^description:\s*(.+)$/m

function parseSkillMd(content: string): {
  name: string
  description: string
  body: string
} | null {
  const match = content.match(FRONTMATTER_REG)
  if (!match) return null
  const frontmatter = match[1] ?? ''
  const name = frontmatter.match(NAME_REG)?.[1]?.trim() ?? ''
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) return null
  const rawDescription = frontmatter.match(DESC_LINE_REG)?.[1]?.trim() ?? ''
  const description =
    (rawDescription.startsWith('"') && rawDescription.endsWith('"')) ||
    (rawDescription.startsWith("'") && rawDescription.endsWith("'"))
      ? rawDescription.slice(1, -1).trim()
      : rawDescription
  return {
    name,
    description,
    body: content.slice(match[0].length).trim(),
  }
}

async function dirExists(dir: string): Promise<boolean> {
  try {
    return (await fs.stat(dir)).isDirectory()
  } catch {
    return false
  }
}

async function defaultSkillRoots(): Promise<string[]> {
  const candidates = [
    process.env.SKILL_ROOTS,
    path.resolve(process.cwd(), 'skills'),
    path.resolve(process.cwd(), '../rule_agent/skills'),
  ]
    .flatMap((entry) => (entry ? entry.split(path.delimiter) : []))
    .map((entry) => path.resolve(entry))

  const unique = [...new Set(candidates)]
  const existing: string[] = []
  for (const root of unique) {
    if (await dirExists(root)) existing.push(root)
  }
  return existing
}

export async function listSkills(roots: string[] = []): Promise<SkillConfig[]> {
  const searchRoots = roots.length > 0 ? roots : await defaultSkillRoots()
  const byName = new Map<string, SkillConfig>()

  for (const root of searchRoots.map((entry) => path.resolve(entry))) {
    if (!(await dirExists(root))) continue
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dirPath = path.join(root, entry.name)
      const skillMdPath = path.join(dirPath, 'SKILL.md')
      try {
        const content = await fs.readFile(skillMdPath, 'utf8')
        const parsed = parseSkillMd(content)
        if (!parsed) continue
        byName.set(parsed.name, {
          id: parsed.name,
          name: parsed.name,
          description: parsed.description,
          dirPath,
          source: 'skill-md',
          enabled: true,
          exposeAsTool: false,
          preload: false,
        })
      } catch {
        // Ignore folders that are not valid skill packages.
      }
    }
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export async function loadSkillContent(skill: SkillConfig): Promise<string> {
  if (skill.source === 'manual' || !skill.dirPath) {
    const body = skill.instruction?.trim() || '(no instruction configured)'
    return [
      `<skill name="${skill.name}">`,
      body,
      `</skill>`,
    ].join('\n')
  }

  const skillMdPath = path.join(skill.dirPath, 'SKILL.md')
  const content = await fs.readFile(skillMdPath, 'utf8')
  const parsed = parseSkillMd(content)
  if (!parsed || parsed.name !== skill.name) {
    throw new Error(`Invalid SKILL.md for ${skill.name}`)
  }

  const resolvedBody = parsed.body.replace(/<SKILL_PATH>/g, skill.dirPath)
  return [
    `<skill name="${parsed.name}">`,
    `<skill_directory>${skill.dirPath}</skill_directory>`,
    `<important>`,
    `When executing any scripts from this skill, ALWAYS set working_directory to "${skill.dirPath}" in the run_command call.`,
    `All script paths shown below are absolute paths. Use them exactly as shown.`,
    `If a script references relative paths (e.g., ./images/, ./output/), they are relative to the skill directory above.`,
    `</important>`,
    resolvedBody,
    `</skill>`,
  ].join('\n')
}
