import React from "react";
import { History, Loader2, MessageSquare, Plus, Search } from "lucide-react";
import type { ConversationSummary } from "../../shared/conversations";
export function ConversationHistoryPanel({ items, activeId, loading, blocked, onOpen, onNew, onRefresh }: {
  items: ConversationSummary[]; activeId?: string; loading: boolean; blocked: boolean;
  onOpen: (id: string) => void; onNew: () => void; onRefresh: () => void;
}) {
  const [query, setQuery] = React.useState("");
  const visible = items.filter(item => item.title.toLocaleLowerCase("pt-BR").includes(query.toLocaleLowerCase("pt-BR")));
  return <section className="conversation-history-panel" id="conversation-panel-history" role="tabpanel" aria-labelledby="conversation-tool-history">
    <header><div><h2>Histórico</h2><p>Conversas salvas neste projeto</p></div><button type="button" onClick={onNew} disabled={blocked || loading}><Plus size={13}/> Nova conversa</button></header>
    <label className="conversation-history-search"><Search size={13}/><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Buscar conversa..." aria-label="Buscar no histórico"/></label>
    {blocked && <p className="conversation-history-note">Conclua ou pare a tarefa e limpe os prompts pendentes antes de trocar de conversa.</p>}
    <div className="conversation-history-list" aria-busy={loading}>
      {loading && <div className="conversation-history-empty" role="status"><Loader2 size={18} className="spin"/> Carregando histórico...</div>}
      {!loading && !visible.length && <div className="conversation-history-empty"><History size={23}/><span>{query ? "Nenhuma conversa encontrada." : "As conversas deste projeto aparecerão aqui."}</span></div>}
      {visible.map(item => <button type="button" key={item.id} className={item.id === activeId ? "active" : ""} disabled={loading || (blocked && item.id !== activeId)} onClick={() => onOpen(item.id)}>
        <MessageSquare size={14}/><span><b>{item.title}</b><small>{new Date(item.updatedAt).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })} · {item.engineHistoryPending ? "Conversa anterior" : `${item.messageCount} mensagens`}{item.id === activeId ? " · Atual" : ""}</small></span>
      </button>)}
    </div>
    <button type="button" className="conversation-history-refresh" onClick={onRefresh} disabled={loading}>Atualizar histórico</button>
  </section>;
}
