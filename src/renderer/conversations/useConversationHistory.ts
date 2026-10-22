import React from "react";
import type { ConversationMessage, ConversationSummary, OpenConversation } from "../../shared/conversations";

type Writer = { conversation: OpenConversation; projectPath: string; sequence: number; json: string | null };
export function useConversationHistory(project: string | null, sessionId: string | null) {
  const [messages, setMessages] = React.useState<ConversationMessage[]>([]);
  const [conversation, setConversation] = React.useState<OpenConversation | null>(null);
  const [history, setHistory] = React.useState<ConversationSummary[]>([]);
  const [error, setError] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const writerRef = React.useRef<Writer | null>(null);
  const pendingRef = React.useRef(new Set<Promise<void>>());
  const latestRef = React.useRef({ project, sessionId, messages });
  latestRef.current = { project, sessionId, messages };
  const restore = React.useCallback((record: OpenConversation | undefined, projectPath: string) => {
    const restored = record?.messages.map(message => ({ ...message, restoredFromHistory: true })) || [];
    writerRef.current = record ? { conversation: record, projectPath, sequence: record.writeSequence || 0, json: JSON.stringify(restored) } : null;
    setConversation(record || null); setMessages(restored);
    setError(record ? "" : "O histórico não pôde ser carregado. Evite encerrar esta conversa até verificar o armazenamento.");
  }, []);
  const persist = React.useCallback((): Promise<void> => {
    const writer = writerRef.current, latest = latestRef.current;
    if (!writer || writer.projectPath !== latest.project || writer.conversation.sessionId !== latest.sessionId) return Promise.resolve();
    const json = JSON.stringify(latest.messages);
    if (json === writer.json) return Promise.resolve();
    writer.json = json;
    const sequence = ++writer.sequence;
    const pending = window.neko.conversationsSave({
      conversationId: writer.conversation.id, sessionId: writer.conversation.sessionId,
      writeToken: writer.conversation.writeToken, sequence, messages: latest.messages
    }).then(() => {
      if (writerRef.current === writer && writer.sequence === sequence) setError("");
    }).catch(cause => {
      if (writerRef.current === writer) {
        if (writer.sequence === sequence) writer.json = null;
        setError(cause?.message || "Não foi possível salvar a conversa. Tente novamente antes de fechar.");
      }
      throw cause;
    });
    pendingRef.current.add(pending);
    void pending.then(() => pendingRef.current.delete(pending), () => pendingRef.current.delete(pending));
    return pending;
  }, []);
  React.useEffect(() => { void persist().catch(() => {}); }, [messages, project, sessionId, persist]);
  const flush = React.useCallback(async () => { await persist(); await Promise.all([...pendingRef.current]); }, [persist]);
  const refresh = React.useCallback(async () => {
    if (!project) return;
    setLoading(true);
    try { await flush(); setHistory(await window.neko.conversationsList()); }
    catch (cause: any) { setError(cause?.message || "Não foi possível carregar o histórico."); }
    finally { setLoading(false); }
  }, [project, flush]);
  return { messages, setMessages, conversation, history, error, loading, restore, flush, refresh };
}
