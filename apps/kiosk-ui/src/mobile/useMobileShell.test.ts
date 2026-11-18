import { describe, expect, it } from "vitest";
import { mobileShellAllowedFor } from "./useMobileShell.js";

describe("mobileShellAllowedFor", () => {
  it("nunca libera a casca mobile para o Avaliador", () => {
    expect(mobileShellAllowedFor("AVALIADOR")).toBe(false);
  });

  it("mantém a casca mobile para os demais papéis e para quem ainda não logou", () => {
    for (const role of ["ESTAGIARIO", "OPERADOR", "GERENTE", "ADMIN", "PRESTADOR_PJ", null, undefined]) {
      expect(mobileShellAllowedFor(role)).toBe(true);
    }
  });
});
