// src/main/runtime/runtime-provisioner.ts
// Provisionamento seguro de runtimes: Staging, Extração com proteção Zip Slip, Validação Estrutural e Registro.

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { RuntimeDownloader } from "./runtime-downloader";
import { RuntimeStore } from "./runtime-store";
import {
  ProvisionOptions,
  ProvisionResult,
  RuntimeDescriptor,
  RuntimeExecutable,
} from "./runtime-types";

export interface RuntimeProvisionerOptions {
  store?: RuntimeStore;
  downloader?: RuntimeDownloader;
  baseDir?: string;
}

export class RuntimeProvisioner {
  private store: RuntimeStore;
  private downloader: RuntimeDownloader;
  private baseDir: string;
  private stagingBaseDir: string;

  constructor(options: RuntimeProvisionerOptions = {}) {
    this.store = options.store || new RuntimeStore(options.baseDir ? { baseDir: options.baseDir } : {});
    this.downloader = options.downloader || new RuntimeDownloader();
    this.baseDir = this.store.getBaseDir();
    this.stagingBaseDir = path.join(this.baseDir, "staging");
  }

  public getStagingBaseDir(): string {
    return this.stagingBaseDir;
  }

  /**
   * Fluxo completo de provisionamento:
   * Download HTTPS (SHA-256) -> Staging -> Extração Segura -> Validação Estrutural -> Mover para Destino Final -> Registro no Store
   */
  public async provision(options: ProvisionOptions): Promise<ProvisionResult> {
    const {
      id,
      name,
      version,
      downloadUrl,
      expectedSha256,
      binDirs,
      executables,
      environmentVariables,
      metadata,
    } = options;

    if (!id || !name || !version || !downloadUrl || !expectedSha256) {
      return {
        success: false,
        error: "MISSING_PROVISION_PARAM: id, name, version, downloadUrl e expectedSha256 são obrigatórios.",
      };
    }

    const timestamp = Date.now();
    const stagingDir = path.join(this.stagingBaseDir, `${id}-${timestamp}`);
    const archivePath = path.join(stagingDir, `archive.zip`);
    const finalInstallDir = path.join(this.baseDir, id);

    try {
      // 1. Criar pasta de staging isolada
      await fs.mkdir(stagingDir, { recursive: true });

      // 2. Download validado via RuntimeDownloader
      const downloadRes = await this.downloader.download({
        url: downloadUrl,
        destinationPath: archivePath,
        expectedSha256,
      });

      if (!downloadRes.success) {
        await this.cleanupDirectory(stagingDir);
        return {
          success: false,
          error: downloadRes.error || "DOWNLOAD_FAILED",
        };
      }

      // 3. Extração segura do arquivo ZIP com Proteção Zip Slip
      await this.extractZipSafely(archivePath, stagingDir);

      // Remover o arquivo ZIP baixado após extração
      await fs.unlink(archivePath).catch(() => {});

      // 4. Validação Estrutural (diretórios bin e executáveis declarados)
      this.validateStructure(stagingDir, binDirs, executables);

      // 5. Mover staging para o diretório de destino final
      if (fsSync.existsSync(finalInstallDir)) {
        await this.cleanupDirectory(finalInstallDir);
      }
      await fs.mkdir(path.dirname(finalInstallDir), { recursive: true });
      await fs.rename(stagingDir, finalInstallDir);

      // 6. Construir caminhos absolutos para o descriptor final
      const absoluteBinDirs = binDirs.map((rel) => path.resolve(finalInstallDir, rel));
      const absoluteExecutables: RuntimeExecutable[] = executables.map((exe) => ({
        ...exe,
        relativePath: path.resolve(finalInstallDir, exe.relativePath),
      }));

      // Calcular tamanho final instalado no disco
      const installedSizeBytes = await this.calculateDirectorySize(finalInstallDir);

      const descriptor: RuntimeDescriptor = {
        id,
        name,
        version,
        category: "provisioned",
        status: "ready",
        installDir: finalInstallDir,
        binDirs: absoluteBinDirs,
        executables: absoluteExecutables,
        environmentVariables,
        downloadUrl,
        expectedSha256,
        installedSizeBytes,
        installedAt: new Date().toISOString(),
        metadata,
      };

      // 7. Registrar no RuntimeStore
      await this.store.registerRuntime(descriptor);

      console.log(`[RuntimeProvisioner] Provisionamento concluído com sucesso para ${id}`);

      return {
        success: true,
        descriptor,
      };
    } catch (err: any) {
      // ROLLBACK: Limpar pasta de staging e garantir ausência de registros fantasmas
      await this.cleanupDirectory(stagingDir).catch(() => {});
      const errorMsg = `PROVISIONING_FAILED: ${err?.message || String(err)}`;
      console.error(`[RuntimeProvisioner] ${errorMsg}`);
      return {
        success: false,
        error: errorMsg,
      };
    }
  }

  /**
   * Extração de arquivo ZIP na memória/disco com Validação Estrita de Zip Slip.
   */
  public async extractZipSafely(zipFilePath: string, targetDir: string): Promise<void> {
    const zipBuffer = await fs.readFile(zipFilePath);
    const resolvedTargetDir = path.resolve(targetDir);

    let offset = 0;
    const entries: { fileName: string; data: Buffer; isDir: boolean }[] = [];

    while (offset < zipBuffer.length - 4) {
      const signature = zipBuffer.readUInt32LE(offset);
      if (signature === 0x04034b50) { // Cabeçalho Local do arquivo
        const flags = zipBuffer.readUInt16LE(offset + 6);
        const compression = zipBuffer.readUInt16LE(offset + 8);
        let compressedSize = zipBuffer.readUInt32LE(offset + 18);
        const nameLen = zipBuffer.readUInt16LE(offset + 26);
        const extraLen = zipBuffer.readUInt16LE(offset + 28);

        const nameBuf = zipBuffer.subarray(offset + 30, offset + 30 + nameLen);
        const fileName = nameBuf.toString("utf8");
        const dataOffset = offset + 30 + nameLen + extraLen;

        if ((flags & 0x08) !== 0) {
          let nextPos = dataOffset;
          while (nextPos < zipBuffer.length - 4) {
            const sig = zipBuffer.readUInt32LE(nextPos);
            if (sig === 0x04034b50 || sig === 0x02014b50 || sig === 0x06054b50) {
              break;
            }
            nextPos++;
          }
          compressedSize = nextPos - dataOffset;
        }

        const compressedData = zipBuffer.subarray(dataOffset, dataOffset + compressedSize);
        let uncompressedData: Buffer;

        if (compression === 0) {
          uncompressedData = Buffer.from(compressedData);
        } else if (compression === 8) {
          try {
            uncompressedData = zlib.inflateRawSync(compressedData);
          } catch (zerr: any) {
            throw new Error(`ZIP_CORRUPTED: Falha ao descompactar entrada '${fileName}': ${zerr?.message}`);
          }
        } else {
          throw new Error(`UNSUPPORTED_ZIP_COMPRESSION: Método de compressão ${compression} não suportado.`);
        }

        const isDir = fileName.endsWith("/") || fileName.endsWith("\\");
        entries.push({ fileName, data: uncompressedData, isDir });

        offset = dataOffset + compressedSize;
        if ((flags & 0x08) !== 0) {
          offset += 12;
        }
      } else {
        offset++;
      }
    }

    // Processar e Gravar Entradas com Proteção Total contra Zip Slip
    for (const entry of entries) {
      const normalizedName = entry.fileName.replace(/\\/g, "/");

      // 1. Verificação Estrita de Zip Slip no nome relativo da entrada
      if (
        normalizedName.startsWith("/") ||
        normalizedName.includes("../") ||
        normalizedName.includes("..\\") ||
        path.isAbsolute(normalizedName) ||
        /^[a-zA-Z]:/.test(normalizedName)
      ) {
        throw new Error(
          `ZIP_SLIP_DETECTED: A entrada '${entry.fileName}' tenta escapar do diretório de staging.`
        );
      }

      // 2. Validação da resolução do caminho final
      const destPath = path.resolve(resolvedTargetDir, normalizedName);
      if (!destPath.startsWith(resolvedTargetDir + path.sep) && destPath !== resolvedTargetDir) {
        throw new Error(
          `ZIP_SLIP_DETECTED: O caminho final '${destPath}' está fora do diretório permitido '${resolvedTargetDir}'.`
        );
      }

      if (entry.isDir) {
        await fs.mkdir(destPath, { recursive: true });
      } else {
        await fs.mkdir(path.dirname(destPath), { recursive: true });
        await fs.writeFile(destPath, entry.data);
      }
    }
  }

  /**
   * Valida se as pastas bin e executáveis declarados no descriptor existem na pasta de staging.
   */
  private validateStructure(
    stagingDir: string,
    binDirs: string[],
    executables: RuntimeExecutable[]
  ): void {
    for (const relBin of binDirs) {
      const fullBinDir = path.resolve(stagingDir, relBin);
      if (!fsSync.existsSync(fullBinDir) || !fsSync.statSync(fullBinDir).isDirectory()) {
        throw new Error(
          `INVALID_RUNTIME_STRUCTURE: O diretório de binários declarado '${relBin}' não existe em staging.`
        );
      }
    }

    for (const exe of executables) {
      const fullExePath = path.resolve(stagingDir, exe.relativePath);
      if (!fsSync.existsSync(fullExePath) || !fsSync.statSync(fullExePath).isFile()) {
        throw new Error(
          `INVALID_RUNTIME_STRUCTURE: O executável declarado '${exe.relativePath}' não foi encontrado em staging.`
        );
      }
    }
  }

  private async calculateDirectorySize(dirPath: string): Promise<number> {
    let total = 0;
    try {
      const items = await fs.readdir(dirPath, { withFileTypes: true });
      for (const item of items) {
        const full = path.join(dirPath, item.name);
        if (item.isDirectory()) {
          total += await this.calculateDirectorySize(full);
        } else if (item.isFile()) {
          const stat = await fs.stat(full);
          total += stat.size;
        }
      }
    } catch {}
    return total;
  }

  private async cleanupDirectory(dirPath: string): Promise<void> {
    try {
      if (fsSync.existsSync(dirPath)) {
        await fs.rm(dirPath, { recursive: true, force: true });
      }
    } catch {}
  }
}
