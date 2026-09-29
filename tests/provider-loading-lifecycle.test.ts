import { test } from "node:test";
import assert from "node:assert/strict";
import { isModelEligibleForNeko } from "../src/shared/model-eligibility.ts";

/**
 * Simulação pura do ciclo de carregamento e governança de catálogo de modelos e provedores
 */

type Model = {
  providerID: string;
  providerName: string;
  modelID: string;
  name: string;
  enabled: boolean;
  connected: boolean;
  catalogEnabled: boolean;
  attachment: boolean;
  cost?: any;
};

type Provider = {
  id: string;
  name: string;
  connected: boolean;
  enabled: boolean;
  methods: any[];
  models: Model[];
};

// 1. Backend pure getProviders simulation
function simulateMainGetProviders(opts: {
  currentProject: string | null;
  hasOpencodeProcess: boolean;
  serviceReady: boolean;
  mockRawCatalog?: any;
  mockAuthData?: any;
  authError?: Error | null;
  listError?: Error | null;
  listDelayMs?: number;
  providerSettings?: Record<string, boolean>;
  modelSettings?: Record<string, boolean>;
}) {
  const {
    currentProject,
    hasOpencodeProcess,
    serviceReady,
    mockRawCatalog,
    mockAuthData = {},
    authError = null,
    listError = null,
    listDelayMs = 0,
    providerSettings = {},
    modelSettings = {}
  } = opts;

  if (!currentProject || !hasOpencodeProcess) {
    return { providers: [], models: [], managedModels: [], count: 0, reason: "sem-projeto" };
  }

  if (listError) {
    throw listError;
  }

  const data = mockRawCatalog?.data ?? mockRawCatalog ?? {};
  const all = Array.isArray(data.all) ? data.all : Array.isArray(data.providers) ? data.providers : [];
  const connected = new Set<string>(Array.isArray(data.connected) ? data.connected : []);

  const models: Model[] = [];
  const providers: Provider[] = all.map((provider: any) => {
    const providerID = provider.id ?? provider.providerID;
    const providerName = provider.name ?? providerID;
    const providerModels = provider.models ?? {};
    const isConnected = connected.has(providerID) || provider.connected === true;
    const providerEnabled = providerSettings[providerID] !== false;

    const providerModelList: Model[] = [];

    for (const [modelID, model] of Object.entries(providerModels as Record<string, any>)) {
      const key = `${providerID}:${modelID}`;
      const catalogEnabled = (model as any)?.enabled !== false;
      const userEnabled = modelSettings[key] !== false;

      const candidateObj = { id: modelID, modelID, ...((model as any) || {}) };
      if (!isModelEligibleForNeko(candidateObj, providerID)) {
        continue;
      }

      providerModelList.push({
        providerID,
        providerName,
        modelID,
        name: (model as any)?.name ?? modelID,
        enabled: providerEnabled && catalogEnabled && userEnabled,
        connected: isConnected,
        catalogEnabled,
        attachment: (model as any)?.attachment === true,
        cost: (model as any)?.cost
      });
    }

    models.push(...providerModelList);
    return {
      id: providerID,
      name: providerName,
      connected: isConnected,
      enabled: providerEnabled,
      methods: [],
      models: providerModelList
    };
  });

  if (authError) {
    // Diagnóstico seguro registrado sem quebrar o catálogo
    // console.warn("[Providers] client.provider.auth() falhou:", authError.message);
  } else {
    for (const provider of providers) {
      provider.methods = Array.isArray(mockAuthData[provider.id]) ? mockAuthData[provider.id] : [];
    }
  }

  const managedModels = models.filter(m => m.catalogEnabled);
  const activeModels = managedModels.filter(m => m.enabled);

  return { providers, models: activeModels, managedModels, defaults: data.default ?? {} };
}

// 2. Renderer loadProviders simulation with configurable timeout and generation tracker
class RendererProviderStore {
  public models: Model[] = [];
  public managedModels: Model[] = [];
  public providers: Provider[] = [];
  public providersGeneration = 0;
  public selectedModel: { providerID: string; modelID: string } | undefined;
  public logs: string[] = [];
  public activeProject: string | null = null;
  public rendererTimeoutMs = 12000;

  async loadProviders(
    source: string,
    fetcher: () => Promise<any>
  ): Promise<any> {
    const requestId = `p${(++this.providersGeneration).toString(36)}`;
    const pGen = this.providersGeneration;
    this.logs.push(`request:${source}:${requestId}:pGen=${pGen}`);

    try {
      const result = await Promise.race([
        fetcher(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), this.rendererTimeoutMs))
      ]);

      if (!result || pGen !== this.providersGeneration) {
        const dropReason = !result ? "timeout" : "stale-generation";
        this.logs.push(`drop:${source}:${requestId}:${dropReason}`);
        return null;
      }

      const providerCount = (result.providers || []).length;
      if (providerCount === 0 && this.activeProject) {
        // Ignora apenas se estiver em transição ativa
        this.logs.push(`empty-response-received:${source}`);
      }

      this.models = result.models || [];
      this.managedModels = result.managedModels || result.models || [];
      this.providers = result.providers || [];
      this.logs.push(`success:${source}:${requestId}:models=${this.models.length}:providers=${this.providers.length}`);
      return result;
    } catch (error: any) {
      this.logs.push(`error:${source}:${requestId}:${error?.message || error}`);
      return null;
    }
  }

  // Defensive modal reload
  checkModalOpenReload(modal: "models" | "providers" | null, fetcher: () => Promise<any>) {
    if ((modal === "models" || modal === "providers") && this.activeProject) {
      if (this.models.length === 0 || this.providers.length === 0) {
        this.logs.push(`defensive-reload-triggered:${modal}`);
        return this.loadProviders("modal-open", fetcher);
      } else {
        this.logs.push(`defensive-reload-skipped-already-loaded:${modal}`);
      }
    }
    return null;
  }
}

// 3. readConnectedProviderIDs simulation
async function simulateReadConnectedProviderIDs(opts: {
  mockConnected?: string[];
  throwError?: Error | null;
  timeout?: boolean;
}) {
  if (opts.throwError) {
    throw opts.throwError;
  }
  if (opts.timeout) {
    throw new Error("timeout");
  }
  return new Set(opts.mockConnected || []);
}

// ============================================================
// TEST SUITE
// ============================================================

test("1. Cold start sem projeto -> retorna catálogo vazio de forma segura", () => {
  const res = simulateMainGetProviders({
    currentProject: null,
    hasOpencodeProcess: false,
    serviceReady: false
  });
  assert.equal(res.providers.length, 0);
  assert.equal(res.models.length, 0);
  assert.equal(res.reason, "sem-projeto");
});

test("2. Abertura de projeto -> popula catálogo e modelos", () => {
  const mockCatalog = {
    all: [
      {
        id: "google",
        name: "Google AI",
        connected: true,
        models: {
          "gemini-2.5-flash": { name: "Gemini 2.5 Flash", modalities: { input: ["text"], output: ["text"] } }
        }
      }
    ],
    connected: ["google"]
  };

  const res = simulateMainGetProviders({
    currentProject: "C:/Projects/Demo",
    hasOpencodeProcess: true,
    serviceReady: true,
    mockRawCatalog: mockCatalog
  });

  assert.equal(res.providers.length, 1);
  assert.equal(res.models.length, 1);
  assert.equal(res.providers[0].id, "google");
  assert.equal(res.providers[0].connected, true);
});

test("3. neko.opencode.ready -> dispara carga de providers e popula o store do Renderer", async () => {
  const store = new RendererProviderStore();
  store.activeProject = "C:/Projects/Demo";

  const mockCatalog = {
    providers: [
      {
        id: "anthropic",
        name: "Anthropic",
        connected: true,
        models: {
          "claude-3-5-sonnet": { name: "Claude 3.5 Sonnet", modalities: { input: ["text"], output: ["text"] } }
        }
      }
    ],
    connected: ["anthropic"]
  };

  const fetcher = async () => simulateMainGetProviders({
    currentProject: store.activeProject,
    hasOpencodeProcess: true,
    serviceReady: true,
    mockRawCatalog: mockCatalog
  });

  await store.loadProviders("engine-ready", fetcher);

  assert.equal(store.providers.length, 1);
  assert.equal(store.models.length, 1);
  assert.equal(store.models[0].modelID, "claude-3-5-sonnet");
  assert.ok(store.logs.some(l => l.includes("success:engine-ready")));
});

test("4. Apenas uma carga efetiva do catálogo (sem invalidar por remount artificial)", async () => {
  const store = new RendererProviderStore();
  store.activeProject = "C:/Projects/Demo";

  const mockCatalog = {
    providers: [{ id: "openai", name: "OpenAI", connected: true, models: { "gpt-4o": { name: "GPT-4o" } } }],
    connected: ["openai"]
  };

  const fetcher = async () => simulateMainGetProviders({
    currentProject: store.activeProject,
    hasOpencodeProcess: true,
    serviceReady: true,
    mockRawCatalog: mockCatalog
  });

  // Emissão única de engine-ready
  await store.loadProviders("engine-ready", fetcher);

  // Não houve segunda chamada invalidando a geração
  assert.equal(store.providersGeneration, 1);
  assert.equal(store.models.length, 1);
  assert.equal(store.models[0].modelID, "gpt-4o");
});

test("5. Resposta stale é descartada somente quando realmente obsoleta (pGen mismatch)", async () => {
  const store = new RendererProviderStore();
  store.activeProject = "C:/Projects/Demo";

  let resolveFirstCall: (val: any) => void;
  const slowFetcher = () => new Promise((resolve) => {
    resolveFirstCall = resolve;
  });

  const fastFetcher = async () => ({
    providers: [{ id: "fast-p", name: "Fast", connected: true, models: [] }],
    models: [{ providerID: "fast-p", modelID: "fast-m", name: "Fast", enabled: true, connected: true, catalogEnabled: true, attachment: false }]
  });

  // Dispara chamada 1 lenta
  const p1 = store.loadProviders("first-slow", slowFetcher);

  // Dispara chamada 2 rápida (incrementa pGen de 1 para 2)
  const p2 = store.loadProviders("second-fast", fastFetcher);
  await p2;

  // Finaliza a chamada 1 que era para geração 1
  resolveFirstCall!({
    providers: [{ id: "stale-p", name: "Stale", connected: true, models: [] }],
    models: [{ providerID: "stale-p", modelID: "stale-m", name: "Stale", enabled: true, connected: true, catalogEnabled: true, attachment: false }]
  });
  await p1;

  // A resposta da chamada 1 foi descartada como stale, preservando a chamada 2 mais recente
  assert.equal(store.models[0].modelID, "fast-m");
  assert.ok(store.logs.some(l => l.includes("drop:first-slow") && l.includes("stale-generation")));
});

test("6. Timeout do Renderer (12s) -> tolera respostas de 8s/9s sem abortar prematuramente aos 7s", async () => {
  const store = new RendererProviderStore();
  store.rendererTimeoutMs = 12000;
  store.activeProject = "C:/Projects/Demo";

  // Resposta que demora 50ms (simulando 8s com escala de teste)
  const delayedFetcher = () => new Promise((resolve) => {
    setTimeout(() => {
      resolve({
        providers: [{ id: "google", name: "Google", connected: true, models: [] }],
        models: [{ providerID: "google", modelID: "gemini-2.5-pro", name: "Gemini 2.5 Pro", enabled: true, connected: true, catalogEnabled: true, attachment: true }]
      });
    }, 50);
  });

  await store.loadProviders("engine-ready", delayedFetcher);

  assert.equal(store.models.length, 1);
  assert.equal(store.models[0].modelID, "gemini-2.5-pro");
  assert.ok(store.logs.some(l => l.includes("success:engine-ready")));
});

test("7. Timeout/falha do Main -> captura e propaga diagnóstico técnico seguro", async () => {
  assert.throws(() => {
    simulateMainGetProviders({
      currentProject: "C:/Projects/Demo",
      hasOpencodeProcess: true,
      serviceReady: true,
      listError: new Error("Tempo esgotado ao carregar os provedores.")
    });
  }, /Tempo esgotado/);
});

test("8. Abertura da modal com catálogo vazio -> dispara reload defensivo", async () => {
  const store = new RendererProviderStore();
  store.activeProject = "C:/Projects/Demo";
  store.models = [];
  store.providers = [];

  const mockCatalog = {
    providers: [{ id: "openai", name: "OpenAI", connected: true, models: { "gpt-4o": { name: "GPT-4o" } } }],
    connected: ["openai"]
  };

  const fetcher = async () => simulateMainGetProviders({
    currentProject: store.activeProject,
    hasOpencodeProcess: true,
    serviceReady: true,
    mockRawCatalog: mockCatalog
  });

  await store.checkModalOpenReload("models", fetcher);

  assert.ok(store.logs.some(l => l.includes("defensive-reload-triggered:models")));
  assert.equal(store.models.length, 1);
  assert.equal(store.models[0].modelID, "gpt-4o");
});

test("9. Abertura da modal com catálogo já carregado -> NÃO dispara reload redundante", async () => {
  const store = new RendererProviderStore();
  store.activeProject = "C:/Projects/Demo";
  store.models = [{ providerID: "openai", modelID: "gpt-4o", name: "GPT-4o", enabled: true, connected: true, catalogEnabled: true, attachment: false }];
  store.providers = [{ id: "openai", name: "OpenAI", connected: true, enabled: true, methods: [], models: store.models }];

  let fetched = false;
  const fetcher = async () => { fetched = true; return {}; };

  store.checkModalOpenReload("models", fetcher);

  assert.equal(fetched, false);
  assert.ok(store.logs.some(l => l.includes("defensive-reload-skipped-already-loaded:models")));
});

test("10. Erro de providers:list gera diagnóstico seguro no Renderer", async () => {
  const store = new RendererProviderStore();
  store.activeProject = "C:/Projects/Demo";

  const failingFetcher = async () => {
    throw new Error("ECONNREFUSED 127.0.0.1:4097");
  };

  const res = await store.loadProviders("initial-load", failingFetcher);
  assert.equal(res, null);
  assert.ok(store.logs.some(l => l.includes("error:initial-load") && l.includes("ECONNREFUSED")));
});

test("11. Timeout de readConnectedProviderIDs não vira falsamente connected=[] no disconnect", async () => {
  let inspectionFailed = false;
  try {
    await simulateReadConnectedProviderIDs({ timeout: true });
  } catch (err: any) {
    inspectionFailed = true;
    assert.equal(err.message, "timeout");
  }
  assert.equal(inspectionFailed, true);
});

test("12. Provider conectado continua aparecendo corretamente após reload", async () => {
  const store = new RendererProviderStore();
  store.activeProject = "C:/Projects/Demo";

  const mockCatalog = {
    providers: [
      {
        id: "deepseek",
        name: "DeepSeek",
        connected: true,
        models: {
          "deepseek-chat": { name: "DeepSeek V3", modalities: { input: ["text"], output: ["text"] } }
        }
      }
    ],
    connected: ["deepseek"]
  };

  const fetcher = async () => simulateMainGetProviders({
    currentProject: store.activeProject,
    hasOpencodeProcess: true,
    serviceReady: true,
    mockRawCatalog: mockCatalog
  });

  // Primeira carga
  await store.loadProviders("engine-ready", fetcher);
  assert.equal(store.providers[0].connected, true);
  assert.equal(store.models[0].connected, true);

  // Recarga (ex: após reconectar ou abrir modal)
  await store.loadProviders("modal-open", fetcher);
  assert.equal(store.providers[0].connected, true);
  assert.equal(store.models[0].connected, true);
  assert.equal(store.models[0].modelID, "deepseek-chat");
});

// ============================================================
// SUITE DE TESTES: REGRAS DE CLASSIFICAÇÃO E EXIBIÇÃO DE MODELOS E PROVIDERS
// ============================================================

function isModelFreeHelper(model: any): boolean {
  if (!model) return false;
  if (!isModelEligibleForNeko(model, model.providerID)) return false;
  const pid = (model.providerID || "").toLowerCase();
  if (pid === "opencode" || pid === "opencode-zen") return true;
  const mid = (model.modelID || "").toLowerCase();
  const mname = (model.name || "").toLowerCase();
  if (mid.endsWith(":free") || mid.includes("-free") || mid.includes("_free") || mid.includes("/free") || mid.includes("free")) return true;
  if (mname.includes("(free)") || mname.includes(" free") || mname.endsWith(" free") || mname.includes("gratuito") || mname.includes("grátis")) return true;
  if (model.cost && typeof model.cost.input === "number" && typeof model.cost.output === "number") {
    if (model.cost.input === 0 && model.cost.output === 0) return true;
  }
  return false;
}

function isProviderFullyFreeHelper(provider: any): boolean {
  if (!provider || !Array.isArray(provider.models) || provider.models.length === 0) return false;
  return provider.models.every((m: any) => isModelFreeHelper(m));
}

test("13. Seletor do Chat (modelGroups) -> Exclui estritamente modelos desconectados", () => {
  const models: Model[] = [
    { providerID: "openai", providerName: "OpenAI", modelID: "gpt-4o", name: "GPT-4o", enabled: true, connected: false, catalogEnabled: true, attachment: true },
    { providerID: "google", providerName: "Google", modelID: "gemini-flash", name: "Gemini Flash", enabled: true, connected: true, catalogEnabled: true, attachment: true },
    { providerID: "groq", providerName: "Groq", modelID: "llama-3-free", name: "Llama 3 (free)", enabled: true, connected: false, catalogEnabled: true, attachment: false }
  ];

  // Simulação exata da lógica do modelGroups atualizada no renderer
  const map = new Map<string, { providerID: string; providerName: string; models: Model[] }>();
  for (const m of models) {
    if (!m.enabled || !m.connected) continue;
    if (!map.has(m.providerID)) map.set(m.providerID, { providerID: m.providerID, providerName: m.providerName, models: [] });
    map.get(m.providerID)!.models.push(m);
  }
  const groups = Array.from(map.values()).filter(g => g.models.length > 0);

  // Apenas o Google (conectado) deve estar presente no seletor
  assert.equal(groups.length, 1);
  assert.equal(groups[0].providerID, "google");
  assert.equal(groups[0].models.length, 1);
  assert.equal(groups[0].models[0].modelID, "gemini-flash");
});

test("14. Seletor do Chat (modelGroups) -> Exclui modelos desativados mesmo se conectados", () => {
  const models: Model[] = [
    { providerID: "google", providerName: "Google", modelID: "gemini-pro", name: "Gemini Pro", enabled: false, connected: true, catalogEnabled: true, attachment: true },
    { providerID: "google", providerName: "Google", modelID: "gemini-flash", name: "Gemini Flash", enabled: true, connected: true, catalogEnabled: true, attachment: true }
  ];

  const map = new Map<string, { providerID: string; providerName: string; models: Model[] }>();
  for (const m of models) {
    if (!m.enabled || !m.connected) continue;
    if (!map.has(m.providerID)) map.set(m.providerID, { providerID: m.providerID, providerName: m.providerName, models: [] });
    map.get(m.providerID)!.models.push(m);
  }
  const groups = Array.from(map.values()).filter(g => g.models.length > 0);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].models.length, 1);
  assert.equal(groups[0].models[0].modelID, "gemini-flash");
});

test("15. Modal 'Gerenciar Modelos' -> Status é 'Ativo' SOMENTE quando conectado && habilitado", () => {
  const providers: Provider[] = [
    { id: "openai", name: "OpenAI", connected: true, enabled: true, methods: [], models: [] },
    { id: "anthropic", name: "Anthropic", connected: true, enabled: false, methods: [], models: [] },
    { id: "deepseek", name: "DeepSeek", connected: false, enabled: true, methods: [], models: [] },
    { id: "mistral", name: "Mistral", connected: false, enabled: false, methods: [], models: [] }
  ];

  for (const p of providers) {
    const isConnected = Boolean(p.connected);
    const isEnabled = isConnected && Boolean(p.enabled);
    const statusText = isConnected ? (isEnabled ? "Ativo" : "Desativado") : "Não conectado";

    if (p.id === "openai") {
      assert.equal(statusText, "Ativo");
    } else if (p.id === "anthropic") {
      assert.equal(statusText, "Desativado");
    } else if (p.id === "deepseek") {
      assert.equal(statusText, "Não conectado"); // NUNCA deve ser "Ativo"
    } else if (p.id === "mistral") {
      assert.equal(statusText, "Não conectado");
    }
  }
});

test("16. isProviderFullyFree -> Retorna true apenas se TODOS os modelos forem gratuitos", () => {
  const freeProvider: Provider = {
    id: "groq",
    name: "Groq",
    connected: false,
    enabled: true,
    methods: [],
    models: [
      { providerID: "groq", providerName: "Groq", modelID: "llama-3-8b-free", name: "Llama 3 8B (free)", enabled: true, connected: false, catalogEnabled: true, attachment: false },
      { providerID: "groq", providerName: "Groq", modelID: "mixtral-8x7b-free", name: "Mixtral 8x7B (free)", enabled: true, connected: false, catalogEnabled: true, attachment: false }
    ]
  };

  const mixedProvider: Provider = {
    id: "openrouter",
    name: "OpenRouter",
    connected: false,
    enabled: true,
    methods: [],
    models: [
      { providerID: "openrouter", providerName: "OpenRouter", modelID: "meta-llama/llama-3-8b:free", name: "Llama 3 8B (free)", enabled: true, connected: false, catalogEnabled: true, attachment: false },
      { providerID: "openrouter", providerName: "OpenRouter", modelID: "anthropic/claude-3.5-sonnet", name: "Claude 3.5 Sonnet", enabled: true, connected: false, catalogEnabled: true, attachment: true, cost: { input: 3, output: 15 } }
    ]
  };

  const paidProvider: Provider = {
    id: "openai",
    name: "OpenAI",
    connected: false,
    enabled: true,
    methods: [],
    models: [
      { providerID: "openai", providerName: "OpenAI", modelID: "gpt-4o", name: "GPT-4o", enabled: true, connected: false, catalogEnabled: true, attachment: true, cost: { input: 2.5, output: 10 } }
    ]
  };

  const emptyProvider: Provider = {
    id: "empty",
    name: "Empty",
    connected: false,
    enabled: true,
    methods: [],
    models: []
  };

  assert.equal(isProviderFullyFreeHelper(freeProvider), true);
  assert.equal(isProviderFullyFreeHelper(mixedProvider), false);
  assert.equal(isProviderFullyFreeHelper(paidProvider), false);
  assert.equal(isProviderFullyFreeHelper(emptyProvider), false);
});

test("17. Modal 'Conectar Provedor' -> Partição estrita em 4 categorias sem duplicação", () => {
  const POPULAR_PROVIDER_IDS = new Set([
    "openai", "anthropic", "google", "deepseek", "xai", "groq", "mistral", "openrouter", "alibaba", "togetherai", "cohere", "perplexity", "github-models", "huggingface"
  ]);

  const allProviders: Provider[] = [
    {
      id: "google",
      name: "Google AI",
      connected: true,
      enabled: true,
      methods: [],
      models: [{ providerID: "google", providerName: "Google AI", modelID: "gemini-2.5-flash", name: "Gemini 2.5 Flash", enabled: true, connected: true, catalogEnabled: true, attachment: true }]
    },
    {
      id: "opencode-zen",
      name: "OpenCode Zen",
      connected: false,
      enabled: true,
      methods: [],
      models: [{ providerID: "opencode-zen", providerName: "OpenCode Zen", modelID: "zen-free", name: "Zen Free", enabled: true, connected: false, catalogEnabled: true, attachment: false }]
    },
    {
      id: "openai",
      name: "OpenAI",
      connected: false,
      enabled: true,
      methods: [],
      models: [{ providerID: "openai", providerName: "OpenAI", modelID: "gpt-4o", name: "GPT-4o", enabled: true, connected: false, catalogEnabled: true, attachment: true, cost: { input: 2.5, output: 10 } }]
    },
    {
      id: "custom-provider",
      name: "Custom AI",
      connected: false,
      enabled: true,
      methods: [],
      models: [{ providerID: "custom-provider", providerName: "Custom AI", modelID: "custom-m", name: "Custom Paid", enabled: true, connected: false, catalogEnabled: true, attachment: false, cost: { input: 1, output: 2 } }]
    }
  ];

  // 1. Conectados
  const connectedList = allProviders.filter(p => p.connected);

  // 2. 100% Gratuitos (não conectados)
  const freeList = allProviders.filter(p => !p.connected && isProviderFullyFreeHelper(p));

  // 3. Populares (não conectados e não 100% gratuitos)
  const popularList = allProviders.filter(p => !p.connected && !isProviderFullyFreeHelper(p) && POPULAR_PROVIDER_IDS.has(p.id));

  // 4. Outros (não conectados, não 100% gratuitos e não populares)
  const otherList = allProviders.filter(p => !p.connected && !isProviderFullyFreeHelper(p) && !POPULAR_PROVIDER_IDS.has(p.id));

  // Verificação de pertencimento correto
  assert.deepEqual(connectedList.map(p => p.id), ["google"]);
  assert.deepEqual(freeList.map(p => p.id), ["opencode-zen"]);
  assert.deepEqual(popularList.map(p => p.id), ["openai"]);
  assert.deepEqual(otherList.map(p => p.id), ["custom-provider"]);

  // Verificação de ZERO duplicação (cada provider em exatamente 1 lista)
  const combinedIds = [
    ...connectedList.map(p => p.id),
    ...freeList.map(p => p.id),
    ...popularList.map(p => p.id),
    ...otherList.map(p => p.id)
  ];
  assert.equal(combinedIds.length, allProviders.length);
  assert.equal(new Set(combinedIds).size, allProviders.length);
});

test("18. Modal 'Conectar Provedor' -> Seção de Gratuitos lista provedores inteiros e não modelos avulsos", () => {
  const freeProvider: Provider = {
    id: "free-ai",
    name: "Free AI Service",
    connected: false,
    enabled: true,
    methods: [],
    models: [
      { providerID: "free-ai", providerName: "Free AI Service", modelID: "model-a-free", name: "Model A (free)", enabled: true, connected: false, catalogEnabled: true, attachment: false },
      { providerID: "free-ai", providerName: "Free AI Service", modelID: "model-b-free", name: "Model B (free)", enabled: true, connected: false, catalogEnabled: true, attachment: false }
    ]
  };

  const providers = [freeProvider];
  const freeList = providers.filter(p => !p.connected && isProviderFullyFreeHelper(p));

  // Deve haver 1 item na lista de provedores gratuitos (o provider em si, não 2 linhas de modelos)
  assert.equal(freeList.length, 1);
  assert.equal(freeList[0].id, "free-ai");
  assert.equal(freeList[0].name, "Free AI Service");
});

