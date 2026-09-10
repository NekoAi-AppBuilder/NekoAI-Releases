// src/main/license/license-device.ts
// Gerenciador estável e determinístico de Device ID no Electron

import { app } from "electron";
import path from "node:path";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import crypto from "node:crypto";
import os from "node:os";

let cachedDeviceId: string | null = null;

function getDeviceIdFilePath(): string {
  return path.join(app.getPath("userData"), "device-id.json");
}

/**
 * Obtém ou gera um Device ID imutável de exatamente 32 caracteres hexadecimais
 */
export async function getStableDeviceId(): Promise<string> {
  if (cachedDeviceId) return cachedDeviceId;

  const filePath = getDeviceIdFilePath();
  try {
    if (fsSync.existsSync(filePath)) {
      const raw = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (typeof parsed?.deviceId === "string" && /^[0-9a-fA-F]{32}$/.test(parsed.deviceId)) {
        const id = parsed.deviceId.toLowerCase();
        cachedDeviceId = id;
        return id;
      }
    }
  } catch (err) {
    console.warn("[Neko/License] Erro ao ler device-id.json, recriando:", err);
  }

  // Gera um UUID aleatório criptográfico e deriva um hash estável
  const seed = `${crypto.randomUUID()}:${os.userInfo().username || "neko-user"}`;
  const generatedId = crypto.createHash("sha256").update(seed).digest("hex").slice(0, 32).toLowerCase();

  try {
    await fs.writeFile(filePath, JSON.stringify({ version: 1, deviceId: generatedId }, null, 2), "utf8");
  } catch (writeErr) {
    console.warn("[Neko/License] Não foi possível persistir device-id.json:", writeErr);
  }

  cachedDeviceId = generatedId;
  return cachedDeviceId;
}
