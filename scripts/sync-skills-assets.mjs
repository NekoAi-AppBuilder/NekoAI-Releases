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

  // Only seed src assets from external extension if src assets does not exist or is empty
  const srcAssetsEmpty = !hasTargetSrc || fs.readdirSync(targetSrc).length === 0
  if (srcAssetsEmpty && hasExtSkills) {
    fs.mkdirSync(targetSrc, { recursive: true })
    copyDirRecursive(extSkills, targetSrc)
    console.log("Seeded src assets from extension directory.")
  }

  const targetDist = path.join(root, "dist", "main", "skills", "assets")
  copyDirRecursive(targetSrc, targetDist)
  console.log("Dist copy complete from repository src/main/skills/assets!")
} catch (err) {
  console.error("CAUGHT ERROR:", err)
  process.exit(1)
}
