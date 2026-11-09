import { describe, expect, it } from "vitest";
import { fiscalDocsPorPedido } from "./fiscalDocsPorPedido.js";

const doc = (id: string, order_id: string, status: string) => ({ id, order_id, status });

describe("fiscalDocsPorPedido", () => {
  it("indexa um documento por pedido", () => {
    const r = fiscalDocsPorPedido([doc("a", "o1", "AUTORIZADO"), doc("b", "o2", "PENDENTE")]);
    expect(Object.keys(r).sort()).toEqual(["o1", "o2"]);
    expect(r.o1?.id).toBe("a");
  });

  it("o documento ativo vence o descartado, em qualquer ordem de chegada", () => {
    const a = fiscalDocsPorPedido([doc("velho", "o1", "DESCARTADO"), doc("novo", "o1", "PENDENTE")]);
    const b = fiscalDocsPorPedido([doc("novo", "o1", "PENDENTE"), doc("velho", "o1", "DESCARTADO")]);
    expect(a.o1?.id).toBe("novo");
    expect(b.o1?.id).toBe("novo");
  });

  it("devolve o descartado quando é o único", () => {
    expect(fiscalDocsPorPedido([doc("x", "o1", "DESCARTADO")]).o1?.id).toBe("x");
  });

  it("lista vazia gera mapa vazio", () => {
    expect(fiscalDocsPorPedido([])).toEqual({});
  });
});
