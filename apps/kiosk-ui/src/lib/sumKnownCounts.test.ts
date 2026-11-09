import { describe, expect, it } from "vitest";
import { sumKnownCounts } from "./sumKnownCounts.js";

describe("sumKnownCounts", () => {
  it("soma contagens conhecidas", () => {
    expect(sumKnownCounts([2, 3, 0])).toBe(5);
  });
  it("ignora unidades com contagem desconhecida", () => {
    expect(sumKnownCounts([2, null, 4])).toBe(6);
  });
  it("devolve null quando nenhuma contagem é conhecida", () => {
    expect(sumKnownCounts([null, null])).toBeNull();
  });
  it("devolve 0 sem unidades", () => {
    expect(sumKnownCounts([])).toBe(0);
  });
});
