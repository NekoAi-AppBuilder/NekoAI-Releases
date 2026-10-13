import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

try {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const root = path.resolve(here, "..")

  const extSkills = path.resolve(root, "..", "..", "Extensão NekoAI", "NekoAI-Lovable-Extension-v0.3.9", "skills")
  const targetSrc = path.join(root, "src", "main", "skills", "assets")

  const hasExtSkills = fs.existsSync(extSkills)
  const hasTargetSrc = fs.existsSync(targetSrc)

  if (!hasExtSkills && !hasTargetSrc) {
    console.error("Neither extension skills directory nor repository assets found!")
    process.exit(1)
  }

  fs.mkdirSync(targetSrc, { recursive: true })
  console.log("Target dir created, copying files...")

  function copyDirRecursive(src, dst) {
    fs.mkdirSync(dst, { recursive: true })
    const entries = fs.readdirSync(src, { withFileTypes: true })
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name)
      const dstPath = path.join(dst, entry.name)
      if (entry.isDirectory()) {
        copyDirRecursive(srcPath, dstPath)
      } else {
        fs.copyFileSync(srcPath, dstPath)
      }
    }
  }

  if (hasExtSkills) {
    copyDirRecursive(extSkills, targetSrc)
    console.log("Copied from extension to src assets!")
  }

  const targetDist = path.join(root, "dist", "main", "skills", "assets")
  copyDirRecursive(targetSrc, targetDist)
  console.log("Dist copy complete from repository assets!")
} catch (err) {
  console.error("CAUGHT ERROR:", err)
  process.exit(1)
}
