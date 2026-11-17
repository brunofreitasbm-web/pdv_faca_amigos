// deno test supabase/functions/_shared/deviceGate.test.ts
import { generateEnrollCode, normalizeEnrollCode, generateDeviceToken } from "./deviceCodes.ts";
import { sha256Hex } from "./deviceGate.ts";

Deno.test("código tem 8 chars sem ambíguos", () => {
  for (let i = 0; i < 200; i++) {
    const c = generateEnrollCode();
    if (!/^[A-HJKMNP-Z2-9]{8}$/.test(c)) throw new Error(`código inválido ${c}`);
  }
});
Deno.test("normaliza código digitado", () => {
  if (normalizeEnrollCode("ab-cd 23x9") !== "ABCD23X9") throw new Error("normalização");
});
Deno.test("token tem 64 hex e sha256 é estável", async () => {
  if (!/^[0-9a-f]{64}$/.test(generateDeviceToken())) throw new Error("token");
  const h = await sha256Hex("abc");
  if (h !== "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad") throw new Error("sha256");
});
