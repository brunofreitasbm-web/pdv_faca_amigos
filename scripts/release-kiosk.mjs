// Publica uma nova versão do instalador do kiosk no feed do auto-updater
// (Supabase Storage, bucket público "kiosk-updates").
//
// Fluxo: builda o instalador (pnpm dist:kiosk) -> apaga versões antigas do
// bucket -> sobe os artefatos (.exe, .blockmap, latest.yml).
//
// Requer FACAAMIGOS_SUPABASE_URL e FACAAMIGOS_SUPABASE_SERVICE_ROLE_KEY em
// apps/kiosk/.env (mesma credencial já usada pelo print bridge local).
//
// Uso: pnpm release:kiosk
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const kioskDir = join(root, "apps", "kiosk");
const releaseDir = join(kioskDir, "release");
const BUCKET = "kiosk-updates";
// FACAAMIGOS_RELEASE_PREFIX permite publicar num prefixo de teste (ex.:
// "kiosk-piloto") e apontar UM terminal para ele via FACAAMIGOS_UPDATE_URL,
// sem tocar no feed dos terminais em operação.
const PREFIX = process.env.FACAAMIGOS_RELEASE_PREFIX?.trim() || "kiosk";
// Quantos .blockmap anteriores manter no bucket (cada um tem poucas centenas
// de KB). O electron-updater, no download diferencial, busca o blockmap da
// versão que o terminal tem instalada; sem ele cai no download completo.
const BLOCKMAPS_A_MANTER = 30;

function run(cmd, cwd) {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { stdio: "inherit", cwd: cwd ?? root, shell: true });
}

function loadEnv(envPath) {
  const env = {};
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match) env[match[1]] = match[2].trim();
  }
  return env;
}

// As variáveis de ambiente vêm ANTES do arquivo, de propósito: o
// electron-builder embute apps/kiosk/.env dentro do instalador
// (extraResources). Se o CI criasse esse arquivo só para publicar, a chave
// voltaria a viajar dentro de cada instalador distribuído — exatamente o
// que a remoção da chave embutida corrigiu. Com env vars, o publish tem a
// credencial e o instalador não.
const envPath = join(kioskDir, ".env");
const fileEnv = existsSync(envPath) ? loadEnv(envPath) : {};
const pick = (...names) => {
  for (const name of names) {
    const value = process.env[name] ?? fileEnv[name];
    if (value && value.trim()) return value.trim();
  }
  return undefined;
};

const supabaseUrl = pick("FACAAMIGOS_SUPABASE_URL");
// Aceita o nome novo (sb_secret_..., rotacionável sozinho) e mantém o
// antigo funcionando para não quebrar um .env já preenchido.
const serviceRoleKey = pick("FACAAMIGOS_SUPABASE_SECRET_KEY", "FACAAMIGOS_SUPABASE_SERVICE_ROLE_KEY");
if (!supabaseUrl || !serviceRoleKey) {
  throw new Error(
    "FACAAMIGOS_SUPABASE_URL / FACAAMIGOS_SUPABASE_SECRET_KEY ausentes — " +
      `defina como variáveis de ambiente (preferido, não entra no instalador) ou em ${envPath}.`,
  );
}

async function storageFetch(path, options, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`${supabaseUrl}/storage/v1${path}`, {
        ...options,
        headers: {
          Authorization: `Bearer ${serviceRoleKey}`,
          apikey: serviceRoleKey,
          ...options.headers,
        },
      });
      if (!res.ok) {
        throw new Error(`Storage ${options.method ?? "GET"} ${path} -> ${res.status}: ${await res.text()}`);
      }
      return res;
    } catch (err) {
      if (attempt === retries) throw err;
      console.warn(`[storageFetch] Tentativa ${attempt}/${retries} falhou (${err instanceof Error ? err.message : String(err)}). Tentando novamente em 3s...`);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

// 1. Build do instalador (workspace + kiosk-ui + ícones + electron-builder).
// No CI o build já foi feito (e testado) no job Windows anterior e o artifact
// foi baixado para apps/kiosk/release: --skip-build publica exatamente esse
// binário em vez de refazer tudo. Uso local sem a flag continua igual.
if (process.argv.includes("--skip-build")) {
  console.log("\n--skip-build: usando o instalador já gerado em apps/kiosk/release");
} else {
  run("pnpm dist:kiosk");
}

// 1b. Mesma guarda que o CI faz (build-kiosk.yml), porque o build LOCAL é
// o caso perigoso: aqui apps/kiosk/.env existe de verdade, e o destino do
// upload logo abaixo é um bucket PÚBLICO. Um extraResource `.env` que
// voltasse ao electron-builder.yml publicaria a chave secreta do projeto
// para qualquer um baixar. Falhar antes do upload é a única proteção que
// funciona nos dois ambientes.
const envEmbutido = join(kioskDir, "release", "win-unpacked", "resources", ".env");
if (existsSync(envEmbutido)) {
  throw new Error(
    `O instalador levaria um .env embutido (${envEmbutido}) e o bucket "${BUCKET}" é público. ` +
      "Remova o extraResource `.env` de apps/kiosk/electron-builder.yml antes de publicar.",
  );
}

// 2. Descobre a versão publicada a partir do latest.yml recém-gerado
const latestYmlPath = join(releaseDir, "latest.yml");
if (!existsSync(latestYmlPath)) {
  throw new Error(`latest.yml não encontrado em ${latestYmlPath} — build do electron-builder falhou?`);
}
const latestYmlContent = readFileSync(latestYmlPath, "utf-8");
const version = latestYmlContent.match(/^version:\s*(\S+)/m)?.[1];
if (!version) throw new Error("Não consegui extrair a versão de latest.yml");
console.log(`\nVersão a publicar: ${version}`);

// 3. Remove instaladores de versões antigas do bucket (o electron-updater só
// precisa do mais recente; deixar os antigos só desperdiça espaço). Os
// .exe.blockmap são pequenos e NÃO são apagados de imediato: o download
// diferencial precisa do blockmap da versão instalada no terminal (ver
// autoUpdater.ts). Mantemos os mais recentes e apagamos só o excedente.
console.log("\nListando arquivos antigos no bucket...");
const listRes = await storageFetch(`/object/list/${BUCKET}`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ prefix: `${PREFIX}/`, limit: 200 }),
});
const existing = await listRes.json();
const nomes = existing.map((f) => f.name);

const versaoDe = (name) => {
  const m = name.match(/(\d+)\.(\d+)\.(\d+)\.exe\.blockmap$/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};
const comparaVersao = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

const exesAntigos = nomes.filter((name) => name.endsWith(".exe"));
const blockmaps = nomes
  .filter((name) => name.endsWith(".exe.blockmap") && versaoDe(name))
  // a versão que estamos publicando será reenviada (x-upsert), não conta como "antiga"
  .filter((name) => name !== `FacaAmigos-Setup-${version}.exe.blockmap`)
  .sort((a, b) => comparaVersao(versaoDe(b), versaoDe(a))); // mais novos primeiro
// Sobra 1 vaga para o blockmap que vai ser enviado agora.
const blockmapsExcedentes = blockmaps.slice(Math.max(BLOCKMAPS_A_MANTER - 1, 0));
// Blockmap sem versão reconhecível no nome: comportamento antigo (apaga).
const blockmapsSemVersao = nomes.filter((name) => name.endsWith(".exe.blockmap") && !versaoDe(name));

const staleFiles = [...exesAntigos, ...blockmapsExcedentes, ...blockmapsSemVersao];
if (staleFiles.length > 0) {
  console.log(`Removendo: ${staleFiles.join(", ")}`);
  await storageFetch(`/object/${BUCKET}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prefixes: staleFiles.map((name) => `${PREFIX}/${name}`) }),
  });
}
console.log(`Blockmaps mantidos no bucket: ${Math.min(blockmaps.length, BLOCKMAPS_A_MANTER - 1)} anteriores + o desta versão.`);

// 4. Sobe os artefatos novos (x-upsert sobrescreve se já existir)
//
// `comoSeChama` existe por causa do ATUAL_EXE. O passo 3 acima apaga do
// bucket todo arquivo terminado em .exe, então qualquer link que carregue o
// número da versão dentro (…-0.1.37.exe) vira 404 na publicação seguinte —
// e é justamente esse link que se manda para o operador de loja baixar o
// instalador à mão quando um terminal precisa ser recolocado na versão
// certa. A cópia de nome fixo resolve: mesmo binário, endereço estável, que
// pode ser distribuído uma vez e continuar valendo. O electron-updater
// ignora esse arquivo (ele só lê o que o latest.yml aponta); custa ~105 MB
// a mais no bucket, que é o preço de um link que não quebra.
const ATUAL_EXE = "FacaAmigos-Setup-atual.exe";
const uploads = [
  { file: `FacaAmigos-Setup-${version}.exe`, contentType: "application/x-msdownload" },
  { file: `FacaAmigos-Setup-${version}.exe`, comoSeChama: ATUAL_EXE, contentType: "application/x-msdownload" },
  { file: `FacaAmigos-Setup-${version}.exe.blockmap`, contentType: "application/octet-stream" },
  { file: "latest.yml", contentType: "text/yaml" },
];
for (const { file, comoSeChama, contentType } of uploads) {
  const destino = comoSeChama ?? file;
  console.log(`Enviando ${destino}${comoSeChama ? ` (cópia de ${file})` : ""}...`);
  const body = readFileSync(join(releaseDir, file));
  await storageFetch(`/object/${BUCKET}/${PREFIX}/${destino}`, {
    method: "POST",
    headers: { "Content-Type": contentType, "x-upsert": "true" },
    body,
  });
}

const feedUrl = `${supabaseUrl}/storage/v1/object/public/${BUCKET}/${PREFIX}`;
console.log(`\n✅ Kiosk v${version} publicado em ${feedUrl}/`);
console.log(`   Link fixo para instalação manual: ${feedUrl}/${ATUAL_EXE}`);
