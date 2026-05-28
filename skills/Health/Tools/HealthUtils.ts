import { writeFile, readFile } from "fs/promises"
import { existsSync } from "fs"
import path from "path"

/**
 * Inserts or updates a link entry in vault index.md under the 04 Health section.
 * Idempotent — skips if the entry already exists.
 */
export async function updateIndex(date: string, summary: string, vault: string): Promise<void> {
  const indexPath = path.join(vault, "index.md")
  const relPath = `04 Health/wiki/${date}_health-summary.md`
  const firstSentence = summary.split(/\.\s/)[0].replace(/\n/g, " ").trim()
  const truncated = firstSentence.length > 110 ? firstSentence.slice(0, 107) + "…" : firstSentence
  const entry = `- [${date}](${relPath}) — ${truncated}\n`
  const DOMAIN_HEADER = "## 04 Health"

  if (!existsSync(indexPath)) {
    await writeFile(indexPath, `# Vault Index\n\n${DOMAIN_HEADER}\n\n${entry}`, "utf-8")
    return
  }

  let content = await readFile(indexPath, "utf-8")
  if (content.includes(`(${relPath})`)) return

  if (content.includes(DOMAIN_HEADER)) {
    const sectionStart = content.indexOf(DOMAIN_HEADER)
    const nextSection = content.indexOf("\n## ", sectionStart + 1)
    if (nextSection === -1) {
      content = content.trimEnd() + "\n" + entry
    } else {
      content = content.slice(0, nextSection) + entry + content.slice(nextSection)
    }
  } else {
    content = content.trimEnd() + `\n\n${DOMAIN_HEADER}\n\n${entry}`
  }

  await writeFile(indexPath, content, "utf-8")
}
