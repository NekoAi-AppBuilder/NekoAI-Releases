import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, "..")
const source = path.join(root, "node_modules", "@opencode-ai", "ui", "src", "components", "provider-icons", "sprite.svg")
const target = path.join(root, "src", "renderer", "assets", "opencode-provider-sprite.svg")

if (!fs.existsSync(source)) {
  console.error("[NekoAI] Não foi possível localizar o sprite oficial de providers do @opencode-ai/ui.")
  console.error("[NekoAI] Execute npm install antes do build.")
  process.exit(1)
}

fs.mkdirSync(path.dirname(target), { recursive: true })
fs.copyFileSync(source, target)
console.log(`[NekoAI] Sprite oficial de providers copiado para ${path.relative(root, target)}`)
