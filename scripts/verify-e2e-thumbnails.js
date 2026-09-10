const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");

const evidenceDir = path.join(__dirname, "../evidence-thumbnails");
if (!fs.existsSync(evidenceDir)) {
  fs.mkdirSync(evidenceDir, { recursive: true });
}

// Configura o userData real do NekoAI para carregar a licença e dados existentes
const realUserData = path.join(process.env.APPDATA, "NekoAI");
app.setPath("userData", realUserData);

process.env.NEKO_E2E_VERIFY = "1";
process.env.NODE_ENV = "production";

console.log("[E2E] Iniciando verificação visual do Electron com Miniaturas...");

// Importa o main compilado
require("../dist/main/main.js");

app.whenReady().then(async () => {
  try {
    await new Promise(r => setTimeout(r, 4000));
    const windows = BrowserWindow.getAllWindows();
    const mainWindow = windows[0];

    if (!mainWindow) {
      throw new Error("mainWindow não foi criada.");
    }

    console.log("[E2E] mainWindow encontrada. Aguardando renderização completa da Home (5s)...");
    await new Promise(r => setTimeout(r, 5000));

    // 1. Screenshot da Home inicial
    const homeImage = await mainWindow.webContents.capturePage();
    const homePath = path.join(evidenceDir, "01-home-initial.png");
    fs.writeFileSync(homePath, homeImage.toPNG());
    console.log("[E2E] Screenshot da Home salvo:", homePath);

    // 2. Avalia no DOM se o card site-adv tem a thumbnail real
    const cardInfo = await mainWindow.webContents.executeJavaScript(`
      (() => {
        const cards = Array.from(document.querySelectorAll(".home-project-card"));
        return cards.map(c => {
          const name = c.querySelector(".home-project-name")?.textContent?.trim();
          const thumb = c.querySelector(".home-project-real-thumb");
          const fallback = c.querySelector(".home-project-fallback-thumb");
          const time = c.querySelector(".home-project-time")?.textContent?.trim();
          return {
            name,
            hasRealThumb: Boolean(thumb && thumb.src && thumb.src.startsWith("data:image/")),
            thumbSrcPrefix: thumb?.src?.slice(0, 30),
            hasFallback: Boolean(fallback),
            time
          };
        });
      })()
    `);

    console.log("[E2E] Cards encontrados na Home:", cardInfo);
    const siteAdvCard = cardInfo.find(c => c.name === "site-adv");
    console.log("[E2E] Card site-adv na Home:", siteAdvCard);

    // 3. Abre o site-adv clicando nele
    console.log("[E2E] Clicando no card site-adv...");
    await mainWindow.webContents.executeJavaScript(`
      (() => {
        const cards = Array.from(document.querySelectorAll(".home-project-card"));
        const target = cards.find(c => c.querySelector(".home-project-name")?.textContent?.includes("site-adv"));
        if (target) target.click();
      })()
    `);

    // Aguarda transição do workspace e preview (12s para garantir o carregamento do preview e frame)
    console.log("[E2E] Aguardando inicialização completa do workspace e preview (12s)...");
    await new Promise(r => setTimeout(r, 12000));

    // Screenshot do workspace aberto com o Preview
    const wsImage = await mainWindow.webContents.capturePage();
    const wsPath = path.join(evidenceDir, "02-workspace-site-adv.png");
    fs.writeFileSync(wsPath, wsImage.toPNG());
    console.log("[E2E] Screenshot do workspace salvo:", wsPath);

    // 4. Volta para a Home clicando no botão "Sair"
    console.log("[E2E] Clicando no botão 'Sair' para retornar à Home...");
    const exitClicked = await mainWindow.webContents.executeJavaScript(`
      (() => {
        const buttons = Array.from(document.querySelectorAll("button"));
        const exitBtn = buttons.find(b => b.textContent?.includes("Sair") || b.title?.includes("Sair"));
        if (exitBtn) {
          exitBtn.click();
          return true;
        }
        return false;
      })()
    `);
    console.log("[E2E] Botão Sair clicado:", exitClicked);

    // Aguarda a Home renderizar novamente
    await new Promise(r => setTimeout(r, 5000));

    // 5. Screenshot da Home após voltar do Preview
    const homeAfterImage = await mainWindow.webContents.capturePage();
    const homeAfterPath = path.join(evidenceDir, "03-home-after-preview.png");
    fs.writeFileSync(homeAfterPath, homeAfterImage.toPNG());
    console.log("[E2E] Screenshot da Home pós-preview salvo:", homeAfterPath);

    // Avalia os cards na Home novamente
    const cardInfoAfter = await mainWindow.webContents.executeJavaScript(`
      (() => {
        const cards = Array.from(document.querySelectorAll(".home-project-card"));
        return cards.map(c => {
          const name = c.querySelector(".home-project-name")?.textContent?.trim();
          const thumb = c.querySelector(".home-project-real-thumb");
          const fallback = c.querySelector(".home-project-fallback-thumb");
          const time = c.querySelector(".home-project-time")?.textContent?.trim();
          return {
            name,
            hasRealThumb: Boolean(thumb && thumb.src && thumb.src.startsWith("data:image/")),
            thumbSrcPrefix: thumb?.src?.slice(0, 30),
            hasFallback: Boolean(fallback),
            time
          };
        });
      })()
    `);

    const siteAdvAfter = cardInfoAfter.find(c => c.name === "site-adv");
    console.log("[E2E] Card site-adv após retorno:", siteAdvAfter);

    const isSuccess = Boolean(siteAdvCard?.hasRealThumb && siteAdvAfter?.hasRealThumb);
    const results = {
      success: isSuccess,
      initialCards: cardInfo,
      afterCards: cardInfoAfter,
      siteAdvBefore: siteAdvCard,
      siteAdvAfter: siteAdvAfter,
      timestamp: new Date().toISOString()
    };

    fs.writeFileSync(path.join(evidenceDir, "results.json"), JSON.stringify(results, null, 2));
    console.log("[E2E] RESULTADO FINAL:", isSuccess ? "SUCESSO COMPLETO" : "FALHA");

    app.quit();
  } catch (err) {
    console.error("[E2E] Erro no teste visual:", err);
    app.exit(1);
  }
});
