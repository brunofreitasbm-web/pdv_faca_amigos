import { useEffect, useState } from "react";
import { Api } from "../api/client.js";
import type { DeviceIdentity } from "../api/client.js";
import { shortDeviceCode } from "../lib/deviceCode.js";
import { useDeviceToken } from "../lib/supabase/deviceToken.js";

/** Linha discreta: "Balcão 1 · Unidade X · #A1B2C3" — a que unidade este aparelho está vinculado. */
export function DeviceIdentityBadge() {
  const token = useDeviceToken();
  const [identity, setIdentity] = useState<DeviceIdentity | null>(null);

  useEffect(() => {
    let alive = true;
    if (!token) {
      setIdentity(null);
      return;
    }
    void Api.deviceIdentity().then((d) => {
      if (alive) setIdentity(d);
    });
    return () => {
      alive = false;
    };
  }, [token]);

  if (!identity) return null;
  return (
    <div
      style={{ textAlign: "center", fontSize: 12, color: "var(--text-muted, #6C7682)" }}
      title="Confira com Gerencial > Aparelhos"
    >
      Aparelho <strong>{identity.label}</strong>
      {identity.unitName ? <> · {identity.unitName}</> : null} · #{shortDeviceCode(identity.id)}
    </div>
  );
}
