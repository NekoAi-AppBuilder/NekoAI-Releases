import { test, expect } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConversationTools } from '../src/renderer/components/ConversationTools';
import { ConversationHistoryPanel } from '../src/renderer/components/ConversationHistoryPanel';

test('toolbar exposes Chat, Histórico and Skills with the installed count and selected tab', () => {
  const html=renderToStaticMarkup(<ConversationTools active="history" count={3} onSelect={()=>{}}/>);
  expect(html.match(/role="tab"/g)?.length).toBe(3);expect(html).toContain('Histórico');expect(html).toContain('Skills');expect(html).toContain('conversation-skills-count">3');expect(html.match(/<button[^>]*id="conversation-tool-history"[^>]*>/)?.[0]).toContain('aria-selected="true"');
});
test('a project history lists conversation titles and keeps its active conversation identifiable',()=>{
  const html=renderToStaticMarkup(<ConversationHistoryPanel activeId="c1" items={[{id:'c1',title:'Meu projeto',createdAt:1,updatedAt:1,messageCount:4}]} loading={false} blocked={false} onOpen={()=>{}} onNew={()=>{}} onRefresh={()=>{}}/>);
  expect(html).toContain('Meu projeto');expect(html).toContain('4 mensagens');expect(html).toContain('Atual');expect(html).toContain('Nova conversa');
});
test('blocked conversations cannot start a new session while the active session remains navigable',()=>{
  const html=renderToStaticMarkup(<ConversationHistoryPanel activeId="c1" items={[{id:'c1',title:'Atual',createdAt:1,updatedAt:1,messageCount:4},{id:'c2',title:'Outra',createdAt:1,updatedAt:1,messageCount:2}]} loading={false} blocked={true} onOpen={()=>{}} onNew={()=>{}} onRefresh={()=>{}}/>);
  expect(html.match(/disabled=""/g)?.length).toBe(2);expect(html).toContain('prompts pendentes');expect(html).toContain('class="active"');
});
