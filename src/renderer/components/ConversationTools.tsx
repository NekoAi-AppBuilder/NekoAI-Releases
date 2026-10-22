import React from "react";
import { History, MessageSquare, Sparkles } from "lucide-react";
export type ConversationTool = "chat" | "history" | "skills";
export function ConversationTools({ active, count, onSelect }: { active: ConversationTool; count: number; onSelect: (tool: ConversationTool) => void }) {
  const tools = [{ id: "chat", label: "Chat", Icon: MessageSquare }, { id: "history", label: "Histórico", Icon: History }, { id: "skills", label: "Skills", Icon: Sparkles }] as const;
  return <div className="conversation-tools" role="tablist" aria-label="Ferramentas da conversa">
    {tools.map(({ id, label, Icon }) => <button type="button" key={id} id={`conversation-tool-${id}`} role="tab" tabIndex={active === id ? 0 : -1} aria-selected={active === id} aria-controls={`conversation-panel-${id}`} className={active === id ? "active" : ""} onClick={() => onSelect(id)} onKeyDown={event => {
      const current = tools.findIndex(tool => tool.id === id);
      const next = event.key === "ArrowRight" ? (current + 1) % tools.length : event.key === "ArrowLeft" ? (current + tools.length - 1) % tools.length : event.key === "Home" ? 0 : event.key === "End" ? tools.length - 1 : -1;
      if (next < 0) return;
      event.preventDefault();
      onSelect(tools[next].id);
      (event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button[role="tab"]')[next])?.focus();
    }}>
      <span className="conversation-tool-icon"><Icon size={13}/></span><span>{label}</span>
      {id === "skills" && count > 0 && <small className="conversation-skills-count">{count}</small>}
    </button>)}
  </div>;
}
