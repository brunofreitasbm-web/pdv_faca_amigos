import { getFriendlyWristbandCode } from "@facaamigos/domain";
import type { WristbandData } from "./WristbandPrintModal.js";
import { WristbandQRCode } from "./WristbandQRCode.js";

interface WristbandLabelPreviewProps {
  data: WristbandData;
  entryTime: string;
}

/**
 * Miolo visual da etiqueta Gainscha GS-2208D (20mm × 270mm paisagem).
 * Extraído de WristbandPrintModal para ser reaproveitado também na
 * visualização rápida de Configurações → Impressoras, sem duplicar o
 * layout e arriscar as duas versões divergirem com o tempo.
 */
export function WristbandLabelPreview({ data, entryTime }: WristbandLabelPreviewProps) {
  const friendlyCode = getFriendlyWristbandCode(data.wristbandCode);

  return (
    <div className="wristband-printable" style={{ display: "flex", flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: "16px", minWidth: "680px" }}>
      <div style={{ borderRight: "2px solid #141414", paddingRight: "12px" }}>
        <strong style={{ fontFamily: "'Fredoka Variable', Fredoka, sans-serif", fontSize: "16px", color: "#F0196B", display: "block" }}>
          FaçaAmigos
        </strong>
        <span style={{ fontSize: "9px", fontWeight: "bold", textTransform: "uppercase", letterSpacing: "1px" }}>
          Playground Inclusivo
        </span>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: "10px", borderRight: "2px solid #141414", paddingRight: "12px" }}>
        <WristbandQRCode value={data.wristbandCode} size={58} />
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: "15px", fontWeight: "bold", letterSpacing: "1px", background: "#f0f0f0", padding: "2px 6px", borderRadius: "4px", border: "1px solid #ccc" }}>
            #{friendlyCode}
          </div>
        </div>
      </div>

      <div style={{ borderRight: "2px solid #141414", paddingRight: "12px" }}>
        <div style={{ fontSize: "11px", color: "#666" }}>Criança:</div>
        <div style={{ fontSize: "15px", fontWeight: "800" }}>{data.childName}</div>
        <div style={{ fontSize: "11px", fontWeight: "600", color: "#444" }}>
          Resp: {data.guardianName} ({data.phone})
        </div>
      </div>

      <div>
        <div style={{ fontSize: "11px" }}>
          <strong>Entrada:</strong> {entryTime} {data.planName ? `| ${data.planName}` : ""}
        </div>
        {data.notes && (
          <div style={{ fontSize: "10px", color: "#d9534f", fontWeight: "bold" }}>
            ⚠️ OBS: {data.notes}
          </div>
        )}
      </div>
    </div>
  );
}
