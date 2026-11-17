import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// A Avaliação no playground nunca vai ao responsável: nada da tela pode importar o
// disparo do Olhar, o cliente de relatórios de sessão nem o CRM.
const FILES = [
  "../screens/AvaliacoesScreen.tsx",
  "../api/usePlaygroundEval.ts",
  "../hooks/useVoiceRecorder.ts",
  "../hooks/usePlaygroundOverdueAlerts.ts",
  "../lib/playgroundEval.ts",
  "../components/playground/EvaluationPanel.tsx",
  "../components/playground/VisitCard.tsx",
  "../components/playground/PlaygroundAlertStrip.tsx",
  "../components/playground/PlaygroundBadge.tsx",
  "../components/playground/ScoreSegmented.tsx",
];

describe("Avaliações não toca o Olhar nem o CRM", () => {
  for (const f of FILES) {
    const src = readFileSync(new URL(f, import.meta.url), "utf8");
    const imports = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]!);
    it(`${f.split("/").pop()}: imports`, () => {
      for (const i of imports) expect(i).not.toMatch(/session-report|useSessionReports|sessionReport|crm/i);
    });
    it(`${f.split("/").pop()}: sem chamadas ao disparo, aos relatórios ou ao CRM`, () => {
      expect(src).not.toMatch(/sessionReportDispatch|fa_kiosk_session_reports|fa_crm_|session-report-dispatch|crm-whatsapp/);
    });
    it(`${f.split("/").pop()}: linguagem neutra`, () => {
      // Texto visível ao terapeuta não fala em clínica, prontuário ou paciente.
      const literals = [...src.matchAll(/"([^"\n]{6,})"|`([^`\n]{6,})`|>([^<>{}\n]{6,})</g)].map((m) => m[1] ?? m[2] ?? m[3] ?? "");
      for (const l of literals) expect(l).not.toMatch(/cl[ií]nica|prontu[aá]rio|paciente/i);
    });
  }
});
