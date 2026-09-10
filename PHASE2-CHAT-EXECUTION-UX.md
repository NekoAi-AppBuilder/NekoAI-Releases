# NekoAI v0.4.31 — Chat Execution UX

Esta build mantém o escopo da Fase 2 e corrige a apresentação da execução no chat.

- A atividade interna do motor não é mais exibida como uma lista permanente de etapas.
- O chat mostra apenas um estado discreto enquanto o Neko trabalha.
- O resultado do trabalho é apresentado ao final pela resposta do Neko.
- Estados `idle` transitórios não encerram uma solicitação antes de um ciclo real `busy -> idle`.
- Termos internos do motor são sanitizados antes de chegar à interface.
- Aprovações usam linguagem do Neko, sem nomes técnicos do motor.
- URLs e strings longas continuam impedidas de causar overflow horizontal.

O motor interno continua podendo registrar logs técnicos no terminal; esses detalhes não fazem parte da experiência do usuário.
