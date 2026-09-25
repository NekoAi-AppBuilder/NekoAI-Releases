// tests/last-model-persistence.test.ts
// Testes unitários para a persistência e ciclo de vida do último modelo de IA utilizado no NekoAI.
// Executar com: node --experimental-strip-types --test tests/last-model-persistence.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

interface StoredModel {
  providerID: string;
  modelID: string;
  updatedAt?: number;
}

interface ModelItem {
  providerID: string;
  modelID: string;
  name: string;
  connected: boolean;
  enabled: boolean;
}

interface ProviderCatalogResult {
  providers?: any[];
  models?: ModelItem[];
  managedModels?: ModelItem[];
}

// Implementação das funções puras equivalentes à lógica do renderer em main.tsx
const LAST_MODEL_STORAGE_KEY = "nekoai.lastModel";

class MockLocalStorage {
  private store: Map<string, string> = new Map();

  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }
}

function getSavedInitialModel(storage: MockLocalStorage): { providerID: string; modelID: string } | undefined {
  try {
    const raw = storage.getItem(LAST_MODEL_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (
        parsed &&
        typeof parsed.providerID === "string" &&
        typeof parsed.modelID === "string" &&
        parsed.providerID.trim() &&
        parsed.modelID.trim()
      ) {
        return { providerID: parsed.providerID.trim(), modelID: parsed.modelID.trim() };
      }
    }
  } catch {}
  return undefined;
}

interface ModelSyncState {
  selectedModel: { providerID: string; modelID: string } | undefined;
  modelPickSource: "user" | "restored" | "fallback" | "none";
}

function processProviderCatalogUpdate(
  result: ProviderCatalogResult,
  currentState: ModelSyncState,
  storage: MockLocalStorage
): ModelSyncState {
  const availableModels = (result.models || []).filter((m: ModelItem) => m.connected && m.enabled);
  if (availableModels.length === 0) {
    return currentState;
  }

  let savedModel: { providerID: string; modelID: string } | undefined;
  try {
    const raw = storage.getItem(LAST_MODEL_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (
        parsed &&
        typeof parsed.providerID === "string" &&
        typeof parsed.modelID === "string" &&
        parsed.providerID.trim() &&
        parsed.modelID.trim()
      ) {
        savedModel = { providerID: parsed.providerID.trim(), modelID: parsed.modelID.trim() };
      }
    }
  } catch {}

  const restored = savedModel && availableModels.some((m: ModelItem) =>
    m.providerID === savedModel!.providerID && m.modelID === savedModel!.modelID
  ) ? savedModel : undefined;

  const current = currentState.selectedModel;
  const currentIsAvailable = current && availableModels.some((m: ModelItem) =>
    m.providerID === current!.providerID && m.modelID === current!.modelID
  );
  const userPicked = currentState.modelPickSource === "user";

  const mustRedirect = !currentIsAvailable || (!userPicked && currentState.modelPickSource === "fallback" && Boolean(restored));

  let nextSelected = currentState.selectedModel;
  let nextSource = currentState.modelPickSource;

  if (mustRedirect) {
    let next: { providerID: string; modelID: string } | undefined;
    let source: "restored" | "fallback" | "none" = "none";
    if (restored) {
      next = restored;
      source = "restored";
    } else if (availableModels[0]) {
      next = { providerID: availableModels[0].providerID, modelID: availableModels[0].modelID };
      source = "fallback";
    }
    nextSource = source;
    if (!(next && current && next.providerID === current.providerID && next.modelID === current.modelID)) {
      nextSelected = next;
    }
  }

  return {
    selectedModel: nextSelected,
    modelPickSource: nextSource
  };
}

function handleUserSelectModel(
  selected: { providerID: string; modelID: string },
  storage: MockLocalStorage
): ModelSyncState {
  const nextState: ModelSyncState = {
    selectedModel: selected,
    modelPickSource: "user"
  };
  storage.setItem(LAST_MODEL_STORAGE_KEY, JSON.stringify({
    providerID: selected.providerID,
    modelID: selected.modelID,
    updatedAt: Date.now()
  }));
  return nextState;
}

// -------------------------------------------------------------
// Cenários de Teste
// -------------------------------------------------------------

test("1: Startup com catálogo vazio (initial-load) não apaga o modelo salvo no localStorage", () => {
  const storage = new MockLocalStorage();
  storage.setItem(LAST_MODEL_STORAGE_KEY, JSON.stringify({
    providerID: "anthropic",
    modelID: "claude-3-5-sonnet-20241022"
  }));

  const initialModel = getSavedInitialModel(storage);
  assert.deepEqual(initialModel, {
    providerID: "anthropic",
    modelID: "claude-3-5-sonnet-20241022"
  });

  const state: ModelSyncState = {
    selectedModel: initialModel,
    modelPickSource: initialModel ? "restored" : "none"
  };

  // Simula loadProviders("initial-load") com catálogo vazio
  const updatedState = processProviderCatalogUpdate({ models: [], providers: [] }, state, storage);

  // O estado não deve ser alterado e o localStorage NÃO pode ter sido apagado
  assert.deepEqual(updatedState.selectedModel, {
    providerID: "anthropic",
    modelID: "claude-3-5-sonnet-20241022"
  });
  assert.equal(storage.getItem(LAST_MODEL_STORAGE_KEY) !== null, true);
  const stored = JSON.parse(storage.getItem(LAST_MODEL_STORAGE_KEY)!);
  assert.equal(stored.providerID, "anthropic");
  assert.equal(stored.modelID, "claude-3-5-sonnet-20241022");
});

test("2: Catálogo pronto restaura modelo salvo quando disponível e elegível", () => {
  const storage = new MockLocalStorage();
  storage.setItem(LAST_MODEL_STORAGE_KEY, JSON.stringify({
    providerID: "anthropic",
    modelID: "claude-3-5-sonnet-20241022"
  }));

  const initialModel = getSavedInitialModel(storage);
  const state: ModelSyncState = {
    selectedModel: initialModel,
    modelPickSource: initialModel ? "restored" : "none"
  };

  const catalog: ProviderCatalogResult = {
    models: [
      { providerID: "openai", modelID: "gpt-4o", name: "GPT-4o", connected: true, enabled: true },
      { providerID: "anthropic", modelID: "claude-3-5-sonnet-20241022", name: "Claude 3.5 Sonnet", connected: true, enabled: true }
    ]
  };

  const updatedState = processProviderCatalogUpdate(catalog, state, storage);

  assert.deepEqual(updatedState.selectedModel, {
    providerID: "anthropic",
    modelID: "claude-3-5-sonnet-20241022"
  });
  assert.equal(updatedState.modelPickSource, "restored");
});

test("3: Fallback em memória NÃO sobrescreve a preferência salva no localStorage", () => {
  const storage = new MockLocalStorage();
  storage.setItem(LAST_MODEL_STORAGE_KEY, JSON.stringify({
    providerID: "anthropic",
    modelID: "claude-3-5-sonnet-20241022"
  }));

  const initialModel = getSavedInitialModel(storage);
  const state: ModelSyncState = {
    selectedModel: initialModel,
    modelPickSource: initialModel ? "restored" : "none"
  };

  // Catálogo não possui Anthropic conectado no momento, apenas OpenAI
  const catalog: ProviderCatalogResult = {
    models: [
      { providerID: "openai", modelID: "gpt-4o", name: "GPT-4o", connected: true, enabled: true }
    ]
  };

  const updatedState = processProviderCatalogUpdate(catalog, state, storage);

  // Em memória, o fallback é aplicado
  assert.deepEqual(updatedState.selectedModel, {
    providerID: "openai",
    modelID: "gpt-4o"
  });
  assert.equal(updatedState.modelPickSource, "fallback");

  // MAS o localStorage continua preservando Anthropic intacto!
  const rawStorage = storage.getItem(LAST_MODEL_STORAGE_KEY);
  assert.equal(rawStorage !== null, true);
  const parsed = JSON.parse(rawStorage!);
  assert.equal(parsed.providerID, "anthropic");
  assert.equal(parsed.modelID, "claude-3-5-sonnet-20241022");
});

test("4: Modelo salvo temporariamente indisponível é automaticamente recuperado quando o provider reconectar", () => {
  const storage = new MockLocalStorage();
  storage.setItem(LAST_MODEL_STORAGE_KEY, JSON.stringify({
    providerID: "anthropic",
    modelID: "claude-3-5-sonnet-20241022"
  }));

  const initialModel = getSavedInitialModel(storage);
  let state: ModelSyncState = {
    selectedModel: initialModel,
    modelPickSource: initialModel ? "restored" : "none"
  };

  // Momento 1: Apenas OpenAI disponível -> fallback em memória
  const catalog1: ProviderCatalogResult = {
    models: [
      { providerID: "openai", modelID: "gpt-4o", name: "GPT-4o", connected: true, enabled: true }
    ]
  };
  state = processProviderCatalogUpdate(catalog1, state, storage);
  assert.equal(state.modelPickSource, "fallback");
  assert.equal(state.selectedModel?.providerID, "openai");

  // Momento 2: Usuário ativa chave Anthropic -> novo catálogo emitido
  const catalog2: ProviderCatalogResult = {
    models: [
      { providerID: "openai", modelID: "gpt-4o", name: "GPT-4o", connected: true, enabled: true },
      { providerID: "anthropic", modelID: "claude-3-5-sonnet-20241022", name: "Claude 3.5 Sonnet", connected: true, enabled: true }
    ]
  };
  state = processProviderCatalogUpdate(catalog2, state, storage);

  // Deve restaurar automaticamente para Anthropic
  assert.equal(state.modelPickSource, "restored");
  assert.deepEqual(state.selectedModel, {
    providerID: "anthropic",
    modelID: "claude-3-5-sonnet-20241022"
  });
});

test("5: Seleção explícita do usuário grava no localStorage com source = 'user'", () => {
  const storage = new MockLocalStorage();
  let state: ModelSyncState = {
    selectedModel: undefined,
    modelPickSource: "none"
  };

  // Usuário escolhe deepseek
  state = handleUserSelectModel({ providerID: "deepseek", modelID: "deepseek-chat" }, storage);

  assert.equal(state.modelPickSource, "user");
  assert.deepEqual(state.selectedModel, {
    providerID: "deepseek",
    modelID: "deepseek-chat"
  });

  const rawStorage = storage.getItem(LAST_MODEL_STORAGE_KEY);
  assert.equal(rawStorage !== null, true);
  const parsed = JSON.parse(rawStorage!);
  assert.equal(parsed.providerID, "deepseek");
  assert.equal(parsed.modelID, "deepseek-chat");
  assert.equal(typeof parsed.updatedAt, "number");
});

test("6: Reinício completo da aplicação preserva e restaura a escolha prévia do usuário", () => {
  const persistentStorage = new MockLocalStorage();

  // Sessão 1: Usuário escolhe Google Gemini 2.5 Pro
  handleUserSelectModel({ providerID: "google", modelID: "gemini-2.5-pro" }, persistentStorage);

  // Sessão 1 é encerrada e app fecha.
  // Sessão 2: Nova inicialização do app (mesmo storage persistido)
  const initialModelSession2 = getSavedInitialModel(persistentStorage);
  assert.deepEqual(initialModelSession2, {
    providerID: "google",
    modelID: "gemini-2.5-pro"
  });

  let stateSession2: ModelSyncState = {
    selectedModel: initialModelSession2,
    modelPickSource: initialModelSession2 ? "restored" : "none"
  };

  // Passo A: initial-load vazio
  stateSession2 = processProviderCatalogUpdate({ models: [] }, stateSession2, persistentStorage);
  assert.deepEqual(stateSession2.selectedModel, {
    providerID: "google",
    modelID: "gemini-2.5-pro"
  });

  // Passo B: engine-ready com catálogo populado
  stateSession2 = processProviderCatalogUpdate({
    models: [
      { providerID: "openai", modelID: "gpt-4o", name: "GPT-4o", connected: true, enabled: true },
      { providerID: "google", modelID: "gemini-2.5-pro", name: "Gemini 2.5 Pro", connected: true, enabled: true }
    ]
  }, stateSession2, persistentStorage);

  // O modelo escolhido na Sessão 1 continua selecionado na Sessão 2!
  assert.deepEqual(stateSession2.selectedModel, {
    providerID: "google",
    modelID: "gemini-2.5-pro"
  });
  assert.equal(stateSession2.modelPickSource, "restored");
});
