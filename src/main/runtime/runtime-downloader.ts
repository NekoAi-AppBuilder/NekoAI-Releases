// src/main/runtime/runtime-downloader.ts
// Download seguro de redistribuíveis via HTTPS com verificação de SHA-256 e atomicidade.

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import https from "node:https";
import { URL } from "node:url";
import { DownloadSpec, DownloadResult } from "./runtime-types";

export class RuntimeDownloader {
  /**
   * Baixa um arquivo via HTTPS estrito, grava em arquivo temporário, calcula e valida o hash SHA-256.
   * Se qualquer etapa falhar, o arquivo temporário é removido.
   */
  public async download(spec: DownloadSpec): Promise<DownloadResult> {
    const { url, destinationPath, expectedSha256, expectedSizeBytes } = spec;

    // 1. Validação estrita de protocolo HTTPS
    if (!url || typeof url !== "string" || !url.toLowerCase().startsWith("https://")) {
      const errorMsg = `INSECURE_PROTOCOL: Download recusado. Apenas URLs HTTPS são permitidas (URL: ${this.sanitizeUrlForLog(url)})`;
      console.error(`[RuntimeDownloader] ${errorMsg}`);
      return {
        success: false,
        filePath: destinationPath,
        actualSha256: "",
        sizeBytes: 0,
        error: errorMsg,
      };
    }

    const tempFilePath = `${destinationPath}.tmp`;
    const destDir = path.dirname(destinationPath);

    try {
      await fs.mkdir(destDir, { recursive: true });
      if (fsSync.existsSync(tempFilePath)) {
        await fs.unlink(tempFilePath).catch(() => {});
      }
    } catch (e: any) {
      return {
        success: false,
        filePath: destinationPath,
        actualSha256: "",
        sizeBytes: 0,
        error: `FOLDER_CREATION_FAILED: ${e?.message || String(e)}`,
      };
    }

    try {
      // 2. Download via HTTPS
      await this.performHttpsDownload(url, tempFilePath);

      // 3. Validação de tamanho se informado
      const stats = await fs.stat(tempFilePath);
      if (expectedSizeBytes !== undefined && expectedSizeBytes > 0 && stats.size !== expectedSizeBytes) {
        await fs.unlink(tempFilePath).catch(() => {});
        const errorMsg = `SIZE_MISMATCH: Tamanho esperado ${expectedSizeBytes} bytes, recebido ${stats.size} bytes.`;
        console.error(`[RuntimeDownloader] ${errorMsg}`);
        return {
          success: false,
          filePath: destinationPath,
          actualSha256: "",
          sizeBytes: stats.size,
          error: errorMsg,
        };
      }

      // 4. Cálculo e validação do hash SHA-256
      const actualSha256 = await this.calculateSha256(tempFilePath);
      const normalizedExpected = expectedSha256.toLowerCase().trim();
      const normalizedActual = actualSha256.toLowerCase().trim();

      if (normalizedActual !== normalizedExpected) {
        await fs.unlink(tempFilePath).catch(() => {});
        const errorMsg = `CHECKSUM_MISMATCH: Hash SHA-256 esperado '${normalizedExpected}', obtido '${normalizedActual}'.`;
        console.error(`[RuntimeDownloader] ${errorMsg}`);
        return {
          success: false,
          filePath: destinationPath,
          actualSha256: normalizedActual,
          sizeBytes: stats.size,
          error: errorMsg,
        };
      }

      // 5. Finalização atômica (Rename do arquivo temporário para o destino)
      if (fsSync.existsSync(destinationPath)) {
        await fs.unlink(destinationPath).catch(() => {});
      }
      await fs.rename(tempFilePath, destinationPath);

      console.log(`[RuntimeDownloader] Download e validação SHA-256 concluídos com sucesso para ${path.basename(destinationPath)}`);

      return {
        success: true,
        filePath: destinationPath,
        actualSha256: normalizedActual,
        sizeBytes: stats.size,
      };
    } catch (err: any) {
      if (fsSync.existsSync(tempFilePath)) {
        await fs.unlink(tempFilePath).catch(() => {});
      }
      const errorMsg = `DOWNLOAD_FAILED: ${err?.message || String(err)}`;
      console.error(`[RuntimeDownloader] ${errorMsg}`);
      return {
        success: false,
        filePath: destinationPath,
        actualSha256: "",
        sizeBytes: 0,
        error: errorMsg,
      };
    }
  }

  private sanitizeUrlForLog(rawUrl: string): string {
    if (!rawUrl) return "";
    try {
      const parsed = new URL(rawUrl);
      return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
    } catch {
      return rawUrl.split("?")[0];
    }
  }

  private performHttpsDownload(urlStr: string, destFilePath: string, redirects = 0): Promise<void> {
    return new Promise((resolve, reject) => {
      if (redirects > 5) {
        return reject(new Error("MUITOS_REDIRECIONAMENTOS: Limite de 5 redirecionamentos excedido."));
      }

      try {
        const parsedUrl = new URL(urlStr);
        if (parsedUrl.protocol !== "https:") {
          return reject(new Error(`INSECURE_PROTOCOL: Redirecionamento para protocolo inseguro recusado (${parsedUrl.protocol})`));
        }

        const request = https.get(parsedUrl, (response) => {
          // Tratar Redirecionamentos (301, 302, 307, 308)
          if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
            const redirectUrl = new URL(response.headers.location, urlStr).toString();
            return this.performHttpsDownload(redirectUrl, destFilePath, redirects + 1)
              .then(resolve)
              .catch(reject);
          }

          if (response.statusCode !== 200) {
            return reject(new Error(`HTTP_${response.statusCode}: Servidor retornou código ${response.statusCode}`));
          }

          const fileStream = fsSync.createWriteStream(destFilePath);
          response.pipe(fileStream);

          fileStream.on("finish", () => {
            fileStream.close(() => resolve());
          });

          fileStream.on("error", (err) => {
            fileStream.close(() => reject(err));
          });
        });

        request.on("error", (err) => {
          reject(err);
        });

        request.setTimeout(30000, () => {
          request.destroy();
          reject(new Error("TIMEOUT: Download excedeu o tempo limite de 30s"));
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  private calculateSha256(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash("sha256");
      const stream = fsSync.createReadStream(filePath);

      stream.on("data", (data) => hash.update(data));
      stream.on("end", () => resolve(hash.digest("hex")));
      stream.on("error", (err) => reject(err));
    });
  }
}
