export type ConversationAttachment = {
  path: string; name: string; mime: string; size: number;
  kind: "image" | "document" | "text"; extension?: string; url?: string; previewUrl?: string;
};
export type ConversationMessage = {
  role: "user" | "assistant" | "system" | "error"; text: string;
  attachments?: ConversationAttachment[]; taskId?: string; durationMs?: number; createdAt?: number;
  engineMessageId?: string;
  clientRequestId?: string;
  restoredFromHistory?: boolean;
};
export type ConversationSummary = {
  id: string; title: string; createdAt: number; updatedAt: number; messageCount: number;
  engineHistoryPending?: boolean;
};
export type SavedConversation = ConversationSummary & {
  sessionId: string; messages: ConversationMessage[]; needsContextRestore: boolean;
};
export type OpenConversation = SavedConversation & {
  writeToken: string; notice?: string;
  writeSequence?: number;
};
export type ConversationSave = {
  conversationId: string; sessionId: string; writeToken: string; sequence: number; messages: ConversationMessage[];
};
