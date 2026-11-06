#!/usr/bin/env node
/**
 * Falha se houver migration no repositório que não foi aplicada no banco real.
 *
 * Por quê: a regra de saldo de pacote (#189) ficou semanas no repositório sem
 * ser aplicada, e o balcão seguiu cobrando plano avulso de quem tinha saldo.
 *
 * Compara por NOME (o banco regrava a versão com o horário em que aplicou, ex.:
 * repo 20261023120000 vs banco 20261023154643). Só olha repo -> banco: o banco
 * tem migrations de outros projetos que não existem aqui.
 *
 * Env: SUPABASE_ACCESS_TOKEN (token pessoal, escopo de leitura) e, opcional,
 * SUPABASE_PROJECT_REF (padrão: supabase/.temp/project-ref).
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** "20261104120000_fa_x.sql" -> "fa_x" */
export function migrationName(file) {
  return file.replace(/\.sql$/, "").replace(/^\d+_/, "");
}

export function pendingMigrations(repoFiles, appliedNames) {
  const applied = new Set(appliedNames);
  return repoFiles.filter((f) => f.endsWith(".sql") && !applied.has(migrationName(f))).sort();
}

async function main() {
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  if (!token) {
    console.error("SUPABASE_ACCESS_TOKEN ausente: sem ele a checagem não roda (e não deve passar em silêncio).");
    process.exit(2);
  }
  const refFile = join(root, "supabase/.temp/project-ref");
  const ref = process.env.SUPABASE_PROJECT_REF ?? (existsSync(refFile) ? readFileSync(refFile, "utf8").trim() : "ivjvpdzsfjdpyabbzzuj");

  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/migrations`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    console.error(`Falha ao listar migrations (${res.status}).`);
    process.exit(2);
  }
  const applied = (await res.json()).map((m) => m.name);
  const pending = pendingMigrations(readdirSync(join(root, "supabase/migrations")), applied);

  if (pending.length === 0) {
    console.log("Sem drift: todas as migrations do repositório estão aplicadas.");
    return;
  }
  console.error(`DRIFT: ${pending.length} migration(s) no repositório não aplicada(s) no banco:`);
  for (const f of pending) console.error(`  - ${f}`);
  process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
