import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startVisiblePolling, type VisibilitySource } from "./visiblePolling.js";

function fakeDoc() {
  const listeners = new Set<() => void>();
  const doc: { hidden: boolean } & Omit<VisibilitySource, "hidden"> = {
    hidden: false,
    addEventListener: (_t: "visibilitychange", l: () => void) => void listeners.add(l),
    removeEventListener: (_t: "visibilitychange", l: () => void) => void listeners.delete(l),
  };
  return { doc, listeners, emit: () => listeners.forEach((l) => l()) };
}

describe("startVisiblePolling", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("roda na hora e a cada intervalo enquanto visível", () => {
    const { doc } = fakeDoc();
    const run = vi.fn();
    startVisiblePolling(run, 15_000, doc);
    expect(run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(45_000);
    expect(run).toHaveBeenCalledTimes(4);
  });

  it("não roda com a janela escondida e recarrega uma vez ao voltar", () => {
    const { doc, emit } = fakeDoc();
    const run = vi.fn();
    startVisiblePolling(run, 15_000, doc);
    doc.hidden = true;
    emit(); // evento ao esconder: não deve rodar
    vi.advanceTimersByTime(10 * 60_000);
    expect(run).toHaveBeenCalledTimes(1);
    doc.hidden = false;
    emit();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("cancelar para o intervalo e remove o listener", () => {
    const { doc, listeners } = fakeDoc();
    const run = vi.fn();
    const stop = startVisiblePolling(run, 15_000, doc);
    stop();
    vi.advanceTimersByTime(60_000);
    expect(run).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(0);
  });
});
