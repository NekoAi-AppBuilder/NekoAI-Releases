import { test } from "node:test";
import assert from "node:assert/strict";
import { isModelEligibleForNeko } from "../src/shared/model-eligibility.ts";

/**
 * Função pura equivalente à lógica de getProviders() em src/main/main.ts
 */
function processCatalogData(rawProviderListResult: any, userDisabledSettings: Record<string, boolean> = {}, userProviderSettings: Record<string, boolean> = {}) {
  const data = rawProviderListResult?.data ?? rawProviderListResult ?? {};
  const all = Array.isArray(data.all) ? data.all : Array.isArray(data.providers) ? data.providers : [];
  const connectedSet = new Set<string>(Array.isArray(data.connected) ? data.connected : []);

  const models: any[] = [];
  const providers = all.filter(Boolean).map((provider: any) => {
    const providerID = provider.id ?? provider.providerID;
    const providerName = provider.name ?? providerID;
    const providerModels = provider.models ?? {};
    const isConnected = connectedSet.has(providerID) || provider.connected === true;
    const providerEnabled = userProviderSettings[providerID] !== false;

    const providerModelList: any[] = [];

    for (const [modelID, model] of Object.entries(providerModels as Record<string, any>)) {
      const key = `${providerID}:${modelID}`;
      const catalogEnabled = (model as any)?.enabled !== false;
      const userEnabled = userDisabledSettings[key] !== false;

      const candidateObj = { id: modelID, modelID, ...((model as any) || {}) };
      const eligible = isModelEligibleForNeko(candidateObj, providerID);
      if (!eligible) {
        continue;
      }

      providerModelList.push({
        providerID,
        providerName,
        modelID,
        name: (model as any)?.name ?? modelID,
        variants: (model as any)?.variants && typeof (model as any).variants === "object" ? Object.keys((model as any).variants) : [],
        enabled: providerEnabled && catalogEnabled && userEnabled,
        connected: isConnected,
        catalogEnabled,
        attachment: (model as any)?.attachment === true,
        cost: (model as any)?.cost,
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

  const managedModels = models.filter(m => m.catalogEnabled);
  const activeModels = managedModels.filter(m => m.enabled);

  return { providers, models: activeModels, managedModels };
}

/**
 * Função pura equivalente à construção de modelGroups e managedModelGroups no renderer main.tsx
 */
function buildRendererModelGroups(models: any[]) {
  const map = new Map<string, { providerID: string; providerName: string; models: any[] }>();
  for (const m of models) {
    if (!m.enabled) continue;
    if (!map.has(m.providerID)) map.set(m.providerID, { providerID: m.providerID, providerName: m.providerName, models: [] });
    map.get(m.providerID)!.models.push(m);
  }
  const groups = Array.from(map.values()).filter(g => g.models.length > 0);
  groups.sort((a, b) => {
    const aConn = a.models.some(m => m.connected);
    const bConn = b.models.some(m => m.connected);
    if (aConn && !bConn) return -1;
    if (!aConn && bConn) return 1;
    return 0;
  });
  return groups;
}

test("A. PC limpo / nenhum provider conectado -> modelos elegíveis aparecem no catálogo", () => {
  const mockBackendData = {
    all: [
      {
        id: "openai",
        name: "OpenAI",
        models: {
          "gpt-4o": { name: "GPT-4o", modalities: { input: ["text"], output: ["text"] } },
          "gpt-4o-mini": { name: "GPT-4o Mini", modalities: { input: ["text"], output: ["text"] } }
        }
      },
      {
        id: "anthropic",
        name: "Anthropic",
        models: {
          "claude-3-5-sonnet-20241022": { name: "Claude 3.5 Sonnet", modalities: { input: ["text"], output: ["text"] } }
        }
      }
    ],
    connected: [] // Nenhum provider conectado no PC limpo
  };

  const result = processCatalogData(mockBackendData);
  assert.equal(result.providers.length, 2, "Provedores devem ser retornados");
  assert.equal(result.providers.every(p => p.connected === false), true, "Provedores devem manter connected = false");
  assert.ok(result.models.length >= 3, "Modelos elegíveis não devem desaparecer em PC limpo");
  assert.equal(result.models.every(m => m.connected === false), true, "Modelos devem ter connected = false em PC limpo");

  const rendererGroups = buildRendererModelGroups(result.models);
  assert.equal(rendererGroups.length, 2, "Renderer deve formar grupos para OpenAI e Anthropic");
});

test("B. Provider conectado -> modelo aparece como conectado/utilizável", () => {
  const mockBackendData = {
    all: [
      {
        id: "openai",
        name: "OpenAI",
        models: {
          "gpt-4o": { name: "GPT-4o" }
        }
      }
    ],
    connected: ["openai"]
  };

  const result = processCatalogData(mockBackendData);
  assert.equal(result.providers[0].connected, true);
  assert.equal(result.models[0].connected, true);
});

test("C. Provider não conectado -> modelo aparece como não configurado", () => {
  const mockBackendData = {
    all: [
      {
        id: "openai",
        name: "OpenAI",
        models: {
          "gpt-4o": { name: "GPT-4o" }
        }
      }
    ],
    connected: []
  };

  const result = processCatalogData(mockBackendData);
  const model = result.models[0];
  assert.equal(model.connected, false, "Modelo deve sinalizar connected = false");
  assert.equal(model.enabled, true, "Modelo elegível deve manter enabled = true para visualização");
});

test("D. Modelo fora do catálogo / inelegível (ex: Whisper, Embedding) -> continua excluído", () => {
  const mockBackendData = {
    all: [
      {
        id: "openai",
        name: "OpenAI",
        models: {
          "gpt-4o": { name: "GPT-4o" },
          "whisper-large-v3": { name: "Whisper Audio", modalities: { input: ["audio"], output: ["text"] } },
          "text-embedding-3-small": { name: "Text Embedding 3 Small" }
        }
      }
    ],
    connected: []
  };

  const result = processCatalogData(mockBackendData);
  const ids = result.models.map(m => m.modelID);
  assert.ok(ids.includes("gpt-4o"), "GPT-4o deve ser incluído");
  assert.ok(!ids.includes("whisper-large-v3"), "Whisper deve continuar excluído");
  assert.ok(!ids.includes("text-embedding-3-small"), "Embedding deve continuar excluído");
});

test("E. Modelo explicitamente desabilitado pelo usuário -> respeita o estado disabled", () => {
  const mockBackendData = {
    all: [
      {
        id: "openai",
        name: "OpenAI",
        models: {
          "gpt-4o": { name: "GPT-4o" },
          "gpt-4o-mini": { name: "GPT-4o Mini" }
        }
      }
    ],
    connected: ["openai"]
  };

  const userDisabled = { "openai:gpt-4o-mini": false };
  const result = processCatalogData(mockBackendData, userDisabled);
  
  const gpt4o = result.models.find(m => m.modelID === "gpt-4o");
  const mini = result.models.find(m => m.modelID === "gpt-4o-mini");

  assert.ok(gpt4o, "gpt-4o deve estar ativo");
  assert.equal(mini, undefined, "gpt-4o-mini desativado pelo usuário deve ficar fora de activeModels");
  assert.ok(result.managedModels.some(m => m.modelID === "gpt-4o-mini"), "gpt-4o-mini deve continuar visível em managedModels");
});

test("F. Provider inexistente/inválido ou nulo -> não quebra a lista", () => {
  const mockBackendData = {
    all: [
      null,
      undefined,
      { id: "invalid-without-models" },
      { id: "valid", name: "Valid", models: { "valid-m": { name: "Valid Model" } } }
    ],
    connected: []
  };

  assert.doesNotThrow(() => {
    const result = processCatalogData(mockBackendData);
    assert.ok(result.models.some(m => m.modelID === "valid-m"));
  });
});

test("G. Lista vazia real do backend -> comportamento determinístico", () => {
  const result = processCatalogData({ all: [], connected: [] });
  assert.equal(result.providers.length, 0);
  assert.equal(result.models.length, 0);
  assert.equal(result.managedModels.length, 0);
});

test("H. Nenhuma API Key falsa é criada durante a listagem", () => {
  const mockBackendData = {
    all: [{ id: "openai", name: "OpenAI", models: { "gpt-4o": { name: "GPT-4o" } } }],
    connected: []
  };
  const result = processCatalogData(mockBackendData);
  assert.equal(result.providers[0].connected, false);
  assert.equal(result.models[0].connected, false);
});

test("I. Seleção de modelo não afirma que o provider está conectado quando não está", () => {
  const mockBackendData = {
    all: [{ id: "anthropic", name: "Anthropic", models: { "claude-3-5-sonnet-20241022": { name: "Claude" } } }],
    connected: []
  };
  const result = processCatalogData(mockBackendData);
  const selectedModel = result.models[0];
  
  assert.equal(selectedModel.connected, false, "Estado 'connected' deve ser estritamente false ao selecionar modelo sem credencial");
});

test("J. Teste especial do PC Limpo: providers=[connected=false] NÃO resulta em models=[]", () => {
  const mockBackendData = {
    all: [
      { id: "openai", name: "OpenAI", models: { "gpt-4o": { name: "GPT-4o" } } },
      { id: "anthropic", name: "Anthropic", models: { "claude-3-5-sonnet-20241022": { name: "Claude 3.5 Sonnet" } } }
    ],
    connected: []
  };

  const result = processCatalogData(mockBackendData);
  assert.notEqual(result.models.length, 0, "O resultado NUNCA deve ser models=[] no PC limpo quando o catálogo possui modelos elegíveis");
  assert.equal(result.models.length, 2, "Deve retornar os 2 modelos do catálogo");
});
