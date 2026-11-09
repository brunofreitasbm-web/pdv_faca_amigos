import { app, ipcMain, BrowserWindow } from "electron";
import electronUpdater from "electron-updater";
import log from "electron-log";

function getAutoUpdater() {
  try {
    return electronUpdater.autoUpdater;
  } catch {
    return null;
  }
}

if (log?.transports) {
  log.transports.file.level = "info";
  log.transports.console.level = false;
}

export interface UpdateState {
  status: "idle" | "checking" | "available" | "downloaded" | "error";
  version?: string;
  progress?: number;
  error?: string;
}

let currentUpdateState: UpdateState = {
  status: "idle",
  version: typeof app?.getVersion === "function" ? app.getVersion() : "dev",
};

let initialized = false;
let versaoPendente: string | undefined;

const PERIODIC_CHECK_INTERVAL_MS = 15 * 60 * 1000;
const VERIFICACAO_JANELA_INTERVAL_MS = 5 * 60 * 1000;

// O terminal NÃO fica ligado 24/7 — a loja liga o PC por volta das 10h e
// desliga por volta das 22h. E "desliga" aqui é energia cortada, não um
// "Desligar" do Windows com tempo de sobra: o processo simplesmente morre.
//
// Consequência: `window-all-closed` (main.ts), que é onde mora o outro
// caminho de instalação, praticamente NUNCA roda em produção. Ninguém fecha
// o quiosque; a tomada é que fecha.
//
// Sobrava então uma única janela real de instalação: os primeiros minutos
// após o boot. E ela era curta demais — 5 minutos para baixar um instalador
// de ~105 MB exige ~2,8 Mbps sustentados desde o instante do boot. Na
// prática o download terminava fora da janela, o app logava "não instala
// agora, fica pendente para o fechamento" e o fechamento nunca vinha. No dia
// seguinte o ciclo se repetia idêntico. Foi assim que a loja ficou presa na
// 0.1.5, depois na 0.1.21, e de novo na 0.1.35 com a 0.1.36 já publicada e
// íntegra no feed.
//
// Agora existem TRÊS janelas, e nenhuma depende de o download ser rápido:
//
//   1. Abertura do dia — o app subiu há pouco e ninguém está atendendo
//      ainda. Prazo generoso (30 min), não 5.
//   2. Pré-fechamento — a partir de PRE_FECHAMENTO_HORA a loja está
//      encerrando; instalar aqui aproveita a única janela ociosa garantida
//      do dia, ANTES de a energia cair. É o caminho que substitui o
//      `window-all-closed` que nunca acontece.
//   3. Fora do expediente — terminal ligado antes de abrir ou depois de
//      fechar (teste, manutenção, boot fora de hora): não há atendimento
//      em risco, instala.
//
// Em qualquer uma delas o quitAndInstall(true, true) fecha, instala em
// silêncio e o próprio instalador reabre o app. Dentro do expediente e fora
// dessas janelas, continua sem forçar: um atendimento em curso não é
// interrompido — a instalação fica pendente e o verificador periódico a
// aplica assim que a primeira janela abrir, no mesmo dia.
const STARTUP_INSTALL_GRACE_MS = 30 * 60 * 1000;
const appStartMs = Date.now();

// Horário da operação (Belém, sem horário de verão). Sobrescrevíveis por
// ambiente para as unidades que fogem do padrão do shopping.
const numeroDoAmbiente = (nome: string, padrao: number): number => {
  const bruto = process.env[nome];
  if (!bruto) return padrao;
  const valor = Number.parseInt(bruto, 10);
  return Number.isInteger(valor) && valor >= 0 && valor <= 23 ? valor : padrao;
};
const ABERTURA_HORA = numeroDoAmbiente("FACAAMIGOS_ABERTURA_HORA", 10);
const FECHAMENTO_HORA = numeroDoAmbiente("FACAAMIGOS_FECHAMENTO_HORA", 22);
// 21h: dá ~1h de folga antes do corte de energia das 22h. O instalador NSIS
// leva segundos, mas o app precisa subir de novo depois — e é melhor que
// isso aconteça com a loja ainda de pé do que na corrida do fechamento.
const PRE_FECHAMENTO_HORA = numeroDoAmbiente("FACAAMIGOS_PRE_FECHAMENTO_HORA", FECHAMENTO_HORA - 1);

type MotivoInstalacao = "abertura" | "pre-fechamento" | "fora-do-expediente";

export function motivoParaInstalarAgora(agora = new Date(), iniciadoEm = appStartMs): MotivoInstalacao | null {
  const hora = agora.getHours();
  if (agora.getTime() - iniciadoEm < STARTUP_INSTALL_GRACE_MS) return "abertura";
  if (hora < ABERTURA_HORA || hora >= FECHAMENTO_HORA) return "fora-do-expediente";
  if (hora >= PRE_FECHAMENTO_HORA) return "pre-fechamento";
  return null;
}

function notifyWindows(state: UpdateState): void {
  currentUpdateState = state;
  if (typeof BrowserWindow?.getAllWindows === "function") {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send("update-status-change", state);
      }
    }
  }
}

export function getUpdateStatus(): UpdateState {
  return currentUpdateState;
}

export function applyUpdate(): void {
  const autoUpdater = getAutoUpdater();
  if (!app?.isPackaged || !autoUpdater) {
    log?.info?.("[auto-updater] Modo dev ou testes — simulação de applyUpdate.");
    return;
  }
  log?.info?.("[auto-updater] quitAndInstall acionado pelo usuário/sistema.");
  // isSilent: o terminal é um quiosque sem operador acompanhando — o NSIS
  // nunca pode abrir janela de instalador. isForceRunAfter: o app precisa
  // voltar sozinho depois da atualização (terminal sempre ligado).
  autoUpdater.quitAndInstall(true, true);
}

export function checkForUpdates(): void {
  const autoUpdater = getAutoUpdater();
  if (!app?.isPackaged || !autoUpdater) return;
  notifyWindows({ ...currentUpdateState, status: "checking" });
  void autoUpdater.checkForUpdatesAndNotify().catch((err) => {
    log?.warn?.("[auto-updater] Falha ao verificar atualizações:", err);
    notifyWindows({
      ...currentUpdateState,
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

export function checkForUpdatesAndWait(timeoutMs = 5 * 60 * 1000): Promise<void> {
  const autoUpdater = getAutoUpdater();
  if (!app?.isPackaged || !autoUpdater) return Promise.resolve();

  return new Promise((resolve) => {
    let settled = false;
    // eslint-disable-next-line prefer-const -- atribuído depois de cleanup/onSettle (referência circular)
    let timer: ReturnType<typeof setTimeout>;

    const cleanup = () => {
      clearTimeout(timer);
      autoUpdater.off("update-not-available", onSettle);
      autoUpdater.off("update-downloaded", onSettle);
      autoUpdater.off("error", onError);
    };

    const onSettle = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };

    const onError = (err: unknown) => {
      log?.warn?.("[auto-updater] Falha ao verificar/baixar atualização antes de fechar:", err);
      onSettle();
    };

    timer = setTimeout(() => {
      log?.warn?.(`[auto-updater] Timeout de ${timeoutMs}ms aguardando atualização antes de fechar — prosseguindo com o fechamento.`);
      onSettle();
    }, timeoutMs);

    autoUpdater.once("update-not-available", onSettle);
    autoUpdater.once("update-downloaded", onSettle);
    autoUpdater.once("error", onError);

    void autoUpdater.checkForUpdates().catch(onError);
  });
}

function aplicarSeHouverJanela(contexto: string): void {
  const motivo = motivoParaInstalarAgora();
  if (motivo) {
    log?.info?.(`[auto-updater] ${contexto} — janela "${motivo}" aberta, instalando agora.`);
    applyUpdate();
    return;
  }
  log?.info?.(
    `[auto-updater] ${contexto} — expediente em curso, não interrompe atendimento. Nova tentativa em ${VERIFICACAO_JANELA_INTERVAL_MS / 60000} min (instala no máximo às ${PRE_FECHAMENTO_HORA}h).`,
  );
}

export function initAutoUpdater(): void {
  if (typeof ipcMain?.handle === "function") {
    ipcMain.handle("get-app-version", () => (app?.getVersion ? app.getVersion() : "0.1.13-dev"));
    ipcMain.handle("get-update-status", () => getUpdateStatus());
    ipcMain.handle("check-for-updates", () => {
      checkForUpdates();
      return getUpdateStatus();
    });
    ipcMain.handle("apply-update", () => {
      applyUpdate();
    });
  }

  const autoUpdater = getAutoUpdater();
  if (!app?.isPackaged || !autoUpdater) {
    log?.info?.("[auto-updater] Ignorado em ambiente de desenvolvimento ou teste.");
    return;
  }
  if (initialized) return;
  initialized = true;


  log.info(`[auto-updater] App versão atual: ${app.getVersion()} — log em: ${log.transports.file.getFile().path}`);

  const customFeedUrl = process.env.FACAAMIGOS_UPDATE_URL;
  if (customFeedUrl) {
    try {
      autoUpdater.setFeedURL({
        provider: "generic",
        url: customFeedUrl,
      });
      log.info(`[auto-updater] Feed de atualização configurado para: ${customFeedUrl}`);
    } catch (err) {
      log.warn("[auto-updater] Falha ao definir custom feed URL:", err);
    }
  }

  autoUpdater.logger = log;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  // Download diferencial LIGADO: o terminal baixa só os blocos que mudaram em
  // vez dos ~105 MB inteiros a cada release (o tráfego sai do Supabase
  // Storage). Como funciona no electron-updater 6.8.x:
  //   - o blockmap da versão instalada vem primeiro de um cache local
  //     (current.blockmap) e, se não existir, do feed, pelo nome da versão
  //     antiga. scripts/release-kiosk.mjs mantém os últimos blockmaps no
  //     bucket justamente por isso;
  //   - qualquer falha (blockmap ou instalador antigo ausente, servidor sem
  //     multi-range) cai sozinha no download completo, ou seja, o pior caso é
  //     o comportamento anterior.
  // A primeira atualização depois desta mudança ainda é completa em terminais
  // que nunca gravaram o cache local; o ganho aparece a partir da seguinte.
  // O feed (Supabase Storage) responde 206 a range request. O comentário
  // antigo sobre o "CDN da Vercel" não vale mais: o feed não está lá.
  autoUpdater.disableDifferentialDownload = false;
  autoUpdater.disableWebInstaller = true;

  autoUpdater.on("checking-for-update", () => {
    log.info("[auto-updater] Verificando se existem novas atualizações...");
    notifyWindows({ ...currentUpdateState, status: "checking" });
  });

  autoUpdater.on("update-available", (info) => {
    log.info(`[auto-updater] Nova versão ${info.version} encontrada. Baixando em segundo plano...`);
    notifyWindows({
      status: "available",
      version: info.version,
      progress: 0,
    });
  });

  autoUpdater.on("update-not-available", () => {
    log.info("[auto-updater] O aplicativo já está na versão mais recente.");
    notifyWindows({
      status: "idle",
      version: app.getVersion(),
    });
  });

  autoUpdater.on("download-progress", (progressObj) => {
    const percent = Math.round(progressObj.percent);
    log.info(`[auto-updater] Download em andamento: ${percent}% (${progressObj.bytesPerSecond} B/s)`);
    notifyWindows({
      ...currentUpdateState,
      status: "available",
      progress: percent,
    });
  });

  autoUpdater.on("error", (err) => {
    log.warn("[auto-updater] Erro durante verificação de atualização:", err);
    notifyWindows({
      ...currentUpdateState,
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    });
  });

  autoUpdater.on("update-downloaded", (info) => {
    log.info(`[auto-updater] Versão ${info.version} baixada e pronta para ser aplicada.`);
    notifyWindows({
      status: "downloaded",
      version: info.version,
      progress: 100,
    });

    versaoPendente = info.version;
    aplicarSeHouverJanela(`versão ${info.version} recém-baixada`);
  });

  checkForUpdates();

  setInterval(checkForUpdates, PERIODIC_CHECK_INTERVAL_MS);

  // Verificador independente do ciclo de download. Sem ele, uma atualização
  // que termina de baixar às 11h só teria uma nova chance de ser instalada
  // se o `update-downloaded` fosse reemitido — o que depende de o
  // electron-updater revalidar o arquivo de ~105 MB em cache a cada
  // checagem, e qualquer falha nessa revalidação cai no handler de `error`,
  // não no de instalação. Este timer olha só o estado local: havendo
  // atualização baixada e uma janela aberta, instala. É ele que garante que
  // a versão baixada de manhã entre no ar às 21h do MESMO dia, em vez de
  // esperar um `window-all-closed` que a queda de energia nunca dispara.
  setInterval(() => {
    if (currentUpdateState.status !== "downloaded") return;
    aplicarSeHouverJanela(`versão ${versaoPendente ?? currentUpdateState.version} pendente desde o download`);
  }, VERIFICACAO_JANELA_INTERVAL_MS);
}

