import { test } from "node:test";
import assert from "node:assert/strict";
import { migrationName, pendingMigrations } from "./check-migration-drift.mjs";

test("nome ignora o prefixo de versão", () => {
  assert.equal(migrationName("20261104120000_fa_guardian_package_mode.sql"), "fa_guardian_package_mode");
});

test("aplicada com versão diferente não é drift; ausente é", () => {
  const repo = ["20261023120000_fa_checkout_child_credit_usa_pacote.sql", "20261104120000_fa_guardian_package_mode.sql"];
  assert.deepEqual(pendingMigrations(repo, ["fa_checkout_child_credit_usa_pacote", "biofit_garmin_get"]), [
    "20261104120000_fa_guardian_package_mode.sql",
  ]);
});
