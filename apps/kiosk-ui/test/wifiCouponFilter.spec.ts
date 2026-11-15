import { describe, expect, it } from "vitest";
import { isWifiClinicCoupon } from "../src/api/client.js";

describe("isWifiClinicCoupon", () => {
  it("reconhece cupons ESPERA- em qualquer caixa", () => {
    expect(isWifiClinicCoupon("ESPERA-NWD8")).toBe(true);
    expect(isWifiClinicCoupon("espera-ab12")).toBe(true);
    expect(isWifiClinicCoupon("  ESPERA-AB12 ")).toBe(true);
  });

  it("não confunde com cupons de parceria comuns", () => {
    expect(isWifiClinicCoupon("ESPERA")).toBe(false);
    expect(isWifiClinicCoupon("ESPERANCA10")).toBe(false);
    expect(isWifiClinicCoupon("N ESTRELAS")).toBe(false);
    expect(isWifiClinicCoupon("")).toBe(false);
    expect(isWifiClinicCoupon(null)).toBe(false);
    expect(isWifiClinicCoupon(undefined)).toBe(false);
  });
});
