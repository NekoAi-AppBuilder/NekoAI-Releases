import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { ConversationMessage, ConversationSummary, SavedConversation } from "../../shared/conversations";

type Document = { version: 1; projectKey: string; activeId: string | null; conversations: SavedConversation[] };
const copy = <T>(value: T): T => value === undefined ? value : JSON.parse(JSON.stringify(value));

/** Per-project serialization and durable same-directory atomic replacement.
 * Neither transcripts nor attachments are written into the user's repository.
 */
export class ConversationStore {
  private tails = new Map<string, Promise<unknown>>();
  constructor(private directory: () => string) {}
  private file(key: string): string { return path.join(this.directory(), createHash("sha256").update(key).digest("hex") + ".json"); }
  private validate(raw: string, key: string): Document {
    const doc = JSON.parse(raw);
    if (doc?.version !== 1 || doc.projectKey !== key || !Array.isArray(doc.conversations)) throw new Error("Formato de histórico inválido.");
    for (const conversation of doc.conversations) {
      if (typeof conversation.id !== "string" || typeof conversation.sessionId !== "string" || typeof conversation.title !== "string" || !Number.isFinite(conversation.createdAt) || !Number.isFinite(conversation.updatedAt) || !Array.isArray(conversation.messages)) throw new Error("Conversa inválida no histórico.");
      conversation.messages = sanitizeConversationMessages(conversation.messages);
      conversation.messageCount = conversation.messages.length;
    }
    return doc;
  }
  private async read(key: string): Promise<Document> {
    const file = this.file(key);
    try { return this.validate(await fs.readFile(file, "utf8"), key); }
    catch (error: any) {
      if (error.code === "ENOENT") {
        try { return this.validate(await fs.readFile(file + ".bak", "utf8"), key); }
        catch (backup: any) { if (backup.code === "ENOENT") return { version: 1, projectKey: key, activeId: null, conversations: [] }; }
      } else {
        try { return this.validate(await fs.readFile(file + ".bak", "utf8"), key); } catch {}
      }
      throw new Error("Não foi possível ler o histórico deste projeto. Os arquivos existentes foram preservados.");
    }
  }
  private async atomic(file: string, text: string): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = file + "." + randomUUID() + ".tmp";
    try {
      const handle = await fs.open(temporary, "wx", 0o600);
      try { await handle.writeFile(text, "utf8"); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temporary, file);
    } finally { await fs.rm(temporary, { force: true }); }
  }
  private run<T>(key: string, operation: (doc: Document) => Promise<T> | T, write = false): Promise<T> {
    const prior = this.tails.get(key) || Promise.resolve();
    const pending = prior.catch(() => {}).then(async () => {
      const doc = await this.read(key), before = JSON.stringify(doc);
      const result = await operation(doc);
      if (write) {
        // Write the previous validated state before replacing the primary file.
        await this.atomic(this.file(key) + ".bak", before);
        await this.atomic(this.file(key), JSON.stringify(doc));
        await this.atomic(this.file(key) + ".bak", JSON.stringify(doc));
      }
      return copy(result);
    });
    this.tails.set(key, pending);
    void pending.finally(() => { if (this.tails.get(key) === pending) this.tails.delete(key); }).catch(() => {});
    return pending;
  }
  async list(key: string): Promise<ConversationSummary[]> {
    return this.run(key, doc => doc.conversations.map(({ id, title, createdAt, updatedAt, messages, engineHistoryPending }) => ({ id, title, createdAt, updatedAt, messageCount: messages.length, engineHistoryPending })).sort((a, b) => b.updatedAt - a.updatedAt));
  }
  async active(key: string): Promise<SavedConversation | null> { return this.run(key, doc => doc.conversations.find(c => c.id === doc.activeId) || null); }
  async get(key: string, id: string): Promise<SavedConversation> {
    return this.run(key, doc => { const found = doc.conversations.find(c => c.id === id); if (!found) throw new Error("Conversa não encontrada neste projeto."); return found; });
  }
  async create(key: string, sessionId: string): Promise<SavedConversation> {
    return this.run(key, doc => {
      const now = Date.now();
      const record: SavedConversation = { id: randomUUID(), sessionId, title: "Nova conversa", createdAt: now, updatedAt: now, messageCount: 0, messages: [], needsContextRestore: false };
      doc.conversations.push(record); doc.activeId = record.id; return record;
    }, true);
  }
  async importSessions(key: string, sessions: { id: string; title: string; createdAt: number; updatedAt: number }[]): Promise<void> {
    if (!sessions.length) return;
    return this.run(key, doc => {
      for (const session of sessions) if (!doc.conversations.some(c => c.sessionId === session.id)) {
        doc.conversations.push({ id: randomUUID(), sessionId: session.id, title: session.title || "Conversa anterior", createdAt: session.createdAt, updatedAt: session.updatedAt, messageCount: 0, messages: [], needsContextRestore: false, engineHistoryPending: true });
      }
      if (!doc.activeId) doc.activeId = [...doc.conversations].sort((a, b) => b.updatedAt - a.updatedAt)[0]?.id || null;
    }, true);
  }
  async select(key: string, id: string, sessionId?: string): Promise<SavedConversation> {
    return this.run(key, doc => {
      const record = doc.conversations.find(c => c.id === id); if (!record) throw new Error("Conversa não encontrada neste projeto.");
      doc.activeId = record.id;
      if (sessionId && record.sessionId !== sessionId) { record.sessionId = sessionId; record.needsContextRestore = record.messages.length > 0; }
      return record;
    }, true);
  }
  async save(key: string, id: string, sessionId: string, messages: ConversationMessage[]): Promise<SavedConversation> {
    return this.run(key, doc => {
      const record = doc.conversations.find(c => c.id === id);
      if (!record || record.sessionId !== sessionId) throw new Error("A gravação pertence a outra conversa ou sessão.");
      record.messages = sanitizeConversationMessages(messages); record.messageCount = record.messages.length;
      const title = record.messages.find(m => m.role === "user" && m.text.trim())?.text;
      if (title) record.title = title.replace(/\s+/g, " ").slice(0, 90);
      record.updatedAt = Date.now(); return record;
    }, true);
  }
  async append(key: string, id: string, sessionId: string, message: ConversationMessage): Promise<void> {
    return this.run(key, doc => {
      const record = doc.conversations.find(c => c.id === id);
      if (!record || record.sessionId !== sessionId) throw new Error("A mensagem pertence a outra conversa.");
      if (message.clientRequestId && record.messages.some(m => m.clientRequestId === message.clientRequestId)) return;
      record.messages.push(...sanitizeConversationMessages([message])); record.messageCount = record.messages.length;
      if (message.role === "user" && message.text.trim()) {
        if (record.messages.filter(m => m.role === "user").length === 1) record.title = message.text.replace(/\s+/g, " ").slice(0, 90);
      }
      record.updatedAt = Date.now();
    }, true);
  }
  async mergeEngine(key: string, id: string, sessionId: string, messages: ConversationMessage[]): Promise<SavedConversation> {
    return this.run(key, doc => {
      const record = doc.conversations.find(c => c.id === id);
      if (!record || record.sessionId !== sessionId) throw new Error("A captura pertence a outra conversa.");
      const incoming = sanitizeConversationMessages(messages);
      if (!record.messages.length) record.messages = incoming;
      else {
        const lastAt = record.messages.reduce((latest, message) => Math.max(latest, message.createdAt || 0), 0);
        for (const message of incoming) {
          if (message.role !== "assistant" || !message.text.trim()) continue;
          if (message.engineMessageId && record.messages.some(m => m.engineMessageId === message.engineMessageId)) continue;
          if ((message.createdAt || 0) >= lastAt) record.messages.push(message);
        }
      }
      record.messageCount = record.messages.length;
      record.engineHistoryPending = false;
      record.updatedAt = record.messages.reduce((latest, message) => Math.max(latest, message.createdAt || 0), record.updatedAt);
      const title = record.messages.find(m => m.role === "user" && m.text.trim())?.text;
      if (title) record.title = title.replace(/\s+/g, " ").slice(0, 90);
      return record;
    }, true);
  }
  async contextRestored(key: string, id: string): Promise<void> {
    return this.run(key, doc => { const record = doc.conversations.find(c => c.id === id); if (record) record.needsContextRestore = false; }, true);
  }
  async flush(): Promise<void> { await Promise.all([...this.tails.values()]); }
}

export function sanitizeConversationMessages(messages: ConversationMessage[]): ConversationMessage[] {
  if (!Array.isArray(messages)) throw new Error("Mensagens inválidas.");
  return messages.map(message => {
    if (!message || !["user", "assistant", "system", "error"].includes(message.role) || typeof message.text !== "string") throw new Error("Mensagem inválida no histórico.");
    return {
      role: message.role, text: message.text,
      createdAt: Number.isFinite(message.createdAt) ? message.createdAt : Date.now(),
      ...(typeof message.engineMessageId === "string" ? { engineMessageId: message.engineMessageId } : {}),
      ...(typeof message.clientRequestId === "string" ? { clientRequestId: message.clientRequestId } : {}),
      ...(typeof message.taskId === "string" ? { taskId: message.taskId } : {}),
      ...(Number.isFinite(message.durationMs) ? { durationMs: message.durationMs } : {}),
      ...(message.attachments?.length ? { attachments: message.attachments.map(a => ({
        path: String(a.path || ""), name: String(a.name || ""), mime: String(a.mime || ""),
        size: Number(a.size) || 0, kind: a.kind, extension: a.extension
      })) } : {})
    };
  });
}
