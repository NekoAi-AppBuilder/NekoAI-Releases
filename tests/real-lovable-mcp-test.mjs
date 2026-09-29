import { LovableVaultManager } from "../dist/main/lovable/lovable-vault.js";
import { LovableCloudManager } from "../dist/main/lovable/lovable-cloud-manager.js";
import { LovableMcpServer } from "../dist/main/lovable/lovable-mcp-server.js";

async function runRealTest() {
  console.log("==========================================");
  console.log("[TESTE REAL] Lovable Cloud MCP Read-Only");
  console.log("==========================================");

  const vault = new LovableVaultManager();
  const links = await vault.getAllLinkedProjects();

  if (!links || links.length === 0) {
    console.log("[TESTE REAL] Nenhum projeto Lovable Cloud vinculado no cofre.");
    console.log("[TESTE REAL] Por favor, vincule um projeto na UI antes de rodar o teste real.");
    return;
  }

  const link = links[0];
  console.log(`[TESTE REAL] Projeto vinculado encontrado: path=${link.projectPath} projectId=${link.projectId}`);

  const manager = new LovableCloudManager(vault);
  await manager.setProject(link.projectPath);

  const mcp = new LovableMcpServer(manager);
  const port = await mcp.start(0);
  console.log(`[TESTE REAL] Servidor MCP iniciado na porta ${port}`);

  try {
    // 1. Testar ver_estrutura_do_banco
    console.log("\n[TESTE REAL 1/2] Executando 'ver_estrutura_do_banco'...");
    const schemaRes = await mcp.handleJsonRpcMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "ver_estrutura_do_banco",
        arguments: {},
      },
    });

    if (schemaRes.result?.isError) {
      console.error("[TESTE REAL 1/2] Erro na introspecção:", schemaRes.result.content[0].text);
      return;
    }

    const schemaText = schemaRes.result.content[0].text;
    console.log("[TESTE REAL 1/2] Introspecção recebida com sucesso! Tamanho:", schemaText.length, "bytes");
    console.log("------------------------------------------");
    console.log(schemaText.slice(0, 500) + (schemaText.length > 500 ? "\n..." : ""));
    console.log("------------------------------------------");

    // Tentar extrair nome de uma tabela real da introspecção
    const tableMatch = schemaText.match(/### `(?:public\.)?([a-zA-Z0-9_]+)`/);
    const tableName = tableMatch ? tableMatch[1] : null;

    if (!tableName) {
      console.log("[TESTE REAL 2/2] Nenhuma tabela encontrada no banco para testar SELECT.");
      return;
    }

    console.log(`\n[TESTE REAL 2/2] Executando 'consultar_dados' na tabela REAL '${tableName}'...`);
    const selectRes = await mcp.handleJsonRpcMessage({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "consultar_dados",
        arguments: {
          query: `SELECT * FROM ${tableName} LIMIT 3;`,
        },
      },
    });

    if (selectRes.result?.isError) {
      console.error("[TESTE REAL 2/2] Erro na consulta:", selectRes.result.content[0].text);
      return;
    }

    const selectText = selectRes.result.content[0].text;
    console.log("[TESTE REAL 2/2] Consulta SELECT concluída com sucesso!");
    console.log("------------------------------------------");
    console.log(selectText);
    console.log("------------------------------------------");

    console.log("\n[TESTE REAL] CONCLUSÃO: TODOS OS PASSOS REALIZADOS E VALIDADOS!");
  } finally {
    await mcp.stop();
  }
}

runRealTest().catch((err) => console.error("[TESTE REAL] Erro não tratado:", err));
