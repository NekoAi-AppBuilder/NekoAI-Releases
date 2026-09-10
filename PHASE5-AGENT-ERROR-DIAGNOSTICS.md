# v0.4.55 — Agent Error Diagnostics

- Exibe erros estruturados do OpenCode em vez de uma mensagem genérica.
- Traduz content-blocked, 401, 403, 429 e 5xx para mensagens úteis.
- Respeita isRetryable=false como erro terminal; desbloqueia a interface imediatamente.
- Mantém o Neko online em erros de sessão/provedor; somente falhas de conexão marcam offline.
- Mostra detalhes seguros: código, HTTP, tipo, retryability e request ID.
- Não exibe headers, cookies, tokens ou payload bruto do provedor.
- Reduz a largura padrão dos modais para 500px.
