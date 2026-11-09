import { describe, expect, it, vi } from "vitest";
import { createCapabilitiesSync } from "./capabilitiesSync.js";

function setup(fetchImpl?: (n: number) => Promise<string[]>) {
  let calls = 0;
  const fetchCapabilities = vi.fn(() => fetchImpl?.(++calls) ?? Promise.resolve([`caps-${++calls}`]));
  const setCapabilities = vi.fn();
  const setLoading = vi.fn();
  const { sync } = createCapabilitiesSync<string[]>({
    fetchCapabilities,
    setCapabilities,
    setLoading,
    empty: () => [],
  });
  return { sync, fetchCapabilities, setCapabilities, setLoading };
}

describe("createCapabilitiesSync", () => {
  it("consulta uma única vez quando getSession e INITIAL_SESSION chegam juntos", async () => {
    const t = setup();
    await Promise.all([t.sync("u1"), t.sync("u1")]);
    expect(t.fetchCapabilities).toHaveBeenCalledTimes(1);
    expect(t.setLoading).toHaveBeenLastCalledWith(false);
  });

  it("não consulta nem liga loading em SIGNED_IN repetido do mesmo usuário", async () => {
    const t = setup();
    await t.sync("u1");
    t.setLoading.mockClear();
    await t.sync("u1");
    expect(t.fetchCapabilities).toHaveBeenCalledTimes(1);
    expect(t.setLoading).not.toHaveBeenCalled();
  });

  it("force reconsulta sem ligar loading (TOKEN_REFRESHED / refresh após PIN)", async () => {
    const t = setup();
    await t.sync("u1");
    t.setLoading.mockClear();
    await t.sync("u1", { force: true });
    expect(t.fetchCapabilities).toHaveBeenCalledTimes(2);
    expect(t.setLoading).not.toHaveBeenCalledWith(true);
  });

  it("troca de usuário liga loading e consulta de novo", async () => {
    const t = setup();
    await t.sync("u1");
    t.setLoading.mockClear();
    await t.sync("u2");
    expect(t.setLoading).toHaveBeenNthCalledWith(1, true);
    expect(t.fetchCapabilities).toHaveBeenCalledTimes(2);
  });

  it("descarta resposta atrasada de um usuário que já saiu", async () => {
    let resolveU1!: (v: string[]) => void;
    const t = setup((n) =>
      n === 1 ? new Promise<string[]>((r) => (resolveU1 = r)) : Promise.resolve(["do-u2"]),
    );
    const p1 = t.sync("u1");
    await t.sync("u2");
    resolveU1(["do-u1"]);
    await p1;
    const aplicados = t.setCapabilities.mock.calls.map((c) => c[0]);
    expect(aplicados).toEqual([["do-u2"]]);
  });

  it("logout limpa as capacidades e, ao voltar o mesmo usuário, consulta de novo", async () => {
    const t = setup();
    await t.sync("u1");
    await t.sync(null);
    expect(t.setCapabilities).toHaveBeenLastCalledWith([]);
    await t.sync("u1");
    expect(t.fetchCapabilities).toHaveBeenCalledTimes(2);
  });
});
