import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow, Menu, ipcMain, dialog, session, safeStorage } from "electron";
import { openDatabase, migrate, ensureDeviceId } from "@facaamigos/db-local";
import { buildApp } from "../server/app.js";
import { seedDevData } from "../server/seed-dev.js";
import { loadOrCreateTls } from "../server/tls.js";
import { startPrintBridge } from "./printBridge.js";
import { listWindowsPrinters } from "./listPrinters.js";
import { splashDataUrl } from "./splash.js";
import { startFiscalWorker } from "../fiscal/index.js";
import { classifyTerminalKey } from "../config/supabaseTerminalKey.js";
import { isUsableTerminalKey, persistTerminalKey } from "../config/terminalKeyStore.js";
import { initAutoUpdater, checkForUpdatesAndWait, getUpdateStatus, applyUpdate } from "./autoUpdater.js";

/** Variáveis onde uma chave publicável colada por engano quebra tudo em silêncio. */
const CREDENCIAIS_TERMINAL = new Set(["FACAAMIGOS_SUPABASE_SECRET_KEY", "FACAAMIGOS_SUPABASE_SERVICE_ROLE_KEY"]);

/**
 * O bundle é puro esbuild sem `dotenv` — sem isto, `apps/kiosk/.env`
 * (FACAAMIGOS_SUPABASE_URL/SERVICE_ROLE_KEY/PUBLIC_APP_URL) fica só um
 * arquivo no disco que ninguém lê: o print bridge via `process.env` direto,
 * então a ponte de impressão "desligava silenciosamente" mesmo com o .env
 * preenchido. Variáveis já definidas no ambiente real (produção) não são
 * sobrescritas.
 */

function loadDotEnvFromCandidates(): void {
  let userDataEnv = "";
  let legacyAppDataEnv1 = "";
  let legacyAppDataEnv2 = "";

  try {
    const userData = app.getPath("userData");
    if (userData) userDataEnv = join(userData, ".env");
    const appData = app.getPath("appData");
    if (appData) {
      legacyAppDataEnv1 = join(appData, "FacaAmigos", ".env");
      legacyAppDataEnv2 = join(appData, "@facaamigos", "kiosk", ".env");
    }
  } catch {
    // app.getPath pode falhar se chamado antes da inicialização completa dos caminhos
  }

  // A linha da chave secreta nasce VAZIA de propósito. Ela já nasceu
  // preenchida com a chave publicável (sb_publishable_...), e isso custou
  // semanas de emissão fiscal parada: o valor "parecia configurado", tinha
  // a precedência mais alta (userData vem antes do .env do instalador, ver
  // abaixo) e nunca era corrigido por reinstalar — mas a Edge Function
  // `nfse-certificate-fetch` responde 401 a ela, e o erro chegava ao painel
  // como "Certificado A1 não disponível: não autorizado", que parece
  // problema no certificado.
  //
  // Vazia, a guarda de `resolveTerminalSupabaseKey` acusa a falta na hora,
  // com o texto que diz o que fazer.
  const defaultContent = `# Configuração de ambiente local do terminal Kiosk Faça Amigos
VITE_SUPABASE_URL=https://ivjvpdzsfjdpyabbzzuj.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_ssGb6CGSjsE7PTfXpR6cBg_I20V6YBh
FACAAMIGOS_SUPABASE_URL=https://ivjvpdzsfjdpyabbzzuj.supabase.co
# Cole aqui a chave secreta deste terminal (Supabase > Project Settings >
# API Keys > Secret keys). Sem ela o terminal não imprime nem emite nota.
# NÃO use a chave publicável (sb_publishable_...) nem a service_role legada
# (eyJ...): as duas levam 401 na emissão fiscal.
FACAAMIGOS_SUPABASE_SECRET_KEY=
FACAAMIGOS_PUBLIC_APP_URL=https://app.institutofacaamigos.com.br
`;

  for (const envPath of [userDataEnv, legacyAppDataEnv1, legacyAppDataEnv2].filter(Boolean)) {
    if (!existsSync(envPath)) {
      try {
        const dir = join(envPath, "..");
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(envPath, defaultContent, "utf8");
        console.log(`[main] Criou arquivo .env padrão em: ${envPath}`);
      } catch (err) {
        console.warn(`[main] Falha ao criar .env em ${envPath}:`, err);
      }
    }
  }

  // userData ANTES do .env que veio dentro do instalador: o primeiro que
  // define uma variável vence, e o instalador é idêntico nas duas
  // máquinas. Sem esta ordem não há como trocar a chave de um terminal
  // (ou rotacioná-la) sem gerar um instalador novo.
  const candidates: string[] = [
    userDataEnv,
    legacyAppDataEnv1,
    legacyAppDataEnv2,
    process.resourcesPath ? join(process.resourcesPath, ".env") : "",
    join(process.cwd(), ".env"),
    join(import.meta.dirname, "../.env"),
    process.execPath ? join(process.execPath, "../.env") : "",
  ].filter(Boolean);

  for (const envPath of candidates) {
    if (!existsSync(envPath)) continue;
    try {
      const content = readFileSync(envPath, "utf8");
      for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;
        const eq = line.indexOf("=");
        if (eq === -1) continue;
        const key = line.slice(0, eq).trim();
        const value = line.slice(eq + 1).trim();
        if (!key) continue;

        // Auto-cura dos .env que o próprio app semeou errado: uma chave
        // PUBLICÁVEL numa das variáveis de credencial não serve para nada
        // (nem grava no banco, nem autoriza na Edge Function) e, vindo do
        // arquivo de maior precedência, impedia o valor bom de um arquivo
        // seguinte de ser usado. Ignorar aqui é o que faz o terminal se
        // consertar sozinho no primeiro boot depois da atualização.
        if (CREDENCIAIS_TERMINAL.has(key) && classifyTerminalKey(value) === "publishable") {
          console.warn(
            `[main] ${key} em ${envPath} contém a chave PUBLICÁVEL, que não autoriza nada — ignorando. ` +
              "Cole a chave secreta (sb_secret_...) desse terminal nesse arquivo.",
          );
          continue;
        }

        if (process.env[key] === undefined || process.env[key] === "") {
          process.env[key] = value;
        }
      }
      console.log(`[main] Carregou variáveis de ambiente de: ${envPath}`);
    } catch (err) {
      console.warn(`[main] Erro ao ler ${envPath}:`, err);
    }
  }

  // A chave achada num .env DENTRO da instalação (resources/ ou ao lado do
  // .exe) é apagada na próxima atualização, e o aviso de "chave não
  // configurada" voltava a cada versão. Copiar para o .env do userData, que
  // o instalador não toca, faz a chave sobreviver às atualizações.
  const chaveAtiva = process.env.FACAAMIGOS_SUPABASE_SECRET_KEY;
  if (userDataEnv && isUsableTerminalKey(chaveAtiva)) {
    try {
      if (persistTerminalKey(userDataEnv, chaveAtiva as string)) {
        console.log(`[main] Chave do terminal copiada para ${userDataEnv} (sobrevive a atualizações).`);
      }
    } catch (err) {
      console.warn(`[main] Não foi possível gravar a chave em ${userDataEnv}:`, err);
    }
  }
}

loadDotEnvFromCandidates();

/**
 * D1/D2 do plano: o Electron não fala com o banco diretamente — ele
 * sobe o mesmo servidor Fastify usado pelos tablets e carrega a UI a
 * partir dele. Isso garante que main (desktop) e tablets (LAN) rodam
 * exatamente o mesmo código de servidor e de SPA.
 */
const PORT = 7317;

// Uma única instância: reabrir o app deve focar a janela existente, não
// tentar subir um segundo servidor na mesma porta. app.quit() não interrompe
// a execução do resto deste módulo, então o guard abaixo evita que uma
// segunda instância tente registrar handlers e ouvir a mesma porta.
const isPrimaryInstance = app.requestSingleInstanceLock();
if (!isPrimaryInstance) {
  app.quit();
}

/**
 * Build da SPA: extraResources no app empacotado; dist do workspace em dev.
 *
 * `import.meta.dirname` aqui é sempre a pasta do bundle (`apps/kiosk/bundle`)
 * — main.ts só roda via `bundle/main.mjs`, empacotado ou não, nunca direto
 * da fonte TS. O caminho relativo tinha um "../" a mais e apontava para
 * `Faça Amigos/kiosk-ui/dist` (fora do repo) em vez de `apps/kiosk-ui/dist`.
 */
function resolveUiDist(): string {
  if (process.env.FACAAMIGOS_UI_DIST) return process.env.FACAAMIGOS_UI_DIST;
  if (app.isPackaged) return join(process.resourcesPath, "kiosk-ui");
  return join(import.meta.dirname, "../../kiosk-ui/dist");
}

async function startLocalServer() {
  // Os .sql de migração viajam como extraResources no app empacotado (ver
  // electron-builder.yml) — em dev não existe extraResources nenhum, então
  // aponta direto para o dist do pacote db-local (mesmo raciocínio de
  // resolveUiDist logo acima).
  if (!process.env.FACAAMIGOS_MIGRATIONS_DIR) {
    process.env.FACAAMIGOS_MIGRATIONS_DIR = app.isPackaged
      ? join(process.resourcesPath, "migrations")
      : join(import.meta.dirname, "../../../packages/db-local/dist/migrations");
  }

  const dbPath = process.env.FACAAMIGOS_DB_PATH ?? `${app.getPath("userData")}/facaamigos.db`;
  const db = openDatabase(dbPath);
  migrate(db);

  const nowMs = Date.now();
  if (process.env.FACAAMIGOS_SEED_DEV === "true") seedDevData(db, nowMs);

  // Garante o ID desta instalação já na subida, antes de qualquer tela
  // pedir: o print bridge precisa dele para reservar job, e depender da
  // UI chamar /api/system/device-id foi o que deixou o campo nulo em
  // produção por semanas.
  ensureDeviceId(db, nowMs);

  const hmacKey = randomBytes(32).toString("hex");
  // Tablets da LAN precisam de HTTPS (câmera exige contexto seguro); o
  // próprio Electron carrega de 127.0.0.1 e pode continuar em HTTP.
  const tls = process.env.FACAAMIGOS_TLS === "true" ? loadOrCreateTls(`${app.getPath("userData")}/certs`) : undefined;
  const server = await buildApp({ db, hmacKey, nowMs: () => Date.now() }, { tls, uiDist: resolveUiDist() });
  await server.listen({ port: PORT, host: "0.0.0.0" });
  return { tls, db };
}

function createWindow(protocol: "http" | "https", splash?: BrowserWindow) {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#141414",
    webPreferences: { preload: `${import.meta.dirname}/preload.js`, contextIsolation: true, nodeIntegration: false },
  });
  win.once("ready-to-show", () => {
    splash?.close();
    win.maximize();
    win.show();
  });
  win.loadURL(`${protocol}://127.0.0.1:${PORT}`);
  return win;
}

if (isPrimaryInstance) {
  app.on("second-instance", () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.maximize();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);

    // Permissão automática de câmera/mídia para o app Kiosk no Electron
    session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
      if (permission === "media" || permission === "notifications") {
        callback(true);
      } else {
        callback(false);
      }
    });

    session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
      if (permission === "media") {
        return true;
      }
      return false;
    });

    // Splash imediata: migrate + TLS + fiscal levam alguns segundos e a
    // janela principal só aparece no ready-to-show da SPA.
    const splash = new BrowserWindow({
      width: 420,
      height: 280,
      frame: false,
      resizable: false,
      alwaysOnTop: true,
      backgroundColor: "#F0196B",
    });
    splash.loadURL(splashDataUrl);

    // Inicia junto com o Windows no terminal de loja (só no app instalado —
    // em dev isso registraria o binário do node_modules).
    if (app.isPackaged) {
      app.setLoginItemSettings({ openAtLogin: true });
      initAutoUpdater();
    }

    // Sem isso, qualquer falha em startLocalServer/createWindow (porta
    // ocupada, migração quebrada, TLS sem permissão de escrita) virava uma
    // unhandledRejection silenciosa e a splash "Iniciando o sistema..."
    // ficava travada para sempre, sem nenhum aviso pro usuário.
    let serverRes: Awaited<ReturnType<typeof startLocalServer>>;
    try {
      serverRes = await startLocalServer();
    } catch (err) {
      console.error("[main] falha ao iniciar o servidor local:", err);
      dialog.showErrorBox(
        "Falha ao iniciar o sistema",
        `Não foi possível iniciar o FaçaAmigos.\n\n${err instanceof Error ? err.message : String(err)}`,
      );
      splash.close();
      app.quit();
      return;
    }
    const protocol = serverRes.tls ? "https" : "http";

    // O certificado é o mesmo que acabamos de gerar/carregar em disco —
    // confiar nele aqui é aceitável porque a origem é local, não terceira.
    if (serverRes.tls) {
      app.on("certificate-error", (event, _webContents, url, _error, _certificate, callback) => {
        if (url.startsWith(`https://127.0.0.1:${PORT}`)) {
          event.preventDefault();
          callback(true);
        } else {
          callback(false);
        }
      });
    }

    // Fonte da verdade para a tela Configurações > Impressoras validar o
    // nome digitado: o print bridge usa esse mesmo nome literal em
    // OpenPrinterA/webContents.print, então um typo aqui é impressão
    // silenciosamente falhando sem nada na fila do Windows.
    //
    // Registrado antes de createWindow/loadURL para não deixar a SPA
    // invocar "list-printers" antes do handler existir (o preload injeta a
    // função na primeira carga, então uma renderização rápida podia chegar
    // aqui primeiro e cair no catch como "nenhuma impressora encontrada").
    //
    // getPrintersAsync() sozinho (backend de impressão do Chromium) pode
    // voltar vazio mesmo com uma impressora instalada e funcionando em
    // outros programas — combinamos com um fallback via `Get-Printer`
    // (spooler do Windows, mesma família de API que a impressão RAW usa em
    // rawPrint.ts) para pegar impressoras que só aparecem em um dos dois.
    // eslint-disable-next-line prefer-const -- atribuída logo abaixo antes de qualquer chamada IPC poder disparar; `const` exigiria inverter a ordem e reabrir a race que este comentário evita.
    let mainWindow: BrowserWindow;
    ipcMain.handle("list-printers", async () => {
      return listWindowsPrinters(() => mainWindow.webContents.getPrintersAsync());
    });

    mainWindow = createWindow(protocol, splash);

    // Permite colar a chave pela tela Configurações (sem editar .env à mão).
    // IPC e não rota HTTP: o Fastify escuta em 0.0.0.0, e um segredo não pode
    // ser gravável por qualquer tablet da LAN.
    // Token do aparelho (primeiro fator antes do PIN). Fica em userData, cifrado
    // com safeStorage quando disponível, e sobrevive à troca http<->https da SPA.
    const deviceTokenPath = join(app.getPath("userData"), "device-token.bin");
    ipcMain.handle("device-token-get", () => {
      try {
        if (!existsSync(deviceTokenPath)) return null;
        const raw = readFileSync(deviceTokenPath);
        return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : raw.toString("utf8");
      } catch {
        return null;
      }
    });
    ipcMain.handle("device-token-set", (_event, token: unknown) => {
      if (typeof token !== "string" || token.length < 32 || token.length > 128) return;
      writeFileSync(deviceTokenPath, safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(token) : Buffer.from(token, "utf8"));
    });
    ipcMain.handle("device-token-clear", () => {
      rmSync(deviceTokenPath, { force: true });
    });

    ipcMain.handle("save-terminal-key", (_event, key: unknown) => {
      if (typeof key !== "string" || classifyTerminalKey(key) !== "secret") {
        return { ok: false, error: "Cole a chave secreta que começa com sb_secret_ (não a publicável nem a eyJ...)." };
      }
      try {
        persistTerminalKey(join(app.getPath("userData"), ".env"), key);
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      // Reinicia para a ponte de impressão e o worker fiscal subirem com a chave nova.
      setTimeout(() => {
        app.relaunch();
        app.exit(0);
      }, 500);
      return { ok: true };
    });

    // Sem isto, a ponte de impressão falhava só com um console.warn: o
    // terminal parecia funcionar normalmente, mas nenhuma pulseira/recibo
    // saía e ninguém no balcão descobria até a família já ter ido embora.
    const printBridgeResult = startPrintBridge(serverRes.db);
    if (!printBridgeResult.started) {
      console.warn(`[main] Impressão automática desligada: ${printBridgeResult.reason}`);
    }

    // Emissão fiscal (Fase 3 do plano): try/catch explícito e captura de
    // rejeições não tratadas — um erro aqui NUNCA pode derrubar a impressão
    // de pulseira/cupom, que é o que trava o balcão na hora. O print bridge
    // acima não tem essa proteção porque foi escrito antes; o worker fiscal
    // não repete essa lacuna.
    try {
      startFiscalWorker(app.getPath("userData"), ensureDeviceId(serverRes.db, Date.now()));
    } catch (err) {
      console.error("[fiscal] falha ao iniciar o worker fiscal — emissão de NFC-e desligada neste terminal:", err);
    }
    process.on("unhandledRejection", (reason) => {
      console.error("[fiscal] rejeição não tratada no worker fiscal:", reason);
    });

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(protocol);
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform === "darwin") return;

    // Antes o quiosque disparava checkForUpdates() (fire-and-forget) e
    // chamava app.quit() logo em seguida — o processo morria antes do
    // instalador (~100 MB) terminar de baixar, então autoInstallOnAppQuit
    // nunca tinha nada pronto para instalar e o app ficava preso na
    // versão antiga não importa quantas vezes fosse reaberto/fechado.
    // Agora o fechamento aguarda a checagem (e o download, se houver
    // atualização) terminar antes de encerrar o processo de fato.
    //
    // Com atualização baixada, instala via quitAndInstall explícito em vez
    // de confiar no autoInstallOnAppQuit: no ciclo 0.1.5→0.1.6 o app era
    // reaberto segundos após o quit e a nova instância travava os arquivos
    // em Program Files antes do instalador NSIS terminar — o terminal
    // reabria ainda na versão antiga. quitAndInstall(true, true) fecha,
    // instala em silêncio e é o PRÓPRIO instalador que reabre o app já
    // atualizado, eliminando a corrida.
    if (app.isPackaged) {
      void checkForUpdatesAndWait().finally(() => {
        if (getUpdateStatus().status === "downloaded") {
          applyUpdate();
        } else {
          app.quit();
        }
      });
    } else {
      app.quit();
    }
  });
}
