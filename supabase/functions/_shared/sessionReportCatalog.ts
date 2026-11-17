/**
 * Olhar FaçaAmigos (antigo Relatório de Sessão; ids internos seguem relatorio_sessao) — catálogo versionado e regras puras.
 *
 * Fonte única para a SPA. O Deno (edge functions) não enxerga `packages/`, então
 * `supabase/functions/_shared/sessionReportCatalog.ts` guarda uma cópia; o teste
 * `catalog.test.ts` falha se as duas divergirem.
 *
 * Mexeu nos itens? Suba SESSION_REPORT_CATALOG_VERSION: relatórios antigos
 * guardam a versão com que foram preenchidos.
 */

export const SESSION_REPORT_CATALOG_VERSION = 2;
/** Prazo para preencher, contado do checkout. Passou disso = "atrasado" (não bloqueia). */
export const SESSION_REPORT_DEADLINE_MS = 40 * 60_000;
/** Só sessões com pelo menos esta duração contratada geram relatório. */
export const SESSION_REPORT_MIN_MINUTES = 60;

export const SESSION_REPORT_LEVELS = ["APOIO", "DESENVOLVENDO", "AUTONOMO"] as const;
export type SessionReportLevel = (typeof SESSION_REPORT_LEVELS)[number];

export const SESSION_REPORT_LEVEL_LABEL: Record<SessionReportLevel, { short: string; long: string; emoji: string }> = {
  APOIO: { short: "Com apoio", long: "Precisou de apoio", emoji: "🤝" },
  DESENVOLVENDO: { short: "Desenvolvendo", long: "Em desenvolvimento", emoji: "🌱" },
  AUTONOMO: { short: "Autônomo", long: "Fez com autonomia", emoji: "⭐" },
};

export const EMPLOYEE_SECTORS = ["EDUCACAO_FISICA", "PSICOLOGIA", "TERAPIA_OCUPACIONAL", "PEDAGOGIA"] as const;
export type EmployeeSector = (typeof EMPLOYEE_SECTORS)[number];

export const EMPLOYEE_SECTOR_LABEL: Record<EmployeeSector, string> = {
  EDUCACAO_FISICA: "Educação Física",
  PSICOLOGIA: "Psicologia",
  TERAPIA_OCUPACIONAL: "Terapia Ocupacional",
  PEDAGOGIA: "Pedagogia",
};

/**
 * Setores que o colaborador pode ter mas que NÃO têm itens no Olhar (o Olhar é uma
 * lista única de 16 itens, igual para todos). Hoje só a Avaliação do playground usa
 * estes setores, para rotular a especialidade de quem preencheu. Ficam fora de
 * EMPLOYEE_SECTORS de propósito: o catálogo, o resumo por área e o PDF do Olhar
 * iteram sobre EMPLOYEE_SECTORS e não podem ganhar uma área sem itens.
 */
export const EXTRA_EMPLOYEE_SECTORS = ["FISIOTERAPIA"] as const;

/** Todos os setores que se pode atribuir a um colaborador (seletor de Colaboradores). */
export const EMPLOYEE_SECTOR_OPTIONS = [...EMPLOYEE_SECTORS, ...EXTRA_EMPLOYEE_SECTORS] as const;
export type EmployeeSectorOption = (typeof EMPLOYEE_SECTOR_OPTIONS)[number];

export const EMPLOYEE_SECTOR_OPTION_LABEL: Record<EmployeeSectorOption, string> = {
  ...EMPLOYEE_SECTOR_LABEL,
  FISIOTERAPIA: "Fisioterapia",
};

/** Verdadeiro quando o setor tem itens no Olhar. Setor sem itens (Fisioterapia) nunca filtra nem esconde nada no formulário. */
export function sectorHasOlharItems(sector: string | null | undefined): sector is EmployeeSector {
  return (EMPLOYEE_SECTORS as readonly string[]).includes(sector ?? "");
}

export interface SessionReportItem {
  key: string;
  label: string;
  /** O que observar — aparece em cinza sob o rótulo. */
  hint: string;
}

export interface SessionReportSector {
  sector: EmployeeSector;
  label: string;
  emoji: string;
  items: readonly SessionReportItem[];
}

export const SESSION_REPORT_CATALOG: readonly SessionReportSector[] = [
  {
    sector: "EDUCACAO_FISICA",
    label: "Educação Física",
    emoji: "🏃",
    items: [
      { key: "ef.coordenacao_ampla", label: "Correr, pular e escalar", hint: "correr, pular, escalar, arremessar" },
      { key: "ef.equilibrio", label: "Manter o equilíbrio", hint: "andar em linha, ficar num pé só, subir e descer" },
      { key: "ef.resistencia", label: "Manter a energia na brincadeira", hint: "não desistiu logo, seguiu no ritmo da atividade" },
      { key: "ef.planejamento_motor", label: "Se virar em circuitos e obstáculos", hint: "descobriu como passar em tarefa nova (circuito, obstáculo)" },
    ],
  },
  {
    sector: "PSICOLOGIA",
    label: "Psicologia",
    emoji: "💛",
    items: [
      { key: "psi.regulacao_emocional", label: "Se acalmar depois de algo difícil", hint: "voltou à calma sozinha ou com ajuda após algo difícil" },
      { key: "psi.interacao_social", label: "Brincar com outras crianças", hint: "aproximou-se, brincou e conversou com outras crianças" },
      { key: "psi.tolerancia_frustracao", label: "Esperar a vez e lidar com o \"não\"", hint: "lidou com espera, perda ou o \"não\"" },
      { key: "psi.brincar_compartilhado", label: "Dividir brinquedos e entrar no faz de conta", hint: "dividiu brinquedos, propôs ou entrou em faz de conta" },
    ],
  },
  {
    sector: "TERAPIA_OCUPACIONAL",
    label: "Terapia Ocupacional",
    emoji: "✋",
    items: [
      { key: "to.motricidade_fina", label: "Usar as mãos em coisas pequenas", hint: "pegar, encaixar, manipular objetos pequenos" },
      { key: "to.processamento_sensorial", label: "Lidar com barulho, toque e texturas", hint: "reação a barulho, toque, movimento e texturas" },
      { key: "to.autonomia_atividades", label: "Conduzir a brincadeira por conta própria", hint: "começou e levou a brincadeira sem ajuda" },
      { key: "to.transicoes", label: "Trocar de brinquedo ou espaço com tranquilidade", hint: "trocou sem grande desconforto" },
    ],
  },
  {
    sector: "PEDAGOGIA",
    label: "Pedagogia",
    emoji: "📚",
    items: [
      { key: "ped.atencao_foco", label: "Ficar na atividade até o fim", hint: "permaneceu na atividade até concluir" },
      { key: "ped.seguir_instrucoes", label: "Entender e seguir combinados", hint: "compreendeu e cumpriu os combinados e as regras" },
      { key: "ped.linguagem_comunicacao", label: "Se comunicar do seu jeito", hint: "pediu, explicou e respondeu (por fala, gesto ou figura)" },
      { key: "ped.resolucao_problemas", label: "Explorar e tentar de outro jeito", hint: "testou ideias e tentou por outro caminho" },
    ],
  },
];

/** Respostas: chave do item -> nível. Item ausente/undefined = não respondido. */
export type SessionReportAnswers = Partial<Record<string, SessionReportLevel>>;

const ALL_ITEMS: readonly SessionReportItem[] = SESSION_REPORT_CATALOG.flatMap((s) => s.items);

export function sessionReportItemCount(): number {
  return ALL_ITEMS.length;
}

export interface SessionReportProgress {
  answered: number;
  total: number;
  bySector: Record<EmployeeSector, { answered: number; total: number }>;
}

export function sessionReportProgress(answers: SessionReportAnswers): SessionReportProgress {
  const bySector = {} as SessionReportProgress["bySector"];
  let answered = 0;
  for (const s of SESSION_REPORT_CATALOG) {
    const n = s.items.filter((i) => answers[i.key] != null).length;
    bySector[s.sector] = { answered: n, total: s.items.length };
    answered += n;
  }
  return { answered, total: ALL_ITEMS.length, bySector };
}

export function sessionReportDeadlineMs(checkoutAtMs: number): number {
  return checkoutAtMs + SESSION_REPORT_DEADLINE_MS;
}

/** Atrasado = estritamente depois de 40 min (igual ao servidor: `now > checkout + 40min`). */
export function sessionReportIsLate(checkoutAtMs: number, nowMs: number): boolean {
  return nowMs > sessionReportDeadlineMs(checkoutAtMs);
}

export interface EligibleMinutesInput {
  planDurationMinutes: number | null;
  hourBankAllocatedMinutes: number | null;
  packageAllocatedMinutes: number | null;
  childCreditAllocatedMinutes: number | null;
}

/** Igual ao `greatest(...)` da RPC fa_session_reports_pending. */
export function sessionEligibleMinutes(s: EligibleMinutesInput): number {
  return Math.max(
    s.planDurationMinutes ?? 0,
    s.hourBankAllocatedMinutes ?? 0,
    s.packageAllocatedMinutes ?? 0,
    s.childCreditAllocatedMinutes ?? 0,
  );
}

export function isSessionReportEligible(minutes: number): boolean {
  return minutes >= SESSION_REPORT_MIN_MINUTES;
}

/**
 * Nomes neutros das áreas para o texto que chega à família (WhatsApp e PDF):
 * nunca o setor profissional de quem preencheu, senão o texto acaba dizendo
 * "nossa psicóloga observou" — e o registro é da brincadeira, não clínico.
 */
export const SESSION_REPORT_GROUP_NAME: Record<EmployeeSector, string> = {
  EDUCACAO_FISICA: "Movimento",
  PSICOLOGIA: "Convivência e emoções",
  TERAPIA_OCUPACIONAL: "Autonomia e mãos",
  PEDAGOGIA: "Atenção e comunicação",
};

/** Chave de cada área no JSON da IA (`ai_report.areas`). */
export const SESSION_REPORT_GROUP_KEY: Record<EmployeeSector, "movimento" | "convivencia" | "autonomia" | "atencao"> = {
  EDUCACAO_FISICA: "movimento",
  PSICOLOGIA: "convivencia",
  TERAPIA_OCUPACIONAL: "autonomia",
  PEDAGOGIA: "atencao",
};

/** Nome do documento entregue à família. Evita "sessão"/"relatório" de propósito (ver nota abaixo). */
export const SESSION_REPORT_DOC_TITLE = "Olhar FaçaAmigos";

/**
 * Nota de blindagem: texto FIXO, fora do alcance da IA, impresso em destaque na
 * 1ª página do PDF e resumido no rodapé de todas. `{crianca}` é substituído
 * pelo primeiro nome.
 */
export const SESSION_REPORT_DISCLAIMER =
  "Este documento é um registro meramente observacional da brincadeira livre de {crianca} no FaçaAmigos, feito com carinho pela nossa equipe de recreação. " +
  "Ele não é sessão terapêutica, atendimento, avaliação, diagnóstico, laudo ou parecer de qualquer natureza, e não substitui o acompanhamento de profissionais de saúde ou educação. " +
  "As observações refletem apenas o momento da visita e servem para compartilhar com a família o que vimos enquanto a criança brincava.";

export const SESSION_REPORT_DISCLAIMER_SHORT =
  "Registro observacional da brincadeira · sem caráter clínico, terapêutico ou avaliativo · FaçaAmigos";

export interface SectorSummary {
  sector: EmployeeSector;
  autonomo: string[];
  desenvolvendo: string[];
  apoio: string[];
}

/** Rótulos respondidos por nível, setor a setor (só setores com algum item) — fallback do PDF. */
export function summarizeAnswersBySector(answers: SessionReportAnswers): SectorSummary[] {
  const out: SectorSummary[] = [];
  for (const s of SESSION_REPORT_CATALOG) {
    const row: SectorSummary = { sector: s.sector, autonomo: [], desenvolvendo: [], apoio: [] };
    for (const item of s.items) {
      const level = answers[item.key];
      if (level === "AUTONOMO") row.autonomo.push(item.label);
      else if (level === "DESENVOLVENDO") row.desenvolvendo.push(item.label);
      else if (level === "APOIO") row.apoio.push(item.label);
    }
    if (row.autonomo.length + row.desenvolvendo.length + row.apoio.length > 0) out.push(row);
  }
  return out;
}

/** Agrupa os rótulos dos itens respondidos por nível — alimenta a mensagem de fallback e testes. */
export function summarizeAnswersForMessage(answers: SessionReportAnswers): Record<"autonomo" | "desenvolvendo" | "apoio", string[]> {
  const out = { autonomo: [] as string[], desenvolvendo: [] as string[], apoio: [] as string[] };
  for (const item of ALL_ITEMS) {
    const level = answers[item.key];
    if (level === "AUTONOMO") out.autonomo.push(item.label);
    else if (level === "DESENVOLVENDO") out.desenvolvendo.push(item.label);
    else if (level === "APOIO") out.apoio.push(item.label);
  }
  return out;
}
