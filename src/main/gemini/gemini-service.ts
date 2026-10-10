// src/main/gemini/gemini-service.ts
// Serviço para requisições diretas à API oficial do Google Gemini utilizando a chave própria do usuário

import { GeminiVault, geminiVault as defaultVault } from "./gemini-vault";
import { sanitizeErrorMessage } from "../../shared/error-extractor";

export const SYSTEM_ENHANCE_PROMPT = `Você é um especialista em engenharia de prompt para agentes de desenvolvimento de software.
Sua única função é transformar o pedido do usuário em uma instrução clara, precisa e diretamente executável.

Regras obrigatórias:
1. Preserve integralmente a intenção, tecnologias, escopo e idioma do usuário.
2. Seja conciso, direto e objetivo. Não seja prolixo e não adicione explicações ou comentários.
3. Não invente requisitos desnecessários.
4. Preserve nomes de arquivos, caminhos, funções, APIs, variáveis e trechos de código.
5. Não responda como assistente nem adicione saudações ou preâmbulos.
6. Retorne ESTRITAMENTE o prompt melhorado. Nada mais.`;

export const SYSTEM_AUDIO_PROMPT = `Você é um transcritor de áudio em tempo real especializado em ambiente de desenvolvimento de software em português brasileiro.
Sua função é transcrever exatamente o que o usuário falou, transformando a fala em texto para o campo de prompt.

Regras obrigatórias:
1. Transcreva em português brasileiro correto com pontuação e acentuação naturais.
2. Reconheça e preserve jargões e termos técnicos de tecnologia e programação (por exemplo: React, TypeScript, Tailwind, CSS, HTML, Vite, Next.js, API, endpoint, bug, hook, state, Docker, Supabase, Git, commit, branch, etc.).
3. Não adicione saudações, explicações, comentários, aspas extras ou introduções (não diga "Você disse:", "Aqui está a transcrição:").
4. Se o áudio estiver completamente silencioso, inaudível ou sem palavras identificáveis, responda exatamente com a palavra VAZIO.
5. Retorne SOMENTE o texto transcrito. Nada mais.`;

// Modelos oficiais do catálogo Google AI Studio (Free Tier)
// Ordenados estritamente por eficiência e performance para cada tipo de tarefa:

// Tarefa: MELHORAR PROMPT (Texto puro, reescrita de prompt com mínima latência)
// 1. gemini-3.5-flash-lite: Menor latência possível, otimizado para tarefas de texto e alto throughput
// 2. gemini-3.1-flash-lite: Variante leve de altíssima velocidade
// 3. gemini-3.5-flash: Modelo de referência em estabilidade e velocidade na conta gratuita
// 4. gemini-3.8-flash: Modelo de ponta com raciocínio (executado com thinkingLevel: "MINIMAL" para resposta instantânea)
// 5. gemini-3.7-flash, gemini-3.6-flash: Versões intermediárias da família Gemini 3
// 6. gemini-2.5-flash, gemini-2.0-flash: Fallbacks de compatibilidade para contas com modelos legados
export const GEMINI_TEXT_MODELS = [
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-3.5-flash",
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-2.5-flash",
  "gemini-2.0-flash",
] as const;

// Tarefa: TRANSCREVER ÁUDIOS (Prompt por Voz, multimodal áudio WebM -> texto em pt-BR)
// 1. gemini-3.5-flash: O modelo mais veloz e confiável comprovado em transcrição multimodal de áudio
// 2. gemini-3.8-flash: Modelo multimodal de ponta (executado com thinkingLevel: "MINIMAL")
// 3. gemini-3.5-flash-lite: Variante leve multimodal
// 4. gemini-3.1-flash-lite: Variante de áudio rápida
// 5. gemini-3.7-flash, gemini-3.6-flash: Versões intermediárias da família Gemini 3
// 6. gemini-2.5-flash, gemini-2.0-flash: Fallbacks de compatibilidade
export const GEMINI_AUDIO_MODELS = [
  "gemini-3.5-flash",
  "gemini-3.8-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-2.5-flash",
  "gemini-2.0-flash",
] as const;

export interface EnhancePromptResult {
  success: boolean;
  improvedPrompt?: string;
  error?: string;
  cancelled?: boolean;
}

export interface TranscribeAudioResult {
  success: boolean;
  text?: string;
  error?: string;
}

export interface TestKeyResult {
  success: boolean;
  message?: string;
  error?: string;
}

export class GeminiService {
  private vault: GeminiVault;
  private fetchImpl: typeof fetch;
  private activeEnhanceControllers = new Map<string, AbortController>();
  private preferredTextModel: string = "gemini-3.5-flash";
  private preferredAudioModel: string = "gemini-3.5-flash";
  private discoveredModels: Set<string> | null = null;

  constructor(vault?: GeminiVault, customFetch?: typeof fetch) {
    this.vault = vault || defaultVault;
    this.fetchImpl = customFetch || globalThis.fetch;
  }

  /**
   * Ordena os modelos priorizando o último modelo que respondeu com sucesso (sticky model cache)
   * e filtrando por modelos conhecidamente suportados pela conta caso já descobertos.
   */
  private getOrderedModels(models: readonly string[], preferred?: string): string[] {
    let candidateList = [...models];
    if (this.discoveredModels && this.discoveredModels.size > 0) {
      const filtered = candidateList.filter(m => this.discoveredModels!.has(m));
      if (filtered.length > 0) {
        candidateList = filtered;
      }
    }
    if (preferred && candidateList.includes(preferred)) {
      return [preferred, ...candidateList.filter(m => m !== preferred)];
    }
    return candidateList;
  }

  /**
   * Normaliza mensagens de erro do Google Gemini para português amigável e seguro,
   * garantindo que nenhuma chave ou detalhe confidencial seja vazado.
   */
  private normalizeGeminiError(status: number, errBody: string): string {
    const sanitizedBody = sanitizeErrorMessage(errBody || "");

    if (status === 401 || status === 403 || /API_KEY_INVALID|PERMISSION_DENIED|unauthorized|forbidden/i.test(sanitizedBody)) {
      return "A chave informada não foi aceita pelo Google. Verifique a chave e tente novamente.";
    }

    if (status === 429 || /RESOURCE_EXHAUSTED|rate limit|quota/i.test(sanitizedBody)) {
      return "O Google Gemini informou que a cota ou o limite de requisições foi atingido. Verifique os limites da sua chave no Google AI Studio.";
    }

    if (status === 404 || /NOT_FOUND|model not found/i.test(sanitizedBody)) {
      return "O modelo solicitado não está disponível na sua conta do Google Gemini.";
    }

    if (status >= 500) {
      return "O serviço do Google Gemini está temporariamente instável. Tente novamente em instantes.";
    }

    if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|Failed to fetch|NetworkError/i.test(sanitizedBody)) {
      return "Não foi possível conectar ao Google Gemini. Verifique sua conexão e tente novamente.";
    }

    return "Não foi possível processar a requisição com o Google Gemini. Tente novamente.";
  }

  /**
   * Constrói a configuração de geração otimizada para máxima velocidade e mínima latência.
   * Em modelos Gemini 3 (como 3.8 e 3.5), define thinkingLevel como "MINIMAL" para eliminar
   * o tempo ocioso gasto gerando centenas de tokens invisíveis de raciocínio interno.
   */
  private buildGenerationConfig(model: string, temperature: number, maxOutputTokens: number, withThinking: boolean = true) {
    const config: Record<string, any> = {
      temperature,
      maxOutputTokens,
    };
    if (withThinking && model.startsWith("gemini-3")) {
      config.thinkingConfig = {
        thinkingLevel: "MINIMAL",
      };
    }
    return config;
  }

  /**
   * Valida uma chave de API através de uma chamada real de teste ao endpoint generateContent
   * utilizando a cascata de modelos suportados para máxima compatibilidade.
   * Não salva a chave caso seja uma candidateKey temporária.
   */
  public async testKey(candidateKey?: string): Promise<TestKeyResult> {
    const rawKey = candidateKey !== undefined ? candidateKey : await this.vault.getKey();
    const apiKey = (rawKey || "").trim();

    if (!apiKey) {
      return {
        success: false,
        error: "Nenhuma chave Gemini informada ou configurada.",
      };
    }

    let lastError = "";
    const modelsToTry = this.getOrderedModels(GEMINI_TEXT_MODELS, this.preferredTextModel);

    for (const model of modelsToTry) {
      try {
        const testUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
        const res = await this.fetchImpl(testUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey,
          },
          body: JSON.stringify({
            contents: [
              {
                parts: [{ text: "ping" }],
              },
            ],
            generationConfig: {
              maxOutputTokens: 5,
            },
          }),
        });

        if (res.ok) {
          this.preferredTextModel = model;
          if (this.discoveredModels) {
            this.discoveredModels.add(model);
          } else {
            this.discoveredModels = new Set([model]);
          }
          return {
            success: true,
            message: "Chave validada com sucesso pelo Google Gemini!",
          };
        }

        const errText = await res.text().catch(() => "");
        lastError = this.normalizeGeminiError(res.status, errText);

        // Se o erro for de autenticação ou cota, encerra imediatamente
        if (res.status === 401 || res.status === 403 || res.status === 429) {
          return {
            success: false,
            error: lastError,
          };
        }
        // Se for 404 (modelo não disponível), tenta o próximo modelo na cascata
        continue;
      } catch (err: any) {
        const sanitized = sanitizeErrorMessage(err?.message || String(err));
        lastError = this.normalizeGeminiError(0, sanitized);
        continue;
      }
    }

    return {
      success: false,
      error: lastError || "Não foi possível validar a chave com os modelos do Google Gemini.",
    };
  }

  /**
   * Melhora um prompt de texto utilizando a chave do próprio usuário configurada no vault.
   * Suporta cancelamento limpo e imediato via AbortSignal e operationId.
   * Otimizado para máxima velocidade com failover inteligente e sticky model cache.
   * NUNCA utiliza chave compartilhada nem Edge Functions.
   */
  public async enhancePrompt(prompt: string, operationId?: string): Promise<EnhancePromptResult> {
    const opId = operationId || `enhance-${Date.now()}`;
    const controller = new AbortController();
    this.activeEnhanceControllers.set(opId, controller);

    try {
      if (controller.signal.aborted) {
        return { success: false, error: "Cancelado pelo usuário.", cancelled: true };
      }

      const apiKey = await this.vault.getKey();
      if (controller.signal.aborted) {
        return { success: false, error: "Cancelado pelo usuário.", cancelled: true };
      }

      if (!apiKey) {
        return {
          success: false,
          error: "Configure sua chave Google Gemini para utilizar este recurso.",
        };
      }

      const trimmedPrompt = (prompt || "").trim();
      if (!trimmedPrompt) {
        return {
          success: false,
          error: "O prompt a ser melhorado não pode estar vazio.",
        };
      }

      let lastStatus = 0;
      let lastError = "";
      const modelsToTry = this.getOrderedModels(GEMINI_TEXT_MODELS, this.preferredTextModel);

      for (const model of modelsToTry) {
        if (controller.signal.aborted) {
          return { success: false, error: "Cancelado pelo usuário.", cancelled: true };
        }

        // Timeout individual de 8 segundos por tentativa para failover rápido caso a API engasgue
        const modelTimeoutController = new AbortController();
        const timeoutTimer = setTimeout(() => modelTimeoutController.abort(), 8000);
        const onAbort = () => modelTimeoutController.abort();
        controller.signal.addEventListener("abort", onAbort, { once: true });

        try {
          const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

          const buildBody = (withThinking: boolean) =>
            JSON.stringify({
              system_instruction: {
                parts: [{ text: SYSTEM_ENHANCE_PROMPT }],
              },
              contents: [
                {
                  parts: [{ text: trimmedPrompt }],
                },
              ],
              generationConfig: this.buildGenerationConfig(model, 0.2, 1024, withThinking),
            });

          let res = await this.fetchImpl(url, {
            method: "POST",
            signal: modelTimeoutController.signal,
            headers: {
              "Content-Type": "application/json",
              "x-goog-api-key": apiKey,
            },
            body: buildBody(true),
          });

          // Se o modelo retornar 400 por causa de thinkingConfig, tenta imediatamente sem thinkingConfig
          if (!res.ok && res.status === 400) {
            const errBody = await res.text().catch(() => "");
            if (errBody.toLowerCase().includes("thinkingconfig")) {
              res = await this.fetchImpl(url, {
                method: "POST",
                signal: modelTimeoutController.signal,
                headers: {
                  "Content-Type": "application/json",
                  "x-goog-api-key": apiKey,
                },
                body: buildBody(false),
              });
            } else {
              lastStatus = res.status;
              lastError = this.normalizeGeminiError(res.status, errBody);
              clearTimeout(timeoutTimer);
              controller.signal.removeEventListener("abort", onAbort);
              continue;
            }
          }

          clearTimeout(timeoutTimer);
          controller.signal.removeEventListener("abort", onAbort);

          if (controller.signal.aborted) {
            return { success: false, error: "Cancelado pelo usuário.", cancelled: true };
          }

          if (!res.ok) {
            const errBody = await res.text().catch(() => "");
            lastStatus = res.status;
            lastError = this.normalizeGeminiError(res.status, errBody);

            // Se o erro for de autenticação ou quota, não adianta testar outros modelos com a mesma chave
            if (res.status === 401 || res.status === 403 || res.status === 429) {
              return { success: false, error: lastError };
            }
            continue;
          }

          const data: any = await res.json();
          const candidate = data?.candidates?.[0]?.content?.parts?.[0]?.text;

          if (typeof candidate === "string" && candidate.trim()) {
            this.preferredTextModel = model;
            if (this.discoveredModels) this.discoveredModels.add(model);
            return {
              success: true,
              improvedPrompt: candidate.trim(),
            };
          }
        } catch (err: any) {
          clearTimeout(timeoutTimer);
          controller.signal.removeEventListener("abort", onAbort);

          if (controller.signal.aborted || (err?.name === "AbortError" && controller.signal.aborted)) {
            return { success: false, error: "Cancelado pelo usuário.", cancelled: true };
          }
          lastStatus = 0;
          lastError = this.normalizeGeminiError(0, err?.message || String(err));
          continue;
        }
      }

      return {
        success: false,
        error: lastError || "Não foi possível melhorar o prompt com os modelos disponíveis.",
      };
    } finally {
      this.activeEnhanceControllers.delete(opId);
    }
  }

  /**
   * Cancela uma operação ativa de melhoria de prompt de forma imediata.
   */
  public cancelEnhancePrompt(operationId?: string): boolean {
    if (operationId && this.activeEnhanceControllers.has(operationId)) {
      const controller = this.activeEnhanceControllers.get(operationId);
      controller?.abort();
      this.activeEnhanceControllers.delete(operationId);
      return true;
    }
    if (!operationId && this.activeEnhanceControllers.size > 0) {
      for (const controller of this.activeEnhanceControllers.values()) {
        controller.abort();
      }
      this.activeEnhanceControllers.clear();
      return true;
    }
    return false;
  }

  /**
   * Transcreve áudio gravado localmente utilizando a chave do próprio usuário configurada no vault.
   * NUNCA utiliza chave compartilhada nem Edge Functions.
   */
  public async transcribeAudio(payload: { audioBase64: string; mimeType: string }): Promise<TranscribeAudioResult> {
    const apiKey = await this.vault.getKey();
    if (!apiKey) {
      return {
        success: false,
        error: "Configure sua chave Google Gemini para utilizar este recurso.",
      };
    }

    const audioBase64 = payload?.audioBase64 || "";
    if (!audioBase64) {
      return {
        success: false,
        error: "Nenhum dado de áudio foi gravado.",
      };
    }

    const mimeType = payload?.mimeType || "audio/webm";
    let lastStatus = 0;
    let lastError = "";

    const modelsToTry = this.getOrderedModels(GEMINI_AUDIO_MODELS, this.preferredAudioModel);

    for (const model of modelsToTry) {
      const modelTimeoutController = new AbortController();
      const timeoutTimer = setTimeout(() => modelTimeoutController.abort(), 12000);

      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

        const buildAudioBody = (withThinking: boolean) =>
          JSON.stringify({
            system_instruction: {
              parts: [{ text: SYSTEM_AUDIO_PROMPT }],
            },
            contents: [
              {
                parts: [
                  {
                    inline_data: {
                      mime_type: mimeType,
                      data: audioBase64,
                    },
                  },
                  {
                    text: "Transcreva este áudio com máxima exatidão em português brasileiro, preservando termos de desenvolvimento de software.",
                  },
                ],
              },
            ],
            generationConfig: this.buildGenerationConfig(model, 0.1, 1024, withThinking),
          });

        let res = await this.fetchImpl(url, {
          method: "POST",
          signal: modelTimeoutController.signal,
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey,
          },
          body: buildAudioBody(true),
        });

        if (!res.ok && res.status === 400) {
          const errBody = await res.text().catch(() => "");
          if (errBody.toLowerCase().includes("thinkingconfig")) {
            res = await this.fetchImpl(url, {
              method: "POST",
              signal: modelTimeoutController.signal,
              headers: {
                "Content-Type": "application/json",
                "x-goog-api-key": apiKey,
              },
              body: buildAudioBody(false),
            });
          } else {
            lastStatus = res.status;
            lastError = this.normalizeGeminiError(res.status, errBody);
            clearTimeout(timeoutTimer);
            continue;
          }
        }

        clearTimeout(timeoutTimer);

        if (!res.ok) {
          const errBody = await res.text().catch(() => "");
          lastStatus = res.status;
          lastError = this.normalizeGeminiError(res.status, errBody);

          // Se a chave for inválida ou atingir cota, encerra imediatamente
          if (res.status === 401 || res.status === 403 || res.status === 429) {
            return { success: false, error: lastError };
          }
          continue;
        }

        const data: any = await res.json();
        const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;

        if (typeof rawText === "string") {
          this.preferredAudioModel = model;
          if (this.discoveredModels) this.discoveredModels.add(model);
          const cleanText = rawText.trim();
          if (cleanText === "VAZIO" || cleanText === "VAZIO." || cleanText === "[VAZIO]") {
            return { success: true, text: "" };
          }
          return { success: true, text: cleanText };
        }
      } catch (err: any) {
        clearTimeout(timeoutTimer);
        lastStatus = 0;
        lastError = this.normalizeGeminiError(0, err?.message || String(err));
        continue;
      }
    }

    return {
      success: false,
      error: lastError || "Não foi possível transcrever o áudio gravado.",
    };
  }
}

export const geminiService = new GeminiService();
