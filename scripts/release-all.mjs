// Script de manutenção: publica uma nova versão completa do sistema.
//
// Faz, em sequência:
//   1. Confere se a branch está limpa e sincronizada com o remoto (avisa, não bloqueia).
//   2. Builda e publica o instalador do kiosk (Electron) no feed de auto-update
//      (update.institutofacaamigos.com.br) — via scripts/release-kiosk.mjs.
//   3. Faz deploy de produção do kiosk-ui (PWA) no Vercel — normalmente já é
//      automático via integração Git, mas aqui garante que a versão publicada
//      bate com o commit atual mesmo se o deploy automático falhar ou atrasar.
//
// Uso: pnpm release:all
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const kioskUiDir = join(root, "apps", "kiosk-ui");

function run(cmd, cwd) {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { stdio: "inherit", cwd: cwd ?? root, shell: true });
}

function runCapture(cmd, cwd) {
  return execSync(cmd, { cwd: cwd ?? root, shell: true }).toString().trim();
}

// 1. Checagem de estado do git (apenas aviso — não interrompe a manutenção)
const branch = runCapture("git rev-parse --abbrev-ref HEAD");
const dirty = runCapture("git status --porcelain");
if (dirty) {
  console.warn(`\n⚠️  Há alterações não commitadas na branch "${branch}". A versão publicada pode não refletir o que está no repositório remoto.`);
}
if (branch !== "main") {
  console.warn(`\n⚠️  Você não está na branch "main" (está em "${branch}").`);
}

// 2. Kiosk (Electron): build do instalador + publicação no feed do auto-updater
console.log("\n=== 1/2 — Publicando instalador do kiosk (Electron) ===");
run("pnpm release:kiosk");

// 3. Kiosk-UI (PWA): o deploy de produção na Vercel já é automático pela
// integração Git a cada push na main. Rodar `vercel --prod` aqui gerava um
// build duplicado (cobrado) do mesmo commit. Só use a opção --vercel se o
// deploy automático falhou e é preciso forçar.
if (process.argv.includes("--vercel")) {
  console.log("\n=== 2/2 — Forçando deploy do kiosk-ui (PWA) no Vercel ===");
  run("npx vercel link --yes --project kiosk-ui", kioskUiDir);
  run("npx vercel --prod --yes", kioskUiDir);
  console.log("\n✅ Manutenção concluída: kiosk (instalador) e kiosk-ui (PWA) publicados.");
} else {
  console.log("\n✅ Instalador publicado. O PWA na Vercel é publicado pelo push na main (use --vercel para forçar).");
}
