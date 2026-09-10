# SYNCPAY WEBHOOK CONTRACT — NEKOAI BILLING
**Fase 2 — Documentação Oficial & Especificação de Payload**
**Origem:** OpenAPI 3.1.0 SyncPay Developer Portal (Transações Completo & Recorrência)

---

## 1. ENDPOINT & TRANSPORTE HTTP
- **Método HTTP:** `POST`
- **Path no NekoAI:** `/billing-webhook/syncpay` (ou `/billing-webhook` com header/route dispatcher)
- **Formato do Body:** `application/json` (Encoding: UTF-8)
- **Resposta Esperada:** HTTP `2xx` (ex: `200 OK`) com payload JSON.

---

## 2. CABEÇALHOS HTTP OFICIAIS (HEADERS)

| Header | Tipo | Obrigatório | Descrição |
| :--- | :--- | :--- | :--- |
| `X-SyncPay-Event` | String | Sim | Nome do evento disparado. Valores: `transaction.created`, `transaction.updated` |
| `X-SyncPay-Delivery` | UUID | Sim | Identificador único daquela entrega específica (muda a cada retentativa). |
| `X-SyncPay-Signature` | String | Sim | Assinatura HMAC-SHA256 no formato: `t=<unix_timestamp>,v1=<hex_hash_64_chars>` |
| `Content-Type` | String | Sim | `application/json` |

---

## 3. MECANISMO DE AUTENTICAÇÃO, ASSINATURA E ANTI-REPLAY

### Algoritmo de Validação:
1. Extrair o header `X-SyncPay-Signature`.
2. Fazer o split do header em:
   - `t` (timestamp Unix em segundos, ex: `1755354730`)
   - `v1` (hash HMAC-SHA256 em hexadecimal, 64 caracteres)
3. **Proteção Anti-Replay:**
   - Verificar `Math.abs(now_unix - t) <= 300` (janela de tolerância de 5 minutos / 300 segundos). Rejeitar entregas fora desta janela.
4. **Cálculo da Assinatura:**
   - String a ser assinada: `"${t}.${raw_body}"` (usando o corpo bruto exatamente como recebido pela rede, antes de qualquer parse JSON).
   - Chave: `SYNCPAY_WEBHOOK_SECRET` (configurada no Supabase Vault / Edge Functions).
   - Algoritmo: `HMAC-SHA-256`.
5. **Comparação Segura:**
   - Comparar em tempo constante com a assinatura recebida em `v1`.

---

## 4. ESTRUTURA DO PAYLOAD OFICIAL (`TransactionEvent`)

```json
{
  "event": "transaction.updated",
  "event_id": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
  "occurred_at": "2026-08-30T14:32:10Z",
  "api_version": "2026-08-16",
  "transaction": {
    "reference_id": "c1a2b3c4-d5e6-7890-abcd-ef1234567890",
    "status": "completed",
    "previous_status": "pending",
    "payment_method": "pix",
    "origin": "checkout",
    "description": "NekoAI Anual + Bump",
    "currency": "BRL",
    "amount": 397.00,
    "net_amount": 379.50,
    "refused_reason": null,
    "end_to_end_id": "E1234567820260830143210...",
    "created_at": "2026-08-30T14:30:00Z",
    "updated_at": "2026-08-30T14:32:10Z",
    "paid_at": "2026-08-30T14:32:10Z",
    "refunded_at": null
  },
  "customer": {
    "reference_id": "cust_12345678-abcd-1234-abcd-1234567890ab",
    "name": "João da Silva",
    "email": "joao@email.com",
    "document": "12345678909",
    "phone": "+5511999999999"
  },
  "checkout": {
    "reference_id": "chk_87654321-abcd-1234-abcd-1234567890ab",
    "name": "Checkout NekoAI Oficial",
    "items": [
      {
        "reference_id": "prod_neko_anual_uuid",
        "name": "NekoAI Licença Anual",
        "type": "product",
        "amount": 397.00
      },
      {
        "reference_id": "bump_plus3_devices_uuid",
        "name": "Order Bump: +3 Computadores",
        "type": "order_bump",
        "amount": 97.00
      }
    ]
  },
  "payment": {
    "pix": {
      "code": "00020126360014BR.GOV.BCB.PIX..."
    },
    "card": null
  },
  "tracking": {
    "utm": {
      "utm_source": "google",
      "utm_campaign": "launch"
    },
    "client_ip": "177.18.29.30",
    "user_agent": "Mozilla/5.0..."
  }
}
```

---

## 5. MAPEAMENTO DE STATUS E EVENTOS OFICIAIS

### A. Status de Transação (`transaction.status`)
- `completed` $\rightarrow$ Pagamento aprovado / Ciclo pago
- `pending` $\rightarrow$ Aguardando pagamento Pix / Boleto / Análise de cartão
- `refused` $\rightarrow$ Pagamento recusado (cartão sem saldo / anti-fraude)
- `refunded` $\rightarrow$ Venda estornada / Reembolsada
- `chargedback` $\rightarrow$ Contestação / Disputa aberta pelo pagador

### B. Origens da Transação (`transaction.origin`)
- `checkout` $\rightarrow$ Compra via checkout transparente / página com itens (`checkout.items[]`)
- `subscription` $\rightarrow$ Cobrança recorrente originada do motor de assinaturas
- `payment_link` $\rightarrow$ Link de pagamento direto
- `api` $\rightarrow$ Cobrança criada via API

---

## 6. ESTRUTURA DE ITENS E IDENTIFICAÇÃO DE ORDER BUMPS
No objeto `checkout.items[]`:
- `item.type = "product"`: É o produto base (Plano Mensal, Trimestral ou Anual).
- `item.type = "order_bump"`: É o adicional de capacidade (Ex: +1, +3 ou +5 dispositivos).
- Identificação: **Exclusivamente por `item.reference_id`** (UUID público configurado no catálogo).

---

## 7. RASTREABILIDADE & IDEMPOTÊNCIA
- **Chave de Idempotência Primária:** `event_id` (UUID no topo do payload).
- **Chave de Transação:** `transaction.reference_id` (UUID da transação).
- **Assinatura Recorrente:** Quando `origin = "subscription"`, identificar o plano ou usar a correlação do assinante (`customer.reference_id` ou metadata) para renovação da licença correspondente.
