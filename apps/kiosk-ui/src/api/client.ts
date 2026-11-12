import { fiscalDocsPorPedido } from "../lib/fiscalDocsPorPedido.js";
import { quoteForSession, normalizeCpf, normalizePhoneE164 } from "@facaamigos/domain";
import type { EmployeeSector, SessionReportAnswers, PaperConsumptionSample } from "@facaamigos/domain";
import { supabase } from "../lib/supabase/client.js";
import { callResilient } from "../lib/supabase/offlineQueue.js";
import { computeWorkedMinutes, monthRangeMs, type PontoKind } from "../lib/ponto.js";
import { assertValidDocumentUpload, assertValidImageUpload, prepareUpload, uploadFileName } from "../lib/imageCompression.js";
import type { NpsCommentRow, NpsDashboardData } from "../lib/nps.js";
import {
  apurarBonificacaoPorDia,
  agregarPorOperador,
  type ApuracaoDia,
  type ApuracaoOperador,
  type BonusProgramConfig,
  type BonusPlanRule,
  type BonusProgramGoal,
  type BonusProgramsByUnit,
  type RawEmployee,
  type RawOrder,
  type RawOrderItem,
  type RawPlan,
  type RawGuardianPackage,
  type RawSession,
  type RawShift,
  type RawUnit,
} from "../lib/apuracaoBonificacao.js";

export interface ApiError {
  error: string;
  message?: string;
}

/**
 * Sinaliza indisponibilidade do backend local para o SystemStatusOverlay,
 * sem interferir no tratamento de erro que cada tela já faz (o throw
 * continua acontecendo normalmente — isto é só um aviso em paralelo).
 */
export const systemStatus = new EventTarget();

/**
 * Identifica este computador para o print bridge local (Electron) só
 * imprimir os jobs que ele mesmo emitiu — sem isto, 2 terminais na mesma
 * unidade imprimem cada pulseira/cupom em dobro. Vem do servidor local
 * (persistido por instalação); fora do Electron (ex.: PWA sem print
 * bridge) o fetch falha e os jobs seguem sem origin_device_id, como antes.
 */
let deviceIdPromise: Promise<string | null> | null = null;
function localDeviceId(): Promise<string | null> {
  if (!deviceIdPromise) {
    deviceIdPromise = fetch("/api/system/device-id")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => (data && typeof data.deviceId === "string" ? data.deviceId : null))
      .catch(() => null);
  }
  return deviceIdPromise;
}

/**
 * Unidade a que ESTE computador pertence — diferente da unidade
 * selecionada na sessão, que muda conforme quem está operando. É o que
 * o print bridge usa para só imprimir os jobs da própria unidade.
 *
 * Devolve `{ unitId: null, available: false }` fora do Electron
 * (tablet/PWA sem o servidor local): esses aparelhos não imprimem nada
 * sozinhos, então não faz sentido pedir a amarração ao operador ali.
 */
export interface TerminalUnitInfo {
  unitId: string | null;
  available: boolean;
}

async function getTerminalUnit(): Promise<TerminalUnitInfo> {
  try {
    const res = await fetch("/api/system/terminal-unit");
    if (!res.ok) return { unitId: null, available: false };
    const data = (await res.json()) as { unitId?: string | null };
    return { unitId: typeof data.unitId === "string" && data.unitId ? data.unitId : null, available: true };
  } catch {
    return { unitId: null, available: false };
  }
}

/**
 * Lança quando não dá para gravar. A versão anterior engolia o erro num
 * `try/catch` em volta do `fetch` — e `fetch` não lança em 500, então a
 * gravação falhava (FK do SQLite local) enquanto a tela dizia "salvo com
 * sucesso" e o terminal seguia sem unidade, imprimindo job de todas.
 */
async function setTerminalUnit(unitId: string): Promise<string> {
  const res = await fetch("/api/system/terminal-unit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ unitId }),
  });
  const data = (await res.json().catch(() => null)) as { ok?: boolean; unitId?: string; message?: string } | null;
  if (!res.ok || !data?.ok) {
    throw new Error(data?.message ?? `Não foi possível vincular este computador à unidade (HTTP ${res.status}).`);
  }
  return data.unitId ?? unitId;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: { "Content-Type": "application/json", ...init?.headers },
    });
  } catch (err) {
    systemStatus.dispatchEvent(new CustomEvent("backend-unreachable"));
    throw err;
  }
  systemStatus.dispatchEvent(new CustomEvent("backend-reachable"));
  if (!res.ok) {
    const body = (await res.json().catch(() => ({ error: "UNKNOWN" }))) as ApiError;
    throw new Error(body.message ?? body.error);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body: unknown) => request<T>(path, { method: "POST", body: JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) => request<T>(path, { method: "PATCH", body: JSON.stringify(body) }),
  put: <T>(path: string, body: unknown) => request<T>(path, { method: "PUT", body: JSON.stringify(body) }),
};

export interface Unit {
  id: string;
  kind: "LOJA" | "QUIOSQUE";
  name: string;
  business_day_cutoff_hour: number;
  address?: string | null;
  phone?: string | null;
  cnpj?: string | null;
  timezone?: string | null;
  /** Geofence opcional (ver migration fa_kiosk_units_geofence). */
  latitude?: number | null;
  longitude?: number | null;
  geofence_radius_m?: number | null;
  opening_hour_mon_sat?: string | null;
  closing_hour_mon_sat?: string | null;
  opening_hour_sun?: string | null;
  closing_hour_sun?: string | null;
}

/** Uma bobina de cupom (`fa_kiosk_paper_rolls`) — ver Gerencial > Bobinas. */
export interface PaperRoll {
  id: string;
  unitId: string;
  rollLengthMm: number;
  consumedMm: number;
  status: "ACTIVE" | "FINISHED";
  installedAtMs: number;
  finishedAtMs: number | null;
}

function mapPaperRoll(row: {
  id: string;
  unit_id: string;
  roll_length_mm: number;
  consumed_mm: number;
  status: "ACTIVE" | "FINISHED";
  installed_at_ms: number;
  finished_at_ms: number | null;
}): PaperRoll {
  return {
    id: row.id,
    unitId: row.unit_id,
    rollLengthMm: row.roll_length_mm,
    consumedMm: row.consumed_mm,
    status: row.status,
    installedAtMs: row.installed_at_ms,
    finishedAtMs: row.finished_at_ms,
  };
}

export interface Birthday {
  id: string;
  full_name: string;
  birth_date: string;
  age_turning: number;
  guardian_name: string;
  phone_e164: string;
  day_of_month: number;
  is_today: boolean;
}

export interface JobApplication {
  id: string;
  full_name: string;
  email: string;
  phone: string;
  course: string | null;
  desired_area: string;
  opportunity_type: "ESTAGIO" | "REMUNERADO" | "BOLSA" | "PJ";
  preferred_unit?: string | null;
  resume_path: string;
  status: "NOVO" | "LIDO" | "ESPERA" | "ENTREVISTA" | "EM_ANALISE" | "CONTATADO" | "ARQUIVADO";
  created_at_ms: number;
}

export interface Employee {
  id: string;
  full_name: string;
  role: "ESTAGIARIO" | "OPERADOR" | "GERENTE" | "ADMIN" | "PRESTADOR_PJ";
  cpf?: string | null;
  email?: string | null;
  phone?: string | null;
  birth_date?: string | null;
  admission_date?: string | null;
  position?: string | null;
  contract_type?: "CLT" | "ESTAGIO" | "AUTONOMO" | "PJ" | null;
  weekly_hours_contracted?: number | null;
  active?: boolean;
  /** Unidades em que o colaborador atua — só preenchido por `Api.allEmployees()` (Gerencial). */
  unitIds?: string[];
  /** Path no bucket `ponto-fotos` da última foto de cadastro do rosto. */
  face_enrolled_photo_path?: string | null;
  /** Setor de atuação (Olhar FaçaAmigos). Editável em Gerencial > Colaboradores. */
  sector?: EmployeeSector | null;
}

export type SessionReportWhatsappStatus =
  | "PENDING" | "SENT" | "SENT_MANUAL" | "SKIPPED_NO_CONSENT" | "SKIPPED_OPT_OUT" | "SKIPPED_NO_PHONE"
  | "SKIPPED_NO_CHANNEL" | "SKIPPED_NO_TEMPLATE" | "FAILED";

/** Sessão finalizada (plano >= 1h) ainda sem Olhar FaçaAmigos. Sem telefone, de propósito. */
export interface PendingSessionReport {
  session_id: string;
  child_id: string;
  child_name: string | null;
  guardian_name: string | null;
  guardian_phone_present: boolean;
  checkin_at_ms: number;
  checkout_at_ms: number;
  eligible_minutes: number;
  plan_name: string | null;
  deadline_ms: number;
}

export interface RecentSessionReport {
  id: string;
  session_id: string;
  child_name_snapshot: string;
  filled_at_ms: number;
  late: boolean;
  whatsapp_status: SessionReportWhatsappStatus;
  whatsapp_error: string | null;
  ai_message: string | null;
  filled_by_name: string;
  pdf_path: string | null;
  pdf_view_count: number;
  public_token: string | null;
  olhar_seq: number | null;
  olhar_edition: "ESTREIA" | "CONTINUIDADE" | "MARCO" | null;
}

export interface SessionReportSubmitResult {
  id: string;
  late: boolean;
  already_existed: boolean;
  whatsapp_status: SessionReportWhatsappStatus;
}

export interface SessionReportDispatchResult {
  ok: boolean;
  status?: SessionReportWhatsappStatus;
  alreadySent?: boolean;
  aiMessage?: string | null;
  sendMode?: "TEMPLATE" | "FREEFORM" | null;
  error?: string | null;
}

/** Linha completa do histórico (Gerencial). */
export interface SessionReportRow {
  id: string;
  session_id: string;
  unit_id: string;
  child_id: string;
  child_name_snapshot: string;
  filled_by_employee_id: string;
  filled_by_sector_snapshot: EmployeeSector | null;
  device_id: string | null;
  catalog_version: number;
  answers: SessionReportAnswers;
  observacao: string | null;
  session_checkout_at_ms: number;
  eligible_minutes: number;
  filled_at_ms: number;
  late: boolean;
  whatsapp_status: SessionReportWhatsappStatus;
  whatsapp_error: string | null;
  send_mode: "TEMPLATE" | "FREEFORM" | null;
  ai_message: string | null;
  ai_fallback: boolean;
  sent_at_ms: number | null;
  dispatch_attempts: number;
  /** PDF do "Olhar FaçaAmigos" (bucket privado relatorios-sessao) — ver migration fa_session_report_pdf. */
  pdf_path: string | null;
  pdf_generated_at_ms: number | null;
  public_token: string | null;
  pdf_view_count: number;
  pdf_last_viewed_at_ms: number | null;
  /** Posição na trilha de Olhares da criança (migration fa_olhar_trail). */
  olhar_seq: number | null;
  olhar_edition: "ESTREIA" | "CONTINUIDADE" | "MARCO" | null;
  ai_report: SessionReportDoc | null;
  employee?: { full_name: string } | null;
  guardian?: { full_name: string | null; phone_e164: string | null } | null;
}

/** Documento escrito pela IA (ou pelo fallback) que vira o PDF. Espelho de SessionReportDoc em _shared/sessionReportPdf.ts. */
export interface SessionReportDoc {
  titulo: string;
  abertura: string;
  areas: Partial<Record<"movimento" | "convivencia" | "autonomia" | "atencao", string>>;
  fechamento: string;
  /** Só em CONTINUIDADE/MARCO. */
  novidades?: string;
  /** Só em MARCO. */
  retrospectiva?: string;
  destaque_whatsapp: string;
}

export interface FolhaPagamentoEmployee {
  id: string;
  fullName: string;
  cpf: string | null;
  role: Employee["role"];
  position: string | null;
  weeklyHoursContracted: number | null;
  workedMinutes: number;
  workedIncomplete: boolean;
  salaryBaseCents: number | null;
  bankCode: string | null;
  bankAgencia: string | null;
  bankAgenciaDv: string | null;
  bankConta: string | null;
  bankContaDv: string | null;
  bankAccountType: string | null;
  pixKey: string | null;
}

export interface ClosedPayrollItem {
  id: string;
  employee_id: string | null;
  full_name_snapshot: string;
  cpf_snapshot: string | null;
  bank_code_snapshot: string | null;
  bank_agencia_snapshot: string | null;
  bank_agencia_dv_snapshot: string | null;
  bank_conta_snapshot: string | null;
  bank_conta_dv_snapshot: string | null;
  bank_account_type_snapshot: string | null;
  salary_base_cents: number;
  adjustment_cents: number;
  adjustment_note: string | null;
  total_cents: number;
  hours_contracted: number | null;
  hours_worked_minutes: number | null;
  hours_worked_incomplete: boolean | null;
}

export interface ClosedRun {
  id: string;
  year: number;
  month: number;
  totalCents: number;
  createdAtMs: number;
  items: ClosedPayrollItem[];
}

export interface PayrollCloseItem {
  employeeId: string;
  fullName: string;
  cpf: string | null;
  bankCode: string | null;
  bankAgencia: string | null;
  bankAgenciaDv: string | null;
  bankConta: string | null;
  bankContaDv: string | null;
  bankAccountType: string | null;
  salaryBaseCents: number;
  adjustmentCents: number;
  adjustmentNote: string | null;
  totalCents: number;
  hoursContracted: number | null;
  hoursWorkedMinutes: number | null;
}

/** Dados de RH preenchidos no convite de cadastro — ver OnboardingInviteScreen. */
export interface EmployeePersonalInfo {
  ctpsNumero?: string | null;
  ctpsSerie?: string | null;
  ctpsUf?: string | null;
  rgNumero?: string | null;
  rgOrgaoEmissor?: string | null;
  nomeMae?: string | null;
  nomePai?: string | null;
  estadoCivil?: string | null;
  escolaridade?: string | null;
  cep?: string | null;
  logradouro?: string | null;
  numero?: string | null;
  complemento?: string | null;
  bairro?: string | null;
  cidade?: string | null;
  uf?: string | null;
  emergencyContactName?: string | null;
  emergencyContactPhone?: string | null;
}

export interface PersonalInfoStatus {
  employeeId: string;
  completed: boolean;
}

export interface CreateOnboardingInviteInput {
  role: Employee["role"];
  position: string;
  unitIds: string[];
  fullNameHint?: string;
  admissionDate?: string;
}

export interface OnboardingInviteInfo {
  position: string;
  unitNames: string[];
  fullNameHint: string | null;
}

export interface OnboardingCompleteInput {
  inviteId: string;
  token: string;
  fullName: string;
  cpf?: string;
  email?: string;
  phone?: string;
  birthDate?: string;
  pin: string;
  personalInfo?: EmployeePersonalInfo;
  pixKey?: string;
  /** Conta corrente, sem dígito da agência — só o dígito da conta é pedido. */
  bankCode?: string;
  bankAgencia?: string;
  bankConta?: string;
  bankContaDv?: string;
}

export interface GeneralInviteLink {
  unitId: string;
  token: string;
}

export interface GeneralInviteInfo {
  unitName: string | null;
}

export interface GeneralOnboardingCompleteInput {
  unitId: string;
  token: string;
  fullName: string;
  cpf?: string;
  email?: string;
  phone?: string;
  birthDate?: string;
  pin: string;
  role?: Employee["role"];
  contractType?: Employee["contract_type"];
  razaoSocial?: string;
  cnpj?: string;
  pixKey?: string;
  bankCode?: string;
  bankAgencia?: string;
  bankConta?: string;
  bankContaDv?: string;
  faceDescriptor?: number[];
  facePhotoBase64?: string;
}

export interface NewEmployeeInput {
  fullName: string;
  role: Employee["role"];
  cpf?: string;
  email?: string;
  phone?: string;
  /** PIN de 6 dígitos escolhido pelo ADMIN para o novo colaborador — não existe login por e-mail/senha. */
  pin: string;
  birthDate?: string;
  admissionDate?: string;
  position?: string;
  contractType?: NonNullable<Employee["contract_type"]>;
  weeklyHoursContracted?: number;
}

export interface Plan {
  id: string;
  activity: "PLAYGROUND" | "CARRINHO";
  name: string;
  valueCents: number;
  durationValue: number;
  durationUnit: "MINUTO" | "HORA";
  overageCentsPerMinute: number;
  color: string;
  active?: boolean;
  /**
   * Tipo de ativo que o plano aluga. No Circuito é a régua do carrinho; num
   * plano PLAYGROUND marca o aluguel avulso de pelúcia (fa_kiosk_sessions.rental_kind).
   */
  assetKind?: "CARRO" | "PELUCIA" | null;
  /**
   * Plano da cortesia de aniversário (30 min grátis). Fica inativo e só entra no
   * check-in por `Api.birthdayCourtesyOffer()`; o servidor recusa o plano para
   * quem não tem a cortesia (trigger em fa_kiosk_sessions).
   */
  birthdayCourtesy?: boolean;
  /** Só preenchido por `Api.plansAllUnits()` (Gerencial). */
  unitId?: string;
}

/** Uma linha do relatório da cortesia de aniversário (fa_birthday_courtesy_report). */
export interface BirthdayCourtesyRow {
  courtesy_id: string;
  child_id: string;
  /** Nome só vem com a permissão crm.read. */
  child_name: string | null;
  guardian_name: string | null;
  birthday_date: string;
  cohort: "TRATAMENTO" | "CONTROLE";
  sent_at_ms: number | null;
  valid_until_date: string;
  used: boolean;
  used_at_ms: number | null;
  used_unit_id: string | null;
  used_unit_name: string | null;
  overage_minutes: number;
  overage_cents: number;
  /** null no grupo de controle e em quem não usou. */
  bought_after: boolean | null;
  visits_in_window: number;
  paid_cents_in_window: number;
}

export interface Asset {
  id: string;
  unit_id: string;
  name: string;
  emoji: string;
  color: string;
  status: "DISPONIVEL" | "EM_USO" | "MANUTENCAO";
  odometer_minutes: number;
  photo_url: string | null;
  kind?: "CARRO" | "PELUCIA" | null;
}

export interface Product {
  id: string;
  name: string;
  description: string | null;
  emoji: string | null;
  price_cents: number;
  /** Custo de aquisição, em centavos. Null = não cadastrado (não obrigatório). */
  cost_cents: number | null;
  stock: number;
  active?: boolean;
  /** Só preenchido por `Api.productsAllUnits()` (Gerencial). */
  unit_id?: string;
}

/**
 * Dados fiscais do emitente: NFC-e (modelo 65, mercadoria, autorizada pela
 * SEFAZ-PA) e NFS-e (serviço, ISS, Prefeitura de Belém / Sistema Nacional).
 *
 * Nenhum segredo trafega aqui: `nfce_csc_id` é só o identificador do CSC
 * (ex. '000001'), que não é secreto. O TOKEN do CSC e a senha do certificado
 * A1 ficam cifrados na nuvem (gravados pelas Edge Functions fiscal-csc-upload
 * e nfse-certificate-upload) e só o worker fiscal do PC do balcão consegue
 * lê-los, via Edge Function. O cofre local do PC é apenas um fallback
 * opcional — o Gerencial nunca lê nem exibe esses valores; só o status
 * (ver fiscalCscStatus / fiscalCertificateStatus).
 */
export interface UnitFiscal {
  id: string;
  name: string;
  cnpj: string | null;
  razao_social: string | null;
  nome_fantasia: string | null;
  inscricao_estadual: string | null;
  inscricao_municipal: string | null;
  cnae_principal: string | null;
  crt: number | null;
  end_logradouro: string | null;
  end_numero: string | null;
  end_complemento: string | null;
  end_bairro: string | null;
  end_municipio_ibge: string | null;
  /** Nome do município (xMun da NFC-e), ex. "BELEM". */
  end_municipio_nome: string | null;
  end_uf: string | null;
  end_cep: string | null;
  fone: string | null;
  fiscal_ambiente: string | null;
  fiscal_enabled: boolean | null;
  nfce_serie: number | null;
  nfce_csc_id: string | null;
  nfce_qrcode_url_consulta: string | null;
  nfse_item_lista_servico: string | null;
  nfse_codigo_tributacao_municipio: string | null;
  nfse_aliquota_iss_bp: number | null;
  nfse_iss_retido: boolean | null;
  nfse_regime_especial: number | null;
  nfse_serie_rps: string | null;
  nfse_ambiente: string | null;
  nfse_enabled: boolean | null;
}

/** Tributação por item — sem NCM/CFOP/CSOSN a NFC-e é rejeitada. */
export interface ProductFiscal {
  id: string;
  name: string;
  ncm: string | null;
  cest: string | null;
  cfop: string | null;
  csosn: string | null;
  origem: number | null;
  unidade_comercial: string | null;
  gtin: string | null;
  pis_cst: string | null;
  cofins_cst: string | null;
}

export interface FiscalTerminalStatus {
  unit_id: string;
  terminal_id: string;
  worker_version: string | null;
  cert_subject_cn: string | null;
  cert_not_after_ms: number | null;
  csc_configured: boolean;
  environment: string | null;
  last_heartbeat_ms: number;
  last_error: string | null;
}

export interface FiscalDoc {
  id: string;
  unit_id: string;
  order_id: string;
  doc_type: string;
  environment: "HOMOLOGACAO" | "PRODUCAO";
  serie: string | null;
  numero: number | null;
  access_key: string | null;
  protocol_number: string | null;
  status:
    | "PENDENTE"
    | "BLOQUEADO"
    | "DESCARTADO"
    | "ASSINADO"
    | "TRANSMITIDO"
    | "AUTORIZADO"
    | "REJEITADO"
    | "DENEGADO"
    | "A_INUTILIZAR"
    | "CONTINGENCIA_OFFLINE"
    | "CANCELADO";
  emission_type: "NORMAL" | "CONTINGENCIA_OFFLINE";
  total_cents: number;
  last_error: string | null;
  reject_code: string | null;
  reject_message: string | null;
  created_at_ms: number;
  authorized_at_ms: number | null;
  /**
   * NFC-e: URL do QR Code calculada pelo worker (com hash do CSC) e gravada
   * só depois da autorização. O kiosk-ui nunca monta essa URL — sem o token
   * do CSC ela seria inválida; só exibe o que veio do banco.
   */
  qrcode_url: string | null;
  /** NFS-e: número municipal (RPS -> NFS-e) e carimbo do envio por WhatsApp ao Responsável. */
  nfse_numero?: string | null;
  guardian_whatsapp_sent_at_ms?: number | null;
}

export interface ChildMatch {
  id: string;
  full_name: string;
  birth_date: string;
  phone_e164: string | null;
  guardian_name: string | null;
  cpf: string | null;
  /** Check-ins na janela móvel do motor VIP (30 dias por padrão). */
  visits_in_window: number;
  /** Selo VIP: atingiu o número de visitas na janela. Decidido no banco. */
  is_vip: boolean;
  inclusive_eligible?: boolean;
}

/**
 * Pacote de recorrência vendável como upgrade (`fa_kiosk_packages`).
 *
 * Não confundir com `Plan`: plano é a permanência avulsa desta visita
 * (15 min, 1 hora); pacote é o produto mensal, com saldo de horas e
 * validade, que o motor de cross-selling oferece.
 */
export interface Package {
  id: string;
  activity: "PLAYGROUND" | "CARRINHO";
  name: string;
  priceCents: number;
  includedMinutes: number;
  validityDays: number;
  benefitText: string;
  color: string;
  active: boolean;
  /** Tarifa por minuto além do incluído, cobrada quando o pacote é usado direto na Entrada. */
  overageCentsPerMinute: number;
  /** Só preenchido por `Api.packagesAllUnits()` (Gerencial). */
  unitId?: string;
}

/**
 * Resposta de `fa_upsell_offer`. Como em `ResolvedAccessCode`, cada
 * `reason` é uma situação real de balcão e não um erro — "esta criança
 * não tem oferta hoje" é o caso comum:
 *
 *   OK                   há oferta; o card de conversão deve aparecer
 *   SEM_VIP              ainda não bateu as 4 visitas na janela
 *   COOLDOWN             o responsável recusou há menos de 15 dias
 *   JA_TEM_PACOTE        já comprou e ainda tem saldo — não se oferece de novo
 *   SEM_GASTO_NO_MES     sem avulsos pagos no mês: não há âncora de preço
 *   SEM_HORAS_APURADAS   sem tempo fechado no mês: o custo/hora seria inventado
 *   SEM_PACOTE_SUPERIOR  nenhum pacote acima do gasto que baixe o custo/hora
 *   SEM_RESPONSAVEL      criança sem vínculo — nada a ofertar a ninguém
 */
export type UpsellReason =
  | "OK"
  | "SEM_VIP"
  | "COOLDOWN"
  | "JA_TEM_PACOTE"
  | "SEM_GASTO_NO_MES"
  | "SEM_HORAS_APURADAS"
  | "SEM_PACOTE_SUPERIOR"
  | "SEM_RESPONSAVEL"
  | "UNIDADE_INVALIDA"
  | "CRIANCA_INVALIDA";

export interface UpsellOffer {
  eligible: boolean;
  reason: UpsellReason;
  isVip?: boolean;
  visitsInWindow?: number;
  visitsWindowDays?: number;
  visitsRequired?: number;
  cooldownUntilMs?: number;
  offerId?: string;
  guardianId?: string;
  guardianName?: string;
  childId?: string;
  childName?: string;
  spendCents?: number;
  consumedMinutes?: number;
  package?: {
    id: string;
    name: string;
    priceCents: number;
    includedMinutes: number;
    validityDays: number;
    benefitText: string;
    color: string;
  };
  deltaCents?: number;
  hourlyAvulsoCents?: number;
  hourlyPlanCents?: number;
  /** Script já parametrizado, montado no banco. A UI só o exibe. */
  scriptText?: string;
}

/**
 * Chaves de `fa_kiosk_app_settings` que a UI lê/escreve. É uma união
 * fechada, e não `string`, para que uma chave digitada errado falhe no
 * build em vez de gravar em silêncio uma configuração que ninguém lê.
 */
export type UnitSettingKey =
  | "daily_goal_cents"
  | "terms_of_use"
  | "closing_time"
  | "printer_wristband"
  | "printer_receipt"
  // Calibragem do motor de cross-selling (ver migration 20260807000008).
  | "upsell_vip_visits"
  | "upsell_vip_window_days"
  | "upsell_cooldown_days"
  // Cross-sell rápido (produto único, ex.: "Água") oferecido ao selecionar
  // um plano de permanência a partir de N minutos. Ver migration
  // fa_kiosk_session_extra_items_upsell.
  | "upsell_quick_product_id"
  | "upsell_quick_trigger_minutes"
  // Modelo do contrato de prestação de serviços dos planos acima de 2h
  // (banco de horas). Editável no Gerencial > Contrato; impresso em A4.
  | "hour_bank_contract_template"
  // Validade do banco de horas em dias (padrão 45 — mesmo default do banco).
  | "hour_bank_validity_days"
  // Catálogo de ciclo de vida (upsell/cross-sell/LTV/retenção): um kind por
  // ação, '1' liga em todas as unidades. Ver crm-lifecycle-dispatch e
  // migration fa_crm_lifecycle_campaigns. Cada um só dispara de verdade
  // quando o template correspondente estiver aprovado e ativo.
  | "crm_lc_expiracao"
  | "crm_lc_relatorio_cupom"
  | "crm_lc_premio_fidelidade"
  | "crm_lc_nps_promotor"
  | "crm_lc_nps_detrator"
  | "crm_lc_upsell_pacote"
  | "crm_lc_cross_atividade"
  | "crm_lc_cross_irmao"
  | "crm_lc_aniversario"
  | "crm_lc_vip"
  | "crm_lc_winback_1"
  | "crm_lc_winback_2"
  | "crm_lc_degrau_2h"
  | "crm_lc_degrau_porto"
  | "crm_lc_degrau_dayuse"
  // Automações fora do catálogo de ciclo de vida (cada uma com seu dispatcher
  // crm-*-dispatch). '1' liga, ausente/'0' desliga.
  | "crm_nps_auto"
  | "crm_renewal_alert"
  | "crm_mapeamento_followup"
  | "crm_notify_welcome"
  | "crm_notify_overage"
  | "crm_notify_renewal_ok"
  | "crm_notify_loyalty";

export interface VipFlag {
  child_id: string;
  visits_in_window: number;
  is_vip: boolean;
  /** Contador absoluto de visitas (mesmo do programa de fidelidade). */
  total_visits?: number;
}

/** Saldo do banco de horas de uma criança (`fa_kiosk_hour_bank_balance`). */
export interface ForeignPackageBalance {
  guardian_package_id: string;
  guardian_id: string;
  guardian_name: string;
  package_name: string;
  remaining_minutes: number;
  expires_at_ms: number;
}

export interface HourBankBalance {
  child_id: string;
  remaining_minutes: number;
  /** Vencimento mais próximo entre os créditos válidos — o que a Entrada mostra. */
  next_expiry_ms: number;
}

/** Saldo pré-pago agregado de uma criança (`fa_kiosk_child_credit_balance`). Não vence. */
export interface ChildCreditBalance {
  child_id: string;
  remaining_minutes: number;
  credits_count: number;
  /** Id do crédito mais antigo (FIFO) — o que o fa_checkin referencia para fixar tarifa/piso da sessão. */
  credit_id: string;
}

/** Um pacote com saldo dos responsáveis da criança (`fa_kiosk_child_package_list`). Vence; ver `expires_at_ms`. */
export interface ChildPackageBalance {
  package_id: string;
  package_name: string;
  remaining_minutes: number;
  included_minutes: number;
  expires_at_ms: number;
  /** false = pacote vendido para outra criança do mesmo responsável (irmão); só entra com confirmação do balcão. */
  is_own?: boolean;
  /** Nome da criança dona do pacote (só quando is_own = false). */
  owner_child_name?: string | null;
}

/** Uma criança com saldo pré-pago aguardando início — fila do Painel (`fa_kiosk_child_credit_queue`). */
export interface PrepaidCreditQueueItem {
  credit_id: string;
  child_id: string;
  child_name: string;
  /** Traz nascimento/CPF/elegibilidade só para o Painel reconstruir um ChildMatch e reusar pickMatch() na Entrada. */
  child_birth_date: string;
  child_inclusive_eligible: boolean;
  guardian_id: string;
  guardian_name: string;
  guardian_phone: string | null;
  guardian_cpf: string | null;
  remaining_minutes: number;
  source_name_snapshot: string;
  activity: "PLAYGROUND" | "CARRINHO";
  purchased_at_ms: number;
  /** true quando a criança já entrou por outro caminho — o Painel desabilita o ▶ Iniciar. */
  has_active_session: boolean;
}

export interface GerencialCliente {
  guardian_id: string;
  guardian_name: string;
  cpf: string | null;
  phone_e164: string | null;
  email: string | null;
  created_at: string;
  total_visits: number;
  children: Array<{
    id: string;
    fullName: string;
    birthDate: string | null;
    photoPath: string | null;
  }>;
}

/** Uma linha do audit log (`fa_kiosk_audit_log`), já com o nome/papel do operador resolvidos. */
export interface AuditLogEntry {
  id: string;
  at_ms: number;
  action: string;
  severity: "INFO" | "ALERTA";
  details_json: Record<string, unknown> | null;
  employee_id: string | null;
  employee_name: string | null;
  employee_role: string | null;
}

/** Dados cadastrais do Contratante para o contrato dos planos >2h. */
export interface GuardianContractInfo {
  id: string;
  fullName: string;
  cpf: string | null;
  rg: string | null;
  email: string | null;
  phone: string | null;
  addressLine: string | null;
  addressCity: string | null;
  addressState: string | null;
  addressZip: string | null;
}

/**
 * Resposta de `fa_resolve_access_code`. Cada `reason` é uma situação real de
 * balcão, não um erro genérico:
 *
 *   OK             sessão ativa encontrada, pode seguir para o pagamento
 *   PAUSADA        criança está com o tempo pausado — retomar antes de fechar
 *   CODIGO_INVALIDO leu outra coisa, ou o dígito verificador não bate
 *   NAO_ENCONTRADO código válido, mas nenhuma sessão com ele
 *   OUTRA_UNIDADE  pulseira de outra operação/módulo
 *   JA_FINALIZADA  essa criança já saiu (leitura duplicada da mesma pulseira)
 */
export interface ResolvedAccessCode {
  reason: "OK" | "PAUSADA" | "CODIGO_INVALIDO" | "NAO_ENCONTRADO" | "OUTRA_UNIDADE" | "JA_FINALIZADA";
  code?: string;
  sessionId?: string;
  childName?: string;
  guardianName?: string;
  guardianPhone?: string;
  checkinAtMs?: number;
  checkoutAtMs?: number;
  notes?: string | null;
  sensoryTags?: string[];
}

export interface AuthorizedGuardian {
  guardianId: string;
  fullName: string;
  cpf: string | null;
  phone: string | null;
  isPrimary: boolean;
}

export type SessionPhase = "VERDE" | "AMARELO" | "VERMELHO" | "EXCEDENTE";

export interface QuoteLine {
  label: string;
  cents: number;
}

export interface ActiveSessionEntry {
  plan: { id: string; name: string; color: string };
  asset: { id: string; name: string; emoji: string; photo_url: string | null } | null;
  session: {
    id: string;
    child_id: string;
    child_name_snapshot: string;
    activity: "PLAYGROUND" | "CARRINHO";
    checkin_at_ms: number;
    checkin_by_employee_id?: string | null;
    asset_id: string | null;
    wristband_code?: string;
    /** Código curto impresso na pulseira e no recibo de guarda (11 caracteres). */
    access_code?: string | null;
    /** PIN de 4 dígitos do recibo de guarda — o único segredo que fica só com o responsável, conferido na Saída. */
    exit_pin?: string | null;
    guardian_id?: string;
    guardian_name_snapshot?: string;
    guardian_phone_snapshot?: string;
    child_birth_date?: string;
    child_inclusive_eligible?: boolean;
    notes?: string;
    sensory_tags?: string[];
    paused_at_ms: number | null;
    paused_ms_total: number;
    /** Cortesia de fidelidade (10ª visita): minutos que o relógio da sessão "anda a menos". */
    loyalty_courtesy_minutes?: number;
    /** Minutos de pacote pré-pago ainda válidos do responsável, se houver. */
    package_balance_minutes?: number;
    /** Entrada feita pelo banco de horas da criança (sem plano vendido). */
    uses_hour_bank?: boolean;
    /** Saldo alocado no check-in — a "duração do plano" da sessão de banco. */
    hour_bank_allocated_minutes?: number;
    /** Entrada feita por um Pacote (compra + uso no mesmo ato, sem plano vendido). */
    uses_package?: boolean;
    package_id?: string | null;
    /** Minutos alocados no check-in — a "duração do plano" da sessão de pacote. */
    package_allocated_minutes?: number;
    /** Entrada consumindo saldo pré-pago (comprado numa visita anterior, sem plano vendido agora). */
    uses_child_credit?: boolean;
    /** Entrada pelo saldo de pacote (Porto Seguro) do responsável: sem plano; só o excedente cobra, pela tarifa do pacote. */
    uses_guardian_package?: boolean;
    child_credit_id?: string | null;
    /** Minutos alocados no check-in — a "duração do plano" da sessão de saldo pré-pago. */
    child_credit_allocated_minutes?: number;
    /** 'PELUCIA' = aluguel avulso de pelúcia no Playground (não é entrada na brincadeira). */
    rental_kind?: "PELUCIA" | null;
  };
  quote: {
    lines: QuoteLine[];
    totalCents: number;
    timing: { phase: SessionPhase; elapsedMs: number; durationMs: number; overMinutes: number; isPaused: boolean; pausedForMs: number };
  };
  /** Cotação do fechamento (já com a tolerância interna de saída imediata). Só o CheckoutModal usa. */
  checkoutQuote?: ActiveSessionEntry["quote"];
}

export interface Shift {
  id: string;
  unit_id: string;
  status: "ABERTO" | "FECHADO";
  /** Fundo_Caixa_Abertura — contado pelo operador ao abrir. */
  opening_cash_cents: number;
  opened_at_ms: number;
  /** Fundo_Caixa_Proximo_Dia declarado no último fechamento (null se não havia). */
  expected_opening_cash_cents: number | null;
  /** opening_cash_cents − expected_opening_cash_cents (null se não havia fechamento anterior). */
  opening_divergence_cents: number | null;
  /** Quem abriu — é quem fica obrigado a ler a passagem de turno do dia anterior. */
  opened_by_employee_id: string | null;
}

/**
 * Campos de conciliação de caixa gravados em fa_kiosk_shifts (ver migration
 * 20260902000001). Todos nulos em turnos abertos/fechados antes da regra.
 */
export interface ShiftCashReconciliation {
  /** Fundo_Caixa_Proximo_Dia do fechamento anterior. */
  expected_opening_cash_cents: number | null;
  /** Fundo_Caixa_Abertura − previsto. */
  opening_divergence_cents: number | null;
  /** Dinheiro_Total_Gaveta contado no fechamento. */
  counted_cash_cents: number | null;
  /** Dinheiro_Total_Gaveta calculado pelo servidor. */
  drawer_expected_cents: number | null;
  /** contado − calculado (negativo = quebra, positivo = sobra). */
  cash_break_cents: number | null;
  /** Fundo_Caixa_Proximo_Dia informado no fechamento. */
  next_day_float_cents: number | null;
  /** Valor que fica no envelope = contado − fundo do próximo dia. */
  envelope_cents: number | null;
}

export interface OpenShiftResult {
  id: string;
  openingCashCents: number;
  expectedOpeningCashCents: number | null;
  openingDivergenceCents: number | null;
}

export interface CloseShiftResult {
  expected: Record<string, number>;
  declared: Record<string, number>;
  divergence: Record<string, number>;
  justifications: Record<string, string>;
  countedCashCents: number | null;
  drawerExpectedCents: number | null;
  cashBreakCents: number | null;
  nextDayFloatCents: number | null;
  envelopeCents: number | null;
  /** Passagem de turno gravada junto com o fechamento (mesma transação). */
  handover: { id: string | null; noChanges: boolean; conteudo: string | null } | null;
}

/** Uma passagem de turno que o operador ainda precisa ler e dar ciência. */
export interface PendingHandover {
  id: string;
  business_date: string;
  created_at_ms: number;
  no_changes: boolean;
  conteudo: string | null;
  closed_by_name: string | null;
}

/** Linha do histórico de passagens (aba Gerencial), com as ciências. */
export interface HandoverHistoryRow {
  id: string;
  unit_id: string;
  business_date: string;
  created_at_ms: number;
  no_changes: boolean;
  conteudo: string | null;
  closed_by_employee_id: string | null;
  fa_kiosk_shift_handover_acks: Array<{
    employee_id: string;
    acked_at_ms: number;
    leitura_ms: number | null;
  }>;
}

export interface CashMovement {
  id: string;
  kind: "TROCO_INICIAL" | "SANGRIA" | "SUPRIMENTO" | "AJUSTE";
  amount_cents: number;
  reason: string | null;
  envelope_number: string | null;
  photo_url: string | null;
  fundo_caixa_cents: number | null;
  employee_id: string;
  at_ms: number;
}

export interface UnitShiftRow extends ShiftCashReconciliation {
  id: string;
  unit_id: string;
  status: "ABERTO" | "FECHADO";
  opening_cash_cents: number;
  opened_at_ms: number;
  closed_at_ms: number | null;
  opened_by_employee_id: string;
  closed_by_employee_id: string | null;
  close_justifications_json: Record<string, string> | null;
}

export interface EnvelopeMovement {
  id: string;
  shift_id: string;
  amount_cents: number;
  reason: string | null;
  envelope_number: string | null;
  photo_url: string | null;
  fundo_caixa_cents: number | null;
  employee_id: string;
  at_ms: number;
  fa_kiosk_shifts: { unit_id: string }[];
}

export interface UnitEnvelopeBalance {
  unit_id: string;
  unit_name: string;
  pending_cents: number;
  pending_count: number;
  oldest_pending_at_ms: number | null;
  last_collected_at_ms: number | null;
}

/** Um envelope ainda na loja (pendente de recolhimento) — ver RPC fa_pending_envelopes. */
export interface PendingEnvelope {
  movement_id: string;
  unit_id: string;
  envelope_number: string;
  amount_cents: number;
  at_ms: number;
  reason: string | null;
  employee_id: string;
}

export interface UnitCashStatus {
  unit_id: string;
  unit_name: string;
  shift_id: string | null;
  status: "ABERTO" | "FECHADO" | null;
  opened_at_ms: number | null;
  closed_at_ms: number | null;
  opening_cash_cents: number | null;
  current_cash_cents: number | null;
}

export interface ShiftSale {
  orderId: string;
  orderCode: string | null;
  kind: "SESSAO" | "PDV";
  createdAtMs: number;
  method: string;
  amountCents: number;
  discountCents: number;
  childNames: string;
  guardianId?: string | null;
  guardianName: string | null;
  guardianPhone?: string | null;
  guardianCpf?: string | null;
  productsSummary: string | null;
}

export interface BonusRule {
  id: string;
  unitId: string;
  description: string;
  rewardValueCents: number;
  active?: boolean;
}

export interface Coupon {
  id: string;
  code: string;
  kind: "MINUTOS_EXTRA" | "DESCONTO_PCT" | "DESCONTO_VALOR";
  value: number;
  max_uses: number;
  used_count: number;
  active: boolean | number;
  description: string | null;
  /** Plano ao qual o cupom fica restrito; null = vale para qualquer plano da unidade. */
  allowedPlanId: string | null;
  /** Dias ISO (1=seg…7=dom) em que vale; null = todos os dias. */
  scheduleDays: number[] | null;
  /** Horário "HH:MM"; ambos null = qualquer horário. */
  scheduleStart: string | null;
  scheduleEnd: string | null;
  /** Fim da validade (ms epoch); null = sem prazo. Hoje só os ESPERA-XXXX do portal Wi-Fi têm. */
  expiresAtMs?: number | null;
  /** Só preenchido por `Api.couponsAllUnits()` (Gerencial). */
  unitId?: string;
}

export interface CouponScheduleInput {
  scheduleDays?: number[] | null;
  scheduleStart?: string | null;
  scheduleEnd?: string | null;
}

/** True se o cupom vale agora (dia da semana + horário, hora local do quiosque). */
export function isCouponInSchedule(c: Coupon, now: Date = new Date()): boolean {
  if (c.scheduleDays && c.scheduleDays.length > 0) {
    const isoDow = now.getDay() === 0 ? 7 : now.getDay();
    if (!c.scheduleDays.includes(isoDow)) return false;
  }
  if (c.scheduleStart && c.scheduleEnd) {
    const cur = now.getHours() * 60 + now.getMinutes();
    const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
    const a = toMin(c.scheduleStart);
    const b = toMin(c.scheduleEnd);
    return a <= b ? cur >= a && cur < b : cur >= a || cur < b;
  }
  return true;
}

export interface LoyaltyRule {
  id: string;
  activity: "PLAYGROUND" | "CARRINHO" | "AMBOS";
  triggerVisits: number;
  rewardKind: "ENTRADA_GRATIS" | "DESCONTO_PCT" | "MINUTOS_EXTRA";
  rewardValue: number;
  /** Só preenchido por `Api.loyaltyRulesAllUnits()` (Gerencial). */
  unitId?: string;
}

export interface RedeemableReward {
  id: string;
  rule_id: string;
  earned_at_ms: number;
}

export interface SessionEvent {
  id: string;
  kind: string;
  at_ms: number;
  employee_name: string | null;
  payload: Record<string, unknown> | null;
}

export interface DailySales {
  business_date: string;
  orders_count: number;
  total_cents: number;
}
export interface RevenueByMethod {
  method: string;
  total_cents: number;
}
export interface DailyVisits {
  business_date: string;
  sessions_count: number;
}
export interface CheckinsByHour {
  unit_id: string;
  unit_name: string;
  hour: number;
  count: number;
}
export interface TicketGoal {
  unitId: string;
  minTicketCents: number;
  targetTicketCents: number;
}
export interface BirthdayChild {
  id: string;
  full_name: string;
  birth_date: string;
  guardian_name?: string | null;
  guardian_phone?: string | null;
}
export interface AssetUsage {
  id: string;
  name: string;
  emoji: string;
  color: string;
  sessions_count: number;
  total_minutes: number;
}
export interface ShiftSummary {
  id: string;
  opened_at_ms: number;
  closed_at_ms: number | null;
  status: "ABERTO" | "FECHADO";
  declared_json: string | null;
  expected_json: string | null;
}
export interface PlanSold {
  plan_id: string;
  plan_name: string;
  plan_color: string;
  activity: "PLAYGROUND" | "CARRINHO";
  sessions_count: number;
}
/**
 * Um registro por entrada. `id` é o identificador estável da sessão (nunca
 * muda, nunca se repete, mesmo para a mesma criança/responsável em dias e
 * horários diferentes) — é a referência para rastreio posterior por
 * questões jurídicas. `access_code` é o código curto impresso na pulseira
 * e no recibo: operacional, não é a chave de auditoria.
 */
export interface SessionAudit {
  id: string;
  unit_id: string;
  access_code: string | null;
  checkin_at_ms: number;
  checkout_at_ms: number | null;
  status: string;
  activity: "PLAYGROUND" | "CARRINHO";
  child_name: string;
  guardian_name: string;
  guardian_phone: string | null;
  guardian_cpf: string | null;
  plan_name: string | null;
  employee_name: string | null;
  legacy_source?: string | null;
  operator_name_snapshot?: string | null;
}

/**
 * Data do dia operacional (AAAA-MM-DD) de uma unidade. O dia só vira
 * depois do `business_day_cutoff_hour`, então um check-in de 1h da manhã
 * ainda conta para o movimento do dia anterior. Espelha a função SQL
 * `fa_kiosk_business_date`, que é quem grava `business_date` nas tabelas.
 */
export function businessDateFor(nowMs: number, cutoffHour: number): string {
  // UTC, não hora local: espelha `to_timestamp(...)::date` no Postgres, que
  // resolve na timezone da sessão (UTC no Supabase). Usar getters locais aqui
  // desalinha o "dia operacional" do cliente do que foi gravado no servidor
  // sempre que a máquina do kiosk não estiver rodando em UTC.
  const shifted = new Date(nowMs - cutoffHour * 3600_000);
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(shifted.getUTCDate()).padStart(2, "0")}`;
}

function planFromRow(row: Record<string, unknown>): Plan {
  return {
    id: row.id as string,
    activity: row.activity as Plan["activity"],
    name: row.name as string,
    valueCents: row.value_cents as number,
    durationValue: row.duration_value as number,
    durationUnit: row.duration_unit as Plan["durationUnit"],
    overageCentsPerMinute: row.overage_cents_per_minute as number,
    color: row.color as string,
    active: Boolean(row.active),
    assetKind: (row.asset_kind as Plan["assetKind"]) ?? null,
    birthdayCourtesy: Boolean(row.birthday_courtesy),
    unitId: row.unit_id as string | undefined,
  };
}

function packageFromRow(row: Record<string, unknown>): Package {
  return {
    id: row.id as string,
    activity: row.activity as Package["activity"],
    name: row.name as string,
    priceCents: row.price_cents as number,
    includedMinutes: row.included_minutes as number,
    validityDays: row.validity_days as number,
    benefitText: row.benefit_text as string,
    color: row.color as string,
    active: Boolean(row.active),
    overageCentsPerMinute: (row.overage_cents_per_minute as number | null) ?? 0,
    unitId: row.unit_id as string | undefined,
  };
}

function bonusRuleFromRow(row: Record<string, unknown>): BonusRule {
  return {
    id: row.id as string,
    unitId: row.unit_id as string,
    description: row.description as string,
    rewardValueCents: row.reward_value_cents as number,
    active: Boolean(row.active),
  };
}

function couponFromRow(row: Record<string, unknown>): Coupon {
  return {
    id: row.id as string,
    code: row.code as string,
    kind: row.kind as Coupon["kind"],
    value: row.value as number,
    max_uses: row.max_uses as number,
    used_count: row.used_count as number,
    active: row.active ? 1 : 0,
    description: (row.description as string | null) ?? null,
    allowedPlanId: (row.allowed_plan_id as string | null) ?? null,
    scheduleDays: (row.schedule_days as number[] | null) ?? null,
    scheduleStart: row.schedule_start ? String(row.schedule_start).slice(0, 5) : null,
    scheduleEnd: row.schedule_end ? String(row.schedule_end).slice(0, 5) : null,
    unitId: row.unit_id as string | undefined,
    expiresAtMs: (row.expires_at_ms as number | null | undefined) ?? null,
  };
}

/** Resposta de `fa_kiosk_wifi_coupon_lookup`: confere um cupom ESPERA-XXXX do portal Wi-Fi. */
export type WifiCouponStatus = "OK" | "USADO" | "USADO_OUTRA_UNIDADE" | "VENCIDO" | "DESATIVADO" | "NAO_ENCONTRADO";
export interface WifiCouponLookup {
  found: boolean;
  status: WifiCouponStatus;
  /** Primeiro nome + inicial do sobrenome, para conferir com quem está no balcão. */
  guardianName: string | null;
  coupon: Coupon | null;
}

function loyaltyRuleFromRow(row: Record<string, unknown>): LoyaltyRule {
  return {
    id: row.id as string,
    activity: row.activity as LoyaltyRule["activity"],
    triggerVisits: row.trigger_visits as number,
    rewardKind: row.reward_kind as LoyaltyRule["rewardKind"],
    rewardValue: row.reward_value as number,
    unitId: row.unit_id as string | undefined,
  };
}

async function unwrap<T>(promise: PromiseLike<{ data: T | null; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await promise;
  if (error) {
    let detail = error.message;
    const errCtx = (error as { context?: unknown }).context;
    if (errCtx instanceof Response) {
      try {
        const text = await errCtx.clone().text();
        try {
          const parsed = JSON.parse(text);
          if (parsed?.error) detail = parsed.error;
          else if (parsed?.message) detail = parsed.message;
          else if (text) detail = `HTTP ${errCtx.status}: ${text}`;
        } catch {
          if (text) detail = `HTTP ${errCtx.status}: ${text}`;
        }
      } catch {
        // mantém a mensagem original
      }
    }
    throw new Error(detail);
  }
  return data as T;
}

export interface ActiveSessionsRaw {
  sessions: Record<string, unknown>[];
  planById: Map<string, Plan>;
  guardianById: Map<string, Record<string, unknown>>;
  assetById: Map<string, Record<string, unknown>>;
  childById: Map<string, Record<string, unknown>>;
  /** Saldo de pacote ainda válido, por responsável (minutos). */
  packageBalanceByGuardian: Map<string, number>;
  /** A consulta do saldo de pacote falhou: o saldo acima é desconhecido, não zero. */
  packageBalanceFailed?: boolean;
  /**
   * serverNowMs (no momento da busca) - Date.now() (no instante em que a
   * resposta chegou). Somado a todo Date.now() local do cronômetro do
   * painel para não depender do relógio do tablet do kiosk estar certo —
   * mesma correção de useAcompanhar.ts (ver 20260810000011). Sem isso, um
   * relógio de tablet atrasado em relação ao servidor faz elapsedMs
   * (Date.now() - checkinAtMs) ficar negativo — travado em zero pelo
   * Math.max(0, ...) — até o relógio do aparelho "alcançar" o checkin.
   */
  clockOffsetMs: number;
}

/**
 * Busca os dados crus (sem cálculo de tempo/valor, que muda a cada
 * segundo). Separado de `computeActiveSessionEntries` para permitir
 * recalcular a contagem regressiva localmente a cada tick (Fase 3 —
 * substitui o antigo canal WS de 1Hz) sem refazer a consulta ao banco.
 */
export async function fetchActiveSessionsRaw(unitId: string): Promise<ActiveSessionsRaw> {
  const [sessions, clockOffsetMs] = await Promise.all([
    unwrap<Record<string, unknown>[]>(
      supabase().from("fa_kiosk_sessions").select("*").eq("unit_id", unitId).eq("status", "ATIVA"),
    ),
    fetchClockOffsetMs(),
  ]);
  if (sessions.length === 0)
    return {
      sessions: [],
      planById: new Map(),
      guardianById: new Map(),
      assetById: new Map(),
      childById: new Map(),
      packageBalanceByGuardian: new Map(),
      clockOffsetMs,
    };

  // Sessões de banco de horas não têm plano (plan_id nulo) — não entram
  // na consulta de planos; o pseudo-plano delas é montado no compute.
  const planIds = [...new Set(sessions.map((s) => s.plan_id as string | null).filter((id): id is string => Boolean(id)))];
  const guardianIds = [...new Set(sessions.map((s) => s.guardian_id as string))];
  const assetIds = [...new Set(sessions.map((s) => s.asset_id as string | null).filter((id): id is string => Boolean(id)))];
  const childIds = [...new Set(sessions.map((s) => s.child_id as string))];
  let packageBalanceFailed = false;
  const [plans, guardians, assets, children, balances] = await Promise.all([
    unwrap<Record<string, unknown>[]>(supabase().from("fa_kiosk_plans").select("*").in("id", planIds)),
    unwrap<Record<string, unknown>[]>(supabase().from("fa_kiosk_guardians").select("id, full_name, phone_e164").in("id", guardianIds)),
    assetIds.length === 0
      ? Promise.resolve([])
      : unwrap<Record<string, unknown>[]>(supabase().from("fa_kiosk_assets").select("id, name, emoji, photo_url").in("id", assetIds)),
    unwrap<Record<string, unknown>[]>(supabase().from("fa_kiosk_children").select("id, birth_date, inclusive_eligible").in("id", childIds)),
    // Saldo de pacote pré-pago. Sem isto o card mostraria o preço cheio e o
    // fechamento cobraria menos — o operador leria a diferença como erro do
    // sistema justamente na frente do cliente que comprou o pacote.
    unwrap<{ guardian_id: string; remaining_minutes: number }[]>(
      supabase().rpc("fa_kiosk_guardian_package_balance", { p_unit_id: unitId, p_guardian_ids: guardianIds }),
    ).catch(() => {
      // Falha na consulta não pode virar "saldo zero" em silêncio: o card
      // passaria a cobrar plano que o servidor não cobra (e o fechamento
      // recusaria o pagamento por divergência).
      packageBalanceFailed = true;
      return [] as { guardian_id: string; remaining_minutes: number }[];
    }),
  ]);
  return {
    packageBalanceFailed,
    sessions,
    planById: new Map(plans.map((p) => [p.id as string, planFromRow(p)])),
    guardianById: new Map(guardians.map((g) => [g.id as string, g])),
    assetById: new Map(assets.map((a) => [a.id as string, a])),
    childById: new Map(children.map((c) => [c.id as string, c])),
    packageBalanceByGuardian: new Map(balances.map((b) => [b.guardian_id, b.remaining_minutes])),
    clockOffsetMs,
  };
}

/**
 * Offset entre o relógio do servidor e o do tablet do kiosk, medido uma
 * vez por busca. Se a RPC falhar por qualquer motivo, cai para offset 0
 * (comportamento antigo) em vez de quebrar o painel inteiro.
 */
async function fetchClockOffsetMs(): Promise<number> {
  try {
    const deviceNowMs = Date.now();
    const serverNowMs = await unwrap<number>(supabase().rpc("fa_now_ms"));
    return serverNowMs - deviceNowMs;
  } catch {
    return 0;
  }
}

export function computeActiveSessionEntries(raw: ActiveSessionsRaw, nowMs: number): ActiveSessionEntry[] {
  const effectiveNowMs = nowMs + (raw.clockOffsetMs ?? 0);

  return raw.sessions.map((row) => {
    const usesHourBank = Boolean(row.uses_hour_bank);
    const usesPackage = Boolean(row.uses_package);
    const usesChildCredit = Boolean(row.uses_child_credit);
    const usesGuardianPackageMode = Boolean(row.uses_guardian_package);
    // Sessão de banco de horas: não existe plano vendido. O pseudo-plano
    // reusa o mesmo motor de preço — valor 0, duração = saldo alocado no
    // check-in e excedente pela tarifa congelada do crédito de origem.
    // Sessão de Pacote: também não existe plano vendido, mas o pacote É
    // cobrado no fechamento (preço cheio, congelado no check-in) — só a
    // duração/excedente seguem o mesmo padrão do banco de horas.
    // Saldo de pacote do responsável (ex.: Porto Seguro): o fechamento no banco
    // (fa_checkout) consome o saldo do pacote e zera o valor do plano avulso.
    // Espelhar isso aqui garante que o Painel, a Saída e o CheckoutModal mostrem
    // R$ 0,00 e a duração real restante, evitando cobrança indevida no caixa.
    const guardianPackageBalance = raw.packageBalanceByGuardian.get(row.guardian_id as string) ?? 0;
    const originalPlan = raw.planById.get(row.plan_id as string);
    const isBirthdayPlan = Boolean(originalPlan?.birthdayCourtesy);
    const usesGuardianPackage =
      !usesGuardianPackageMode &&
      !usesHourBank &&
      !usesPackage &&
      !usesChildCredit &&
      !row.rental_kind &&
      !isBirthdayPlan &&
      row.activity === "PLAYGROUND" &&
      guardianPackageBalance > 0;

    const plan: Plan = usesGuardianPackageMode
      ? {
          // Modo explícito (fa_checkout, ramo uses_guardian_package): o plano
          // nunca é cobrado; a duração é o saldo e o excedente sai pela tarifa
          // do pacote congelada no check-in. Se a consulta do saldo falhou, não
          // dá para afirmar cobrança: mostra sem excedente (o servidor decide).
          id: `PKG_BALANCE:${row.guardian_id as string}`,
          activity: "PLAYGROUND",
          name: "Porto Seguro (Saldo)",
          valueCents: 0,
          durationValue: raw.packageBalanceFailed ? 24 * 60 : guardianPackageBalance,
          durationUnit: "MINUTO",
          overageCentsPerMinute: (row.guardian_package_overage_cents_per_minute as number | null) ?? 0,
          color: "#1A3F35",
        }
      : usesHourBank
      ? {
          id: "HOUR_BANK",
          activity: row.activity as Plan["activity"],
          name: "Banco de Horas",
          valueCents: 0,
          durationValue: (row.hour_bank_allocated_minutes as number | null) ?? 0,
          durationUnit: "MINUTO",
          overageCentsPerMinute: (row.hour_bank_overage_cents_per_minute as number | null) ?? 0,
          color: "#2ECFB5",
        }
      : usesPackage
        ? {
            id: `PKG:${row.package_id as string}`,
            activity: row.activity as Plan["activity"],
            name: (row.package_name_snapshot as string | null) ?? "Pacote",
            valueCents: (row.package_price_cents as number | null) ?? 0,
            durationValue: (row.package_allocated_minutes as number | null) ?? 0,
            durationUnit: "MINUTO",
            overageCentsPerMinute: (row.package_overage_cents_per_minute as number | null) ?? 0,
            color: "#FF7A00",
          }
        : usesChildCredit
          ? {
              id: `CREDIT:${row.child_credit_id as string}`,
              activity: row.activity as Plan["activity"],
              name: (row.child_credit_name_snapshot as string | null) ?? "Saldo pré-pago",
              valueCents: 0,
              // O fechamento (fa_checkout) abate do pacote do responsável o que
              // o saldo da criança não cobrir; somar aqui mantém o contador e o
              // total da tela iguais aos do servidor.
              durationValue:
                ((row.child_credit_allocated_minutes as number | null) ?? 0) +
                guardianPackageBalance,
              durationUnit: "MINUTO",
              overageCentsPerMinute: (row.child_credit_overage_cents_per_minute as number | null) ?? 0,
              color: "#7C4DFF",
            }
        : usesGuardianPackage
          ? {
              id: `PKG_BALANCE:${row.guardian_id as string}`,
              activity: "PLAYGROUND",
              name: "Porto Seguro (Pacote)",
              valueCents: 0,
              durationValue: guardianPackageBalance,
              durationUnit: "MINUTO",
              overageCentsPerMinute: originalPlan?.overageCentsPerMinute ?? 0,
              color: "#1A3F35",
            }
          : originalPlan!;
    const guardian = raw.guardianById.get(row.guardian_id as string);
    const assetRow = row.asset_id ? raw.assetById.get(row.asset_id as string) : undefined;
    const childRow = raw.childById.get(row.child_id as string);
    const quoteInput = {
        checkinAtMs: row.checkin_at_ms as number,
        childName: row.child_name_snapshot as string,
        planId: row.plan_id as string,
        activity: row.activity as "PLAYGROUND" | "CARRINHO",
        couponDiscountCents: usesGuardianPackage || usesGuardianPackageMode ? 0 : (row.coupon_discount_cents as number),
        couponCode: null,
        couponKind: (row.coupon_kind as "DESCONTO_PCT" | "DESCONTO_VALOR" | null) ?? null,
        couponPct: (row.coupon_pct as number | null) ?? null,
        freeFromLoyalty: Boolean(row.free_from_loyalty),
        pausedAtMs: (row.paused_at_ms as number | null) ?? null,
        pausedMsTotal: (row.paused_ms_total as number) ?? 0,
        loyaltyCourtesyMinutes: (row.loyalty_courtesy_minutes as number | null) ?? 0,
        courtesyZeroesPlan: !usesHourBank && !usesPackage && !usesChildCredit && !usesGuardianPackage && !usesGuardianPackageMode && !row.rental_kind,
        freeStayKeepsPlanValue: usesPackage,
    };
    const quote = quoteForSession(plan, quoteInput, effectiveNowMs);
    // Cotação usada só no fechamento (CheckoutModal): aplica a tolerância
    // interna de saída imediata. O painel ao vivo segue com `quote`.
    const checkoutQuote = quoteForSession(plan, quoteInput, effectiveNowMs, { applyFreeStay: true });
    return {
      session: {
        id: row.id as string,
        child_id: row.child_id as string,
        child_name_snapshot: row.child_name_snapshot as string,
        activity: row.activity as "PLAYGROUND" | "CARRINHO",
        checkin_at_ms: row.checkin_at_ms as number,
        checkin_by_employee_id: (row.checkin_by_employee_id as string | null) ?? null,
        asset_id: row.asset_id as string | null,
        wristband_code: row.wristband_code as string,
        access_code: (row.access_code as string | null) ?? null,
        exit_pin: (row.exit_pin as string | null) ?? null,
        guardian_id: (row.guardian_id as string | null) ?? undefined,
        guardian_name_snapshot: (guardian?.full_name as string) ?? undefined,
        guardian_phone_snapshot: (guardian?.phone_e164 as string) ?? undefined,
        child_birth_date: (childRow?.birth_date as string) ?? undefined,
        child_inclusive_eligible: Boolean(childRow?.inclusive_eligible),
        // Estes dois chegavam do banco no select("*") e eram descartados
        // aqui — por isso o alerta de cuidados no card do Painel e o "OBS"
        // da etiqueta nunca apareciam, mesmo com a tela de Entrada tendo um
        // seletor de tags sensoriais desde o começo.
        notes: (row.notes as string | null) ?? undefined,
        sensory_tags: (row.sensory_tags as string[] | null) ?? undefined,
        paused_at_ms: (row.paused_at_ms as number | null) ?? null,
        paused_ms_total: (row.paused_ms_total as number) ?? 0,
        loyalty_courtesy_minutes: (row.loyalty_courtesy_minutes as number | null) ?? 0,
        package_balance_minutes: raw.packageBalanceByGuardian.get(row.guardian_id as string),
        uses_hour_bank: usesHourBank,
        hour_bank_allocated_minutes: (row.hour_bank_allocated_minutes as number | null) ?? undefined,
        uses_package: usesPackage,
        package_id: (row.package_id as string | null) ?? undefined,
        package_allocated_minutes: (row.package_allocated_minutes as number | null) ?? undefined,
        uses_child_credit: usesChildCredit,
        uses_guardian_package: usesGuardianPackageMode,
        child_credit_id: (row.child_credit_id as string | null) ?? undefined,
        child_credit_allocated_minutes: (row.child_credit_allocated_minutes as number | null) ?? undefined,
        rental_kind: (row.rental_kind as "PELUCIA" | null) ?? null,
      },
      quote,
      checkoutQuote,
      plan: { id: plan.id, name: plan.name, color: plan.color },
      asset: assetRow
        ? {
            id: assetRow.id as string,
            name: assetRow.name as string,
            emoji: assetRow.emoji as string,
            photo_url: (assetRow.photo_url as string | null) ?? null,
          }
        : null,
    };
  });
}

async function fetchActiveSessions(unitId: string, nowMs: number = Date.now()): Promise<ActiveSessionEntry[]> {
  return computeActiveSessionEntries(await fetchActiveSessionsRaw(unitId), nowMs);
}

/**
 * Configuração do programa de bonificação (metas/supermetas por dia da
 * semana + teto/produtos/bônus extras) de cada unidade pedida — vazio para
 * quem ainda não foi configurado em Gerencial > Metas. Reaproveitado por
 * `fetchApuracaoDias` (apuração) e por quem só precisa da meta de hoje
 * (card do Painel, menu Minha Bonificação).
 */
async function fetchBonusProgramsByUnit(unitIds: string[]): Promise<BonusProgramsByUnit> {
  if (unitIds.length === 0) return {};
  const [goalRows, configRows, ruleRows, openingRows, overrideRows] = await Promise.all([
    unwrap<Record<string, unknown>[]>(
      supabase()
        .from("fa_kiosk_bonus_program_goals")
        .select("unit_id, weekday, meta_valor, super_valor, meta_bonus_cents, super_bonus_cents")
        .in("unit_id", unitIds),
    ),
    unwrap<Record<string, unknown>[]>(supabase().from("fa_kiosk_bonus_program_config").select("*").in("unit_id", unitIds)),
    unwrap<Record<string, unknown>[]>(
      supabase()
        .from("fa_kiosk_bonus_plan_rules")
        .select("unit_id, kind, ref_id, label, bonus_cents, escada_meta, escada_bonus_cents, active, sort_order")
        .in("unit_id", unitIds),
    ),
    unwrap<Record<string, unknown>[]>(
      supabase().from("fa_kiosk_unit_opening_hours").select("unit_id, weekday, abertura_min").in("unit_id", unitIds),
    ),
    unwrap<Record<string, unknown>[]>(
      supabase().from("fa_kiosk_unit_opening_overrides").select("unit_id, business_date, abertura_min").in("unit_id", unitIds),
    ),
  ]);

  const aberturaPorDiaByUnit = new Map<string, Record<number, number>>();
  for (const row of openingRows) {
    const unitId = row.unit_id as string;
    const map = aberturaPorDiaByUnit.get(unitId) ?? {};
    map[row.weekday as number] = row.abertura_min as number;
    aberturaPorDiaByUnit.set(unitId, map);
  }
  const aberturaPorDataByUnit = new Map<string, Record<string, number>>();
  for (const row of overrideRows) {
    const unitId = row.unit_id as string;
    const map = aberturaPorDataByUnit.get(unitId) ?? {};
    map[row.business_date as string] = row.abertura_min as number;
    aberturaPorDataByUnit.set(unitId, map);
  }

  const rulesByUnit = new Map<string, BonusPlanRule[]>();
  for (const row of ruleRows) {
    const unitId = row.unit_id as string;
    const list = rulesByUnit.get(unitId) ?? [];
    list.push({
      kind: row.kind as BonusPlanRule["kind"],
      refId: row.ref_id as string,
      label: row.label as string,
      bonusCents: row.bonus_cents as number,
      escadaMeta: row.escada_meta as number,
      escadaBonusCents: row.escada_bonus_cents as number,
      active: Boolean(row.active),
      sortOrder: row.sort_order as number,
    });
    rulesByUnit.set(unitId, list);
  }

  const goalsByUnit = new Map<string, BonusProgramGoal[]>();
  for (const row of goalRows) {
    const unitId = row.unit_id as string;
    const list = goalsByUnit.get(unitId) ?? [];
    list.push({
      weekday: row.weekday as number,
      metaValor: row.meta_valor as number,
      superValor: row.super_valor as number,
      metaBonusCents: row.meta_bonus_cents as number,
      superBonusCents: row.super_bonus_cents as number,
    });
    goalsByUnit.set(unitId, list);
  }

  const result: BonusProgramsByUnit = {};
  for (const row of configRows) {
    const unitId = row.unit_id as string;
    result[unitId] = {
      goals: goalsByUnit.get(unitId) ?? [],
      tetoMesCents: row.teto_mes_cents as number,
      produtoPrecoCorteCents: row.produto_preco_corte_cents as number,
      produtoBonusBaixoCents: row.produto_bonus_baixo_cents as number,
      produtoBonusAltoCents: row.produto_bonus_alto_cents as number,
      itensMesMeta: row.itens_mes_meta as number,
      itensMesBonusCents: row.itens_mes_bonus_cents as number,
      sessao1hPercentualMin: row.sessao_1h_percentual_min as number,
      sessao1hBonusCents: row.sessao_1h_bonus_cents as number,
      locacaoExtraBonusCents: row.locacao_extra_bonus_cents as number,
      planosTetoMesCents: (row.planos_teto_mes_cents as number | null) ?? 0,
      planRules: rulesByUnit.get(unitId) ?? [],
      aberturaMinPorDia: aberturaPorDiaByUnit.get(unitId) ?? {},
      aberturaMinPorData: aberturaPorDataByUnit.get(unitId) ?? {},
    };
  }
  return result;
}

async function fetchInBatches<T>(
  ids: string[],
  batchSize: number,
  fetcher: (batch: string[]) => Promise<T[]>,
): Promise<T[]> {
  if (ids.length === 0) return [];
  if (ids.length <= batchSize) return fetcher(ids);
  const batches: string[][] = [];
  for (let i = 0; i < ids.length; i += batchSize) {
    batches.push(ids.slice(i, i + batchSize));
  }
  const results = await Promise.all(batches.map(fetcher));
  return results.flat();
}

/**
 * Busca os dados brutos e roda `apurarBonificacaoPorDia` (mesma lógica de
 * docs/bonificacao/apuracao_bonificacao.sql) — reaproveitado por
 * `Api.bonusAccrualMonth` (agregado, Gerencial > Bonificação) e
 * `Api.myBonusAccrual` (filtrado a um colaborador, menu Minha Bonificação).
 */
async function fetchApuracaoDias(
  unitIds: string[],
  from: string,
  to: string,
): Promise<{ dias: ApuracaoDia[]; units: RawUnit[]; employees: RawEmployee[]; programs: BonusProgramsByUnit }> {
  const [sessions, orders, shifts, employees, units, programs, guardianPackages] = await Promise.all([
    unwrap<Record<string, unknown>[]>(
      supabase()
        .from("fa_kiosk_sessions")
        .select("id, unit_id, business_date, checkin_by_employee_id, order_id, plan_id, rental_kind, status, uses_package")
        .in("unit_id", unitIds)
        .gte("business_date", from)
        .lte("business_date", to),
    ),
    unwrap<Record<string, unknown>[]>(
      supabase()
        .from("fa_kiosk_orders")
        .select("id, unit_id, business_date, status, total_cents, closed_by_employee_id")
        .in("unit_id", unitIds)
        .gte("business_date", from)
        .lte("business_date", to),
    ),
    unwrap<Record<string, unknown>[]>(
      supabase()
        .from("fa_kiosk_shifts")
        .select("unit_id, business_date, status, opened_at_ms, opened_by_employee_id, declared_json, expected_json, close_justifications_json")
        .in("unit_id", unitIds)
        .gte("business_date", from)
        .lte("business_date", to),
    ),
    unwrap<Record<string, unknown>[]>(supabase().from("fa_kiosk_employees").select("id, full_name, role")),
    unwrap<Record<string, unknown>[]>(supabase().from("fa_kiosk_units").select("id, name, kind").in("id", unitIds)),
    fetchBonusProgramsByUnit(unitIds),
    // Pacotes vendidos no período (Day Use, Porto Seguro…): base do Bônus de Planos Longos.
    unwrap<Record<string, unknown>[]>(
      supabase()
        .from("fa_kiosk_guardian_packages")
        .select("id, unit_id, business_date, package_id, sold_by_employee_id, order_id")
        .in("unit_id", unitIds)
        .gte("business_date", from)
        .lte("business_date", to),
    ),
  ]);

  const planIds = [...new Set(sessions.map((s) => s.plan_id as string | null).filter((id): id is string => Boolean(id)))];
  const orderIds = orders.map((o) => o.id as string);
  const [plans, orderItems] = await Promise.all([
    fetchInBatches(planIds, 100, (batch) =>
      unwrap<Record<string, unknown>[]>(supabase().from("fa_kiosk_plans").select("id, duration_unit, duration_value").in("id", batch)),
    ),
    fetchInBatches(orderIds, 100, (batch) =>
      unwrap<Record<string, unknown>[]>(
        supabase().from("fa_kiosk_order_items").select("order_id, session_id, item_type, quantity, total_cents, unit_price_cents").in("order_id", batch),
      ),
    ),
  ]);

  const rawSessions: RawSession[] = sessions.map((s) => ({
    id: s.id as string,
    unit_id: s.unit_id as string,
    business_date: s.business_date as string,
    checkin_by_employee_id: (s.checkin_by_employee_id as string | null) ?? null,
    order_id: (s.order_id as string | null) ?? null,
    plan_id: (s.plan_id as string | null) ?? null,
    rental_kind: (s.rental_kind as string | null) ?? null,
    canceled: s.status === "CANCELADA",
    uses_package: Boolean(s.uses_package),
  }));
  const rawGuardianPackages: RawGuardianPackage[] = guardianPackages.map((g) => ({
    id: g.id as string,
    unit_id: g.unit_id as string,
    business_date: g.business_date as string,
    package_id: g.package_id as string,
    sold_by_employee_id: (g.sold_by_employee_id as string | null) ?? null,
    order_id: (g.order_id as string | null) ?? null,
  }));
  const rawPlans: RawPlan[] = plans.map((p) => ({
    id: p.id as string,
    duration_unit: p.duration_unit as string,
    duration_value: p.duration_value as number,
  }));
  const rawOrders: RawOrder[] = orders.map((o) => ({
    id: o.id as string,
    unit_id: o.unit_id as string,
    business_date: o.business_date as string,
    status: o.status as string,
    total_cents: o.total_cents as number,
    closed_by_employee_id: (o.closed_by_employee_id as string | null) ?? null,
  }));
  const rawOrderItems: RawOrderItem[] = orderItems.map((i) => ({
    order_id: i.order_id as string,
    session_id: (i.session_id as string | null) ?? null,
    item_type: i.item_type as string,
    quantity: i.quantity as number,
    total_cents: i.total_cents as number,
    unit_price_cents: i.unit_price_cents as number,
  }));
  const rawShifts: RawShift[] = shifts.map((s) => ({
    unit_id: s.unit_id as string,
    business_date: s.business_date as string,
    status: s.status as "ABERTO" | "FECHADO",
    opened_at_ms: s.opened_at_ms as number,
    opened_by_employee_id: s.opened_by_employee_id as string,
    declared_json: (s.declared_json as Record<string, number> | null) ?? null,
    expected_json: (s.expected_json as Record<string, number> | null) ?? null,
    close_justifications_json: (s.close_justifications_json as Record<string, string> | null) ?? null,
  }));
  const rawEmployees: RawEmployee[] = employees.map((e) => ({ id: e.id as string, full_name: e.full_name as string, role: e.role as string }));
  const rawUnits: RawUnit[] = units.map((u) => ({ id: u.id as string, name: u.name as string, kind: u.kind as string }));

  const dias = apurarBonificacaoPorDia({
    from,
    to,
    sessions: rawSessions,
    plans: rawPlans,
    orders: rawOrders,
    orderItems: rawOrderItems,
    shifts: rawShifts,
    employees: rawEmployees,
    units: rawUnits,
    programs,
    guardianPackages: rawGuardianPackages,
  });
  return { dias, units: rawUnits, employees: rawEmployees, programs };
}

export type CrmStage = "NOVO" | "EM_CONVERSA" | "INTERESSADO" | "CLIENTE" | "INATIVO";

export interface CrmContact {
  id: string;
  channel_id: string;
  phone_e164: string;
  name: string | null;
  guardian_id: string | null;
  stage: CrmStage;
  tags: string[];
  notes: string | null;
  opt_in: boolean;
  unread_count: number;
  last_inbound_ms: number | null;
  last_message_ms: number | null;
  last_message_preview: string | null;
  fa_crm_channels?: { label: string } | null;
}

export interface CrmMessage {
  id: string;
  contact_id: string;
  direction: "IN" | "OUT";
  body: string;
  media: { url: string; contentType?: string }[];
  status: "received" | "queued" | "sent" | "delivered" | "read" | "failed" | "undelivered";
  error: string | null;
  created_at_ms: number;
}

export interface CrmTemplate {
  id: string;
  name: string;
  preview: string;
  variable_count: number;
}

export const Api = {
  /** Unidade amarrada a ESTE computador (Configurações > Impressoras > Este terminal). */
  terminalUnit: () => getTerminalUnit(),
  setTerminalUnit: (unitId: string) => setTerminalUnit(unitId),
  /** ID desta instalação; null fora do Electron. */
  deviceId: () => localDeviceId(),
  /** Info de atualizações do sistema local (quiosque/Electron). */
  systemInfo: async () => {
    try {
      const res = await fetch("/api/system/info");
      if (!res.ok) return null;
      return (await res.json()) as { update: { status: string; version?: string; progress?: number; error?: string }; now: number };
    } catch {
      return null;
    }
  },
  checkSystemUpdate: async () => {
    try {
      const res = await fetch("/api/system/update/check", { method: "POST" });
      if (!res.ok) return null;
      return (await res.json()) as { ok: boolean; update?: { status: string; version?: string; progress?: number; error?: string } };
    } catch {
      return null;
    }
  },
  applySystemUpdate: async () => {
    try {
      await fetch("/api/system/update/apply", { method: "POST" });
    } catch { /* melhor esforço: falha ignorada */ }
  },
  units: () =>
    unwrap<Unit[]>(
      supabase()
        .from("fa_kiosk_units")
        .select("id, kind, name, business_day_cutoff_hour, address, phone, cnpj, timezone, latitude, longitude, geofence_radius_m"),
    ),
  employees: async (unitId?: string): Promise<Employee[]> => {
    const employees = await unwrap<Employee[]>(
      supabase()
        .from("fa_kiosk_employees")
        .select(
          "id, full_name, role, cpf, email, phone, birth_date, admission_date, position, contract_type, weekly_hours_contracted, active, face_enrolled_photo_path, sector",
        )
        .eq("active", true)
        .order("full_name"),
    );
    if (!unitId) return employees;
    const links = await unwrap<{ employee_id: string }[]>(
      supabase().from("fa_kiosk_employee_units").select("employee_id").eq("unit_id", unitId),
    );
    if (links.length === 0) return employees;
    const linkedEmployeeIds = new Set(links.map((l) => l.employee_id));
    return employees.filter((e) => linkedEmployeeIds.has(e.id));
  },
  allEmployees: async () => {
    const [employees, links] = await Promise.all([
      unwrap<Employee[]>(
        supabase()
          .from("fa_kiosk_employees")
          .select(
            "id, full_name, role, cpf, email, phone, birth_date, admission_date, position, contract_type, weekly_hours_contracted, active, face_enrolled_photo_path",
          )
          .order("full_name"),
      ),
      unwrap<{ employee_id: string; unit_id: string }[]>(supabase().from("fa_kiosk_employee_units").select("employee_id, unit_id")),
    ]);
    const unitIdsByEmployee = new Map<string, string[]>();
    for (const link of links) {
      unitIdsByEmployee.set(link.employee_id, [...(unitIdsByEmployee.get(link.employee_id) ?? []), link.unit_id]);
    }
    return employees.map((e) => ({ ...e, unitIds: unitIdsByEmployee.get(e.id) ?? [] }));
  },
  plans: async (unitId: string, activity: string, onlyActive = true) => {
    let query = supabase().from("fa_kiosk_plans").select("*").eq("unit_id", unitId).eq("activity", activity);
    // Telas operacionais (onlyActive) nunca listam o plano da cortesia de
    // aniversário, mesmo que alguém o reative: ele só entra pelo
    // birthdayCourtesyOffer. As telas de cadastro (onlyActive = false) o veem.
    if (onlyActive) query = query.eq("active", true).eq("birthday_courtesy", false);
    const rows = await unwrap<Record<string, unknown>[]>(query);
    return rows.map(planFromRow);
  },
  /**
   * Cortesia de aniversário (30 min grátis no Playground) utilizável AGORA por
   * esta criança, ou null (sem cortesia, fora da validade, fim de semana,
   * unidade sem o plano). A regra mora no servidor (fa_birthday_courtesy_usable);
   * a tela só mostra o card.
   */
  birthdayCourtesyOffer: async (childId: string, unitId: string) => {
    const rows = await unwrap<{ courtesy_id: string; plan_id: string; valid_until: string }[]>(
      supabase().rpc("fa_kiosk_birthday_courtesy_offer", { p_child_id: childId, p_unit_id: unitId }),
    );
    const row = rows[0];
    if (!row) return null;
    const planRows = await unwrap<Record<string, unknown>[]>(
      supabase().from("fa_kiosk_plans").select("*").eq("id", row.plan_id),
    );
    if (!planRows[0]) return null;
    return { courtesyId: row.courtesy_id, validUntil: row.valid_until, plan: planFromRow(planRows[0]) };
  },
  /** Cortesias de aniversário (tratamento e controle) com aniversário entre `from` e `to` (AAAA-MM-DD). */
  birthdayCourtesyReport: (from: string, to: string) =>
    unwrap<BirthdayCourtesyRow[]>(supabase().rpc("fa_birthday_courtesy_report", { p_from: from, p_to: to })),
  /** Todos os planos de todas as unidades — Gerencial. */
  plansAllUnits: async () => {
    const rows = await unwrap<Record<string, unknown>[]>(supabase().from("fa_kiosk_plans").select("*"));
    return rows.map(planFromRow);
  },
  assets: (unitId: string) =>
    unwrap<Asset[]>(
      supabase()
        .from("fa_kiosk_assets")
        .select("id, unit_id, name, emoji, color, status, odometer_minutes, photo_url, kind")
        .eq("unit_id", unitId),
    ),
  products: (unitId: string, onlyActive = true) => {
    let query = supabase()
      .from("fa_kiosk_products")
      .select("id, name, description, emoji, price_cents, cost_cents, stock, active")
      .eq("unit_id", unitId);
    if (onlyActive) query = query.eq("active", true);
    return unwrap<Product[]>(query);
  },
  /** Todos os produtos de todas as unidades — Gerencial. */
  productsAllUnits: () =>
    unwrap<Product[]>(
      supabase().from("fa_kiosk_products").select("id, name, description, emoji, price_cents, cost_cents, stock, active, unit_id"),
    ),
  // `unitId` é opcional só porque o limiar do selo VIP tem padrão global;
  // passando-o, a busca respeita o limiar configurado para a unidade.
  searchChildren: async (q: string, unitId?: string) => {
    if (!q || q.length < 2) return [];
    return unwrap<ChildMatch[]>(
      supabase().rpc("fa_kiosk_search_children", { p_query: q, p_unit_id: unitId ?? null }),
    );
  },
  /**
   * Cuidados inclusivos registrados na última visita da criança.
   *
   * Necessidade sensorial não muda de uma visita para a outra: obrigar o
   * operador a remarcar "usa abafador" toda vez é o tipo de recadastro que
   * na prática deixa de ser feito na correria — e aí o monitor não recebe a
   * informação. Vem preenchido e pode ser alterado.
   */
  lastCareForChild: async (childId: string) => {
    const row = await unwrap<{ notes: string | null; sensory_tags: string[] | null } | null>(
      supabase()
        .from("fa_kiosk_sessions")
        .select("notes, sensory_tags")
        .eq("child_id", childId)
        .order("checkin_at_ms", { ascending: false })
        .limit(1)
        .maybeSingle(),
    );
    return { notes: row?.notes ?? "", sensoryTags: row?.sensory_tags ?? [] };
  },
  lastAssetForChild: async (childId: string) => {
    const assetId = await unwrap<string | null>(supabase().rpc("fa_kiosk_last_asset_for_child", { p_child_id: childId }));
    return { assetId };
  },
  activeSessions: (unitId: string) => fetchActiveSessions(unitId),

  // ── Motor de cross-selling ─────────────────────────────────────────
  /**
   * Oferta de upgrade para esta criança, ou o motivo de não haver.
   *
   * Nunca lança por "não tem oferta": a tela chama isto a cada criança
   * identificada no balcão, e o não-elegível é a maioria dos casos. Só
   * falha de rede/permissão vira exceção.
   */
  upsellOffer: (unitId: string, childId: string, guardianId?: string | null, employeeId?: string | null) =>
    unwrap<UpsellOffer>(
      supabase().rpc("fa_upsell_offer", {
        p_unit_id: unitId,
        p_child_id: childId,
        p_guardian_id: guardianId ?? null,
        p_employee_id: employeeId ?? null,
      }),
    ),
  /** Recusa registrada + cooldown de 15 dias aplicado ao responsável. */
  upsellRecusar: (offerId: string, employeeId?: string | null) =>
    unwrap<{ outcome: string; cooldownUntilMs: number; cooldownDays: number }>(
      supabase().rpc("fa_upsell_recusar", { p_offer_id: offerId, p_employee_id: employeeId ?? null }),
    ),
  /**
   * Aceite: cobra a DIFERENÇA anunciada no script, gera o pedido, o saldo
   * do pacote e o comprovante impresso — tudo na mesma transação do banco.
   * O valor não é enviado daqui de propósito: quem decide quanto cobrar é
   * a oferta gravada, não a tela.
   */
  upsellVenderPacote: (body: {
    offerId: string;
    employeeId: string;
    payments: { method: string; amountCents: number }[];
  }) =>
    localDeviceId().then((deviceId) =>
      callResilient<{
        orderId: string;
        orderCode: string;
        chargedCents: number;
        guardianPackageId: string;
        expiresAtMs: number;
      }>("fa_upsell_vender_pacote", {
        p_offer_id: body.offerId,
        p_payments: body.payments,
        p_employee_id: body.employeeId,
        p_device_id: deviceId,
      }),
    ),
  /**
   * Cross-sell rápido: adiciona um produto único (ex.: "Água") à comanda
   * da sessão, cobrado junto no fechamento (fa_checkout). Diferente do
   * upgrade de pacote (upsellVenderPacote) — aqui não há cobrança
   * imediata nem ancoragem, é só um item extra que entra na conta.
   */
  /** Registra (ou revoga) o aceite de contato por WhatsApp/NPS do responsável — ver migration fa_guardian_whatsapp_consent. */
  setWhatsappConsent: (guardianId: string, consent: boolean, employeeId: string) =>
    unwrap<void>(
      supabase().rpc("fa_kiosk_set_whatsapp_consent", { p_guardian_id: guardianId, p_consent: consent, p_employee_id: employeeId }),
    ),
  /** Registra (ou revoga) o aceite de MARKETING (ofertas/novidades), separado do aceite geral acima — ver migration fa_crm_lifecycle_campaigns. */
  setMarketingConsent: (guardianId: string, consent: boolean, employeeId: string) =>
    unwrap<void>(
      supabase().rpc("fa_kiosk_set_marketing_consent", { p_guardian_id: guardianId, p_consent: consent, p_employee_id: employeeId }),
    ),
  addSessionExtra: (sessionId: string, productId: string, employeeId: string, quantity = 1) =>
    unwrap<void>(
      supabase().rpc("fa_kiosk_add_session_extra", {
        p_session_id: sessionId,
        p_product_id: productId,
        p_quantity: quantity,
        p_employee_id: employeeId,
      }),
    ),
  /** Selo VIP de várias crianças numa consulta só (cards do Painel). */
  vipFlags: async (unitId: string, childIds: string[]) => {
    if (childIds.length === 0) return new Map<string, VipFlag>();
    const rows = await unwrap<VipFlag[]>(
      supabase().rpc("fa_kiosk_vip_flags", { p_unit_id: unitId, p_child_ids: childIds }),
    );
    return new Map(rows.map((r) => [r.child_id, r]));
  },
  packages: async (unitId: string, activity: string, onlyActive = true) => {
    let query = supabase().from("fa_kiosk_packages").select("*").eq("unit_id", unitId).eq("activity", activity);
    if (onlyActive) query = query.eq("active", true);
    const rows = await unwrap<Record<string, unknown>[]>(query.order("price_cents"));
    return rows.map(packageFromRow);
  },
  /** Todos os pacotes de todas as unidades — Gerencial. */
  packagesAllUnits: async () => {
    const rows = await unwrap<Record<string, unknown>[]>(supabase().from("fa_kiosk_packages").select("*").order("price_cents"));
    return rows.map(packageFromRow);
  },
  createPackage: (body: {
    unitId: string;
    activity: Package["activity"];
    name: string;
    priceCents: number;
    includedMinutes: number;
    validityDays: number;
    benefitText: string;
    color: string;
    overageCentsPerMinute: number;
  }) =>
    unwrap<{ id: string }>(
      supabase()
        .from("fa_kiosk_packages")
        .insert({
          unit_id: body.unitId,
          activity: body.activity,
          name: body.name,
          price_cents: body.priceCents,
          included_minutes: body.includedMinutes,
          validity_days: body.validityDays,
          benefit_text: body.benefitText,
          color: body.color,
          overage_cents_per_minute: body.overageCentsPerMinute,
        })
        .select("id")
        .single(),
    ),
  setPackageActive: (id: string, active: boolean) =>
    unwrap(supabase().from("fa_kiosk_packages").update({ active }).eq("id", id)),
  updatePackage: (id: string, body: { name: string; priceCents: number; includedMinutes: number; validityDays: number; benefitText: string; color: string; overageCentsPerMinute: number }) =>
    unwrap(supabase().from("fa_kiosk_packages").update({
      name: body.name,
      price_cents: body.priceCents,
      included_minutes: body.includedMinutes,
      validity_days: body.validityDays,
      benefit_text: body.benefitText,
      color: body.color,
      overage_cents_per_minute: body.overageCentsPerMinute,
    }).eq("id", id)),
  redeemableRewards: (childId: string) =>
    unwrap<RedeemableReward[]>(
      supabase()
        .from("fa_kiosk_loyalty_rewards")
        .select("id, rule_id, earned_at_ms")
        .eq("child_id", childId)
        .is("redeemed_at_ms", null),
    ),
  currentShift: (unitId: string) =>
    unwrap<Shift | null>(
      supabase()
        .from("fa_kiosk_shifts")
        .select("id, unit_id, status, opening_cash_cents, opened_at_ms, expected_opening_cash_cents, opening_divergence_cents, opened_by_employee_id")
        .eq("unit_id", unitId)
        .eq("status", "ABERTO")
        .maybeSingle(),
    ),

  /** Saldo do banco de horas (planos >2h) por criança — vale em qualquer unidade. */
  hourBankBalances: async (childIds: string[]) => {
    if (childIds.length === 0) return new Map<string, HourBankBalance>();
    const rows = await unwrap<HourBankBalance[]>(
      supabase().rpc("fa_kiosk_hour_bank_balance", { p_child_ids: childIds }),
    );
    return new Map(rows.map((r) => [r.child_id, r]));
  },
  /** Dados cadastrais do responsável para preencher o contrato dos planos >2h. */
  guardianContractInfo: (guardianId: string) =>
    unwrap<GuardianContractInfo>(
      supabase().rpc("fa_kiosk_guardian_contract_info", { p_guardian_id: guardianId }),
    ),
  updateGuardianContractInfo: (body: {
    guardianId: string;
    rg?: string;
    email?: string;
    addressLine?: string;
    addressCity?: string;
    addressState?: string;
    addressZip?: string;
  }) =>
    unwrap<void>(
      supabase().rpc("fa_kiosk_guardian_contract_info_update", {
        p_guardian_id: body.guardianId,
        p_rg: body.rg ?? null,
        p_email: body.email ?? null,
        p_address_line: body.addressLine ?? null,
        p_address_city: body.addressCity ?? null,
        p_address_state: body.addressState ?? null,
        p_address_zip: body.addressZip ?? null,
      }),
    ),

  checkin: (body: {
    unitId: string;
    activity: "PLAYGROUND" | "CARRINHO";
    assetId?: string;
    /** Nulo quando a entrada é pelo banco de horas (useHourBank) ou por um Pacote (packageId). */
    planId: string | null;
    /** Entrada pelo saldo do banco de horas da criança (exige criança já cadastrada). */
    useHourBank?: boolean;
    /** Entrada por um Pacote: compra/renova o saldo do responsável e usa nesta mesma visita. */
    packageId?: string | null;
    /** Entrada consumindo saldo pré-pago comprado numa visita anterior (fa_kiosk_sell_prepaid_credit). */
    childCreditId?: string | null;
    /** Entrada consumindo o saldo de pacote (Porto Seguro) do responsável: sem plano, sem cupom. */
    useGuardianPackage?: boolean;
    /** Balcão confirmou usar o saldo de pacote de OUTRA criança do responsável (irmão). */
    allowSiblingPackage?: boolean;
    employeeId: string;
    child: { id?: string; fullName: string; birthDate: string; inclusiveEligible: boolean; inclusiveProofType?: string };
    guardian: { id?: string; fullName: string; cpf: string; phoneE164: string };
    couponCode?: string;
    notes?: string;
    sensoryTags?: string[];
    /** Confirma um pré-cadastro feito pelo QR de Acesso Rápido — marca a origem como CONVERTIDO na mesma transação. */
    preCheckinId?: string;
    /** Qual criança da lista do pré-cadastro (0-based) está sendo confirmada — um pré-cadastro pode trazer vários irmãos. */
    preCheckinChildIndex?: number;
  }) =>
    // fa_checkin também enfileira, na mesma transação, a pulseira e o recibo
    // de guarda. Nenhuma tela precisa disparar impressão no check-in: se a
    // RPC voltou, as duas vias já estão na fila do print bridge.
    localDeviceId().then((deviceId) =>
      callResilient<{
        sessionId: string;
        childId: string;
        guardianId: string;
        accessCode: string;
        /** PIN numérico de 4 dígitos para digitação rápida na Saída (único do dia). */
        exitPin: string;
        wristbandCode: string;
        ticketCode: string;
        /** Minutos do banco de horas alocados nesta entrada (só quando useHourBank). */
        hourBankAllocatedMinutes: number | null;
        /** Minutos do pacote alocados nesta entrada (só quando packageId). */
        packageAllocatedMinutes: number | null;
        /** Minutos do saldo pré-pago alocados nesta entrada (só quando childCreditId). */
        childCreditAllocatedMinutes: number | null;
      }>(
        "fa_checkin",
        {
          p_unit_id: body.unitId,
          p_activity: body.activity,
          p_plan_id: body.planId,
          p_use_hour_bank: body.useHourBank ?? false,
          p_package_id: body.packageId ?? null,
          p_child_credit_id: body.childCreditId ?? null,
          p_use_guardian_package: body.useGuardianPackage ?? false,
          p_allow_sibling_package: body.allowSiblingPackage ?? false,
          p_asset_id: body.assetId ?? null,
          p_guardian: { id: body.guardian.id, fullName: body.guardian.fullName, cpf: body.guardian.cpf, phoneE164: body.guardian.phoneE164 },
          p_child: {
            id: body.child.id,
            fullName: body.child.fullName,
            birthDate: body.child.birthDate,
            inclusiveEligible: body.child.inclusiveEligible,
            inclusiveProofType: body.child.inclusiveProofType,
          },
          p_coupon_code: body.couponCode ?? null,
          p_employee_id: body.employeeId,
          p_notes: body.notes ?? null,
          p_sensory_tags: body.sensoryTags && body.sensoryTags.length > 0 ? body.sensoryTags : null,
          p_pre_checkin_id: body.preCheckinId ?? null,
          p_pre_checkin_child_index: body.preCheckinChildIndex ?? null,
          p_device_id: deviceId,
        },
      ),
    ),

  /**
   * Venda de saldo pré-pago SEM iniciar sessão — o pai paga no balcão e
   * a criança vai embora, para voltar outro dia. RPC própria
   * (fa_kiosk_sell_prepaid_credit), não uma variação do check-in: cobra
   * na hora (fa_checkin nunca toca em pagamento) e não cria sessão
   * nenhuma — nada de carrinho, pulseira, código de acesso ou PIN de
   * saída. Quando a criança voltar, o saldo aparece na fila do Painel
   * ("Saldos aguardando início") e também como card na busca da Entrada.
   */
  sellPrepaidCredit: (body: {
    unitId: string;
    activity: "PLAYGROUND" | "CARRINHO";
    /** Exatamente um dos dois: origem do saldo, congelada no crédito. */
    planId?: string | null;
    packageId?: string | null;
    guardian: { id?: string; fullName: string; cpf: string; phoneE164: string };
    child: { id?: string; fullName: string; birthDate: string; inclusiveEligible: boolean; inclusiveProofType?: string };
    couponCode?: string;
    payments: { method: string; amountCents: number; nsu?: string; authorization?: string; pixTxid?: string }[];
    employeeId: string;
  }) =>
    localDeviceId().then((deviceId) =>
      callResilient<{
        creditId: string;
        childId: string;
        guardianId: string;
        orderId: string;
        orderCode: string;
        chargedCents: number;
        minutesTotal: number;
      }>("fa_kiosk_sell_prepaid_credit", {
        p_unit_id: body.unitId,
        p_activity: body.activity,
        p_plan_id: body.planId ?? null,
        p_package_id: body.packageId ?? null,
        p_guardian: { id: body.guardian.id, fullName: body.guardian.fullName, cpf: body.guardian.cpf, phoneE164: body.guardian.phoneE164 },
        p_child: {
          id: body.child.id,
          fullName: body.child.fullName,
          birthDate: body.child.birthDate,
          inclusiveEligible: body.child.inclusiveEligible,
          inclusiveProofType: body.child.inclusiveProofType,
        },
        p_coupon_code: body.couponCode ?? null,
        p_payments: body.payments,
        p_employee_id: body.employeeId,
        p_device_id: deviceId,
      }),
    ),

  /** Saldo pré-pago agregado por criança — card "Usar saldo pré-pago" na Entrada. */
  childCreditBalances: async (childIds: string[]) => {
    if (childIds.length === 0) return new Map<string, ChildCreditBalance>();
    const rows = await unwrap<ChildCreditBalance[]>(
      supabase().rpc("fa_kiosk_child_credit_balance", { p_child_ids: childIds }),
    );
    return new Map(rows.map((r) => [r.child_id, r]));
  },

  /**
   * Pacotes com saldo (ex.: Porto Seguro) dos responsáveis ligados à criança,
   * um por linha, na ordem em que o fechamento os abate. A Entrada mostra a
   * lista antes da sessão; o fechamento da sessão em saldo pré-pago também
   * abate daqui quando o saldo da criança acaba (fa_checkout).
   */
  childPackages: (unitId: string, childId: string) =>
    unwrap<ChildPackageBalance[]>(
      supabase().rpc("fa_kiosk_child_package_list", { p_unit_id: unitId, p_child_id: childId }),
    ),

  /** Saldo de pacote ligado à família mas gravado em OUTRO responsável — o check-in cobraria avulso. */
  foreignPackageBalances: (unitId: string, childId: string, cpf?: string | null, phoneE164?: string | null) =>
    unwrap<ForeignPackageBalance[]>(
      supabase().rpc("fa_kiosk_foreign_package_balance", {
        p_unit_id: unitId,
        p_child_id: childId,
        p_cpf: cpf ?? null,
        p_phone_e164: phoneE164 ?? null,
      }),
    ),

  /** Fila do Painel: crianças com saldo pré-pago aguardando o operador iniciar a sessão. */
  prepaidCreditQueue: (unitId: string) =>
    unwrap<PrepaidCreditQueueItem[]>(
      supabase().rpc("fa_kiosk_child_credit_queue", { p_unit_id: unitId }),
    ),

  // --- QR Code de Acesso Rápido (pré-cadastro pelo responsável, sem login) --
  // Cartaz fixo na entrada de cada unidade: o responsável preenche os
  // mesmos dados que o operador digitaria na Entrada e aceita os Termos de
  // Uso pelo próprio celular. Vira só um PRÉ-cadastro (fa_kiosk_pre_checkins)
  // — o check-in de verdade continua sendo o operador confirmando no
  // balcão via `Api.checkin` (acima), passando `preCheckinId`.
  /** Nome/atividade da unidade, planos ativos e o texto de Termos de Uso — para montar o formulário público. Chamável sem login. */
  preCheckinFormOptions: (unitId: string) =>
    unwrap<{
      unitName: string;
      activity: "PLAYGROUND" | "CARRINHO";
      plans: Array<Pick<Plan, "id" | "name" | "valueCents" | "durationValue" | "durationUnit" | "color">>;
      /** Pacotes ativos da unidade — aparecem no mesmo seletor dos Planos, igual à Entrada (EntradaScreen). */
      packages: Array<Pick<Package, "id" | "name" | "priceCents" | "includedMinutes" | "color">>;
      termsText: string;
    }>(supabase().rpc("fa_pre_checkin_form_options", { p_unit_id: unitId })),
  /**
   * Envia o pré-cadastro preenchido pelo responsável — pode trazer mais de
   * uma criança (irmãos), um responsável/CPF/telefone/plano só. Retorna o
   * `id` (usado no poll de Api.preCheckinStatus) e um PIN de 4 dígitos — o
   * responsável fala/mostra esse número no balcão, e é assim que o
   * operador casa a família certa com o card certo na lista de pendentes
   * do Painel, sem precisar adivinhar por nome parecido. Chamável sem login.
   */
  preCheckinSubmit: (body: {
    unitId: string;
    activity: "PLAYGROUND" | "CARRINHO";
    /** Exatamente um dos dois — planId (permanência avulsa) ou packageId (pacote mensal). */
    planId?: string;
    packageId?: string;
    children: Array<{
      childName: string;
      birthDate: string;
      inclusiveEligible?: boolean;
      sensoryTags?: string[];
      notes?: string;
    }>;
    guardianName: string;
    cpf: string;
    phoneE164: string;
    termsAccepted: boolean;
  }) =>
    unwrap<{ id: string; pin: string }>(
      supabase().rpc("fa_pre_checkin_submit", {
        p_unit_id: body.unitId,
        p_activity: body.activity,
        p_plan_id: body.planId ?? null,
        p_package_id: body.packageId ?? null,
        p_children: body.children.map((c) => ({
          childName: c.childName,
          birthDate: c.birthDate,
          inclusiveEligible: c.inclusiveEligible ?? false,
          sensoryTags: c.sensoryTags && c.sensoryTags.length > 0 ? c.sensoryTags : [],
          notes: c.notes ?? null,
        })),
        p_guardian_name: body.guardianName,
        p_cpf: body.cpf,
        p_phone_e164: body.phoneE164,
        p_terms_accepted: body.termsAccepted,
      }),
    ),
  /** Poll da tela pública: status do pré-cadastro só por quem já tem o `id` — não é uma listagem. Chamável sem login. */
  preCheckinStatus: (preCheckinId: string) =>
    unwrap<{
      status: "PENDENTE" | "CONVERTIDO" | "CANCELADO";
      pin: string;
      totalChildren: number;
      sessions: Array<{ childIndex: number; childName: string; accessCode: string }>;
    }>(supabase().rpc("fa_pre_checkin_status", { p_id: preCheckinId })),
  /** Pré-cadastros pendentes da unidade, uma linha por CRIANÇA ainda não confirmada — para o balcão revisar e confirmar em EntradaScreen (prefill). */
  preCheckinList: (unitId: string) =>
    unwrap<
      Array<{
        id: string;
        childIndex: number;
        totalChildren: number;
        activity: "PLAYGROUND" | "CARRINHO";
        planId: string | null;
        planName: string | null;
        packageId: string | null;
        packageName: string | null;
        childName: string;
        birthDate: string;
        guardianName: string;
        cpf: string | null;
        phoneE164: string;
        inclusiveEligible: boolean;
        sensoryTags: string[] | null;
        notes: string | null;
        pin: string;
        createdAtMs: number;
      }>
    >(supabase().rpc("fa_pre_checkin_list", { p_unit_id: unitId })),
  /** Descarta um pré-cadastro pendente (duplicado, desistência). */
  preCheckinCancel: (preCheckinId: string, employeeId?: string) =>
    unwrap(supabase().rpc("fa_pre_checkin_cancel", { p_id: preCheckinId, p_employee_id: employeeId ?? null })),

  /**
   * Fechamento do atendimento.
   *
   * Havia aqui um "fechamento direto de segurança": quando fa_checkout
   * falhava por qualquer motivo, o navegador marcava as sessões como
   * FINALIZADA por conta própria e devolvia um código inventado. A criança
   * saía, mas nenhum pedido, item ou pagamento era gravado — o dinheiro
   * entrava no caixa físico e sumia do sistema, e o turno fechava com
   * divergência sem rastro de onde. Removido: erro de fechamento agora
   * chega à tela para o operador resolver (abrir o caixa, retomar a
   * sessão, tentar de novo), que é a única saída que não perde a venda.
   *
   * Queda de rede continua coberta, e sem esse risco: callResilient guarda
   * a chamada na fila offline com a mesma chave de idempotência e reenvia
   * quando a conexão volta.
   */
  checkout: (body: {
    sessionIds: string[];
    employeeId: string;
    payments: { method: string; amountCents: number; nsu?: string; authorization?: string; pixTxid?: string }[];
    redeemRewardIds?: string[];
    /**
     * Instante (ms, corrigido pro relógio do servidor) em que o operador
     * clicou para fechar a sessão — o contador e a cobrança da criança
     * travam aqui. O servidor nunca cobra por tempo depois disso, mesmo
     * que a confirmação do pagamento demore (ver fa_checkout: usa o menor
     * entre este valor e o relógio real do servidor).
     */
    closedAtMs?: number;
  }) =>
    callResilient<{ orderId: string; orderCode: string; totalCents: number }>("fa_checkout", {
      p_session_ids: body.sessionIds,
      p_payments: body.payments,
      p_redeem_reward_ids: body.redeemRewardIds ?? [],
      p_employee_id: body.employeeId,
      p_closed_at_ms: body.closedAtMs ?? null,
    }),
  /**
   * Pedido manual de NFS-e (botão "Emitir Nota Fiscal Serviço"), disparado
   * pelo Responsável — enfileira o documento em fa_kiosk_fiscal_docs; quem
   * de fato emite é o worker do kiosk (apps/kiosk/src/fiscal). A entrega
   * ao Responsável é por WhatsApp, pelo botão do CheckoutModal, depois que
   * o documento vira AUTORIZADO (ver nfseDocByOrder + markNfseSent).
   * Idempotente: pedir de novo para o mesmo pedido devolve o mesmo documento.
   */
  requestNfse: (orderId: string) => unwrap<{ fiscalDocId: string; status: string }>(supabase().rpc("fa_fiscal_request_nfse", { p_order_id: orderId })),
  /** NFS-e do pedido (para o kiosk-ui acompanhar a fila até AUTORIZADO). */
  nfseDocByOrder: (orderId: string) =>
    unwrap<FiscalDoc | null>(
      supabase()
        .from("fa_kiosk_fiscal_docs")
        .select("*")
        .eq("order_id", orderId)
        .eq("doc_type", "NFSE")
        .neq("status", "DESCARTADO")
        .maybeSingle(),
    ),
  /** Registra que a NFS-e foi enviada ao Responsável por WhatsApp (idempotente). */
  markNfseSent: (fiscalDocId: string) =>
    unwrap<{ fiscalDocId: string; sentAtMs: number }>(supabase().rpc("fa_fiscal_mark_nfse_sent", { p_fiscal_doc_id: fiscalDocId })),
  /** Atualiza o CPF do responsável no cadastro (usado no Caixa para destravar notas com CPF ausente). */
  updateGuardianCpf: async (guardianId: string, cpf: string): Promise<void> => {
    const cleanCpf = cpf.replace(/\D/g, "");
    if (cleanCpf.length !== 11) throw new Error("CPF deve conter 11 dígitos numéricos.");
    const { error } = await supabase().from("fa_kiosk_guardians").update({ cpf: cleanCpf }).eq("id", guardianId);
    if (error) throw new Error(`Erro ao atualizar CPF: ${error.message}`);
  },
  /** Atualiza dados cadastrais de responsável, telefone, CPF, nome da criança, data de nascimento e observações (utilizado no balcão e no Painel). */
  updateCustomerRegistration: async (params: {
    guardianId?: string | null;
    childId?: string | null;
    sessionId?: string | null;
    guardianName?: string;
    guardianPhone?: string;
    guardianCpf?: string;
    childName?: string;
    childBirthDate?: string | null;
    notes?: string | null;
  }): Promise<void> => {
    const { guardianId, childId, sessionId, guardianName, guardianPhone, guardianCpf, childName, childBirthDate, notes } = params;

    if (guardianId) {
      const updates: Record<string, unknown> = {};
      if (guardianName !== undefined) updates.full_name = guardianName.trim();
      if (guardianPhone !== undefined) {
        const norm = normalizePhoneE164(guardianPhone);
        if (norm) updates.phone_e164 = norm;
      }
      if (guardianCpf !== undefined) {
        const cleanCpf = guardianCpf.replace(/\D/g, "");
        if (cleanCpf) updates.cpf = cleanCpf;
      }
      if (Object.keys(updates).length > 0) {
        const { error } = await supabase().from("fa_kiosk_guardians").update(updates).eq("id", guardianId);
        if (error) throw new Error(`Erro ao atualizar dados do responsável: ${error.message}`);
      }
    }

    if (childId) {
      const childUpdates: Record<string, unknown> = {};
      if (childName !== undefined) childUpdates.full_name = childName.trim();
      if (childBirthDate !== undefined) childUpdates.birth_date = childBirthDate || null;
      if (notes !== undefined) childUpdates.notes = notes ? notes.trim() : null;
      if (Object.keys(childUpdates).length > 0) {
        const { error } = await supabase().from("fa_kiosk_children").update(childUpdates).eq("id", childId);
        if (error) throw new Error(`Erro ao atualizar dados da criança: ${error.message}`);
      }
    }

    if (sessionId) {
      const sessionUpdates: Record<string, unknown> = {};
      if (childName !== undefined) sessionUpdates.child_name_snapshot = childName.trim();
      if (guardianName !== undefined) sessionUpdates.guardian_name_snapshot = guardianName.trim();
      if (guardianPhone !== undefined) {
        const norm = normalizePhoneE164(guardianPhone);
        if (norm) sessionUpdates.guardian_phone_snapshot = norm;
      }
      if (Object.keys(sessionUpdates).length > 0) {
        await supabase().from("fa_kiosk_sessions").update(sessionUpdates).eq("id", sessionId);
      }
    }
  },
  pdvOrder: (body: {
    unitId: string;
    employeeId: string;
    items: { productId: string; quantity: number }[];
    payments: { method: string; amountCents: number; nsu?: string; authorization?: string; pixTxid?: string }[];
    fiscalCpf?: string | null;
  }) =>
    callResilient<{ orderId: string; orderCode: string; totalCents: number }>("fa_create_pdv_order", {
      p_unit_id: body.unitId,
      p_employee_id: body.employeeId,
      p_items: body.items,
      p_payments: body.payments,
      p_fiscal_cpf: body.fiscalCpf ?? null,
    }),

  fiscalDocByOrder: (orderId: string) =>
    unwrap<FiscalDoc | null>(
      supabase()
        .from("fa_kiosk_fiscal_docs")
        .select("*")
        .eq("order_id", orderId)
        .maybeSingle(),
    ),

  /**
   * Documentos fiscais de VÁRIOS pedidos numa consulta só (em lotes de 100).
   * O Caixa chamava `fiscalDocByOrder` uma vez por venda do turno, a cada 5 s:
   * com 80 vendas eram ~1.000 requisições por minuto só com a tela aberta.
   */
  fiscalDocsByOrders: async (orderIds: string[], docType: "NFCE" | "NFSE"): Promise<Record<string, FiscalDoc>> => {
    const docs = await fetchInBatches(orderIds, 100, (batch) => {
      const query = supabase().from("fa_kiosk_fiscal_docs").select("*").in("order_id", batch).eq("doc_type", docType);
      // Mesmo critério das consultas unitárias: nfseDocByOrder nunca devolveu
      // DESCARTADO; fiscalDocByOrder (NFC-e) devolvia (era o único documento).
      return unwrap<FiscalDoc[]>(docType === "NFSE" ? query.neq("status", "DESCARTADO") : query);
    });
    return fiscalDocsPorPedido(docs);
  },

  fiscalDocs: (unitId: string, limit = 50) =>
    unwrap<FiscalDoc[]>(
      supabase()
        .from("fa_kiosk_fiscal_docs")
        .select("*")
        .eq("unit_id", unitId)
        .order("created_at_ms", { ascending: false })
        .limit(limit),
    ),

  // Abertura: o servidor compara o fundo contado com o Fundo_Caixa_Proximo_Dia
  // do último fechamento da unidade e devolve a divergência (o Owner é
  // avisado por push/e-mail pelo trigger do turno — ver migration
  // 20260902000001).
  openShift: (body: { unitId: string; employeeId: string; openingCashCents: number }) =>
    callResilient<OpenShiftResult>("fa_open_shift", {
      p_unit_id: body.unitId,
      p_employee_id: body.employeeId,
      p_opening_cash_cents: body.openingCashCents,
    }),
  // Fechamento: além do declarado por forma de pagamento, manda a contagem
  // física da gaveta (Dinheiro_Total_Gaveta) e o Fundo_Caixa_Proximo_Dia. O
  // valor do envelope é calculado no servidor (contado − fundo) e precisa já
  // estar registrado como envelope (SANGRIA com número + foto) com esse valor.
  closeShift: (
    shiftId: string,
    body: {
      employeeId: string;
      declared: Record<string, number>;
      justifications?: Record<string, string>;
      countedCashCents?: number;
      nextDayFloatCents?: number;
      // Obrigatório de propósito: o campo ser opcional no tipo deixaria um
      // call site futuro fechar turno sem passagem e só descobrir em
      // produção, com o servidor recusando (PASSAGEM_TURNO_OBRIGATORIA).
      handover: { noChanges: boolean; conteudo: string };
    },
  ) =>
    callResilient<CloseShiftResult>("fa_close_shift", {
      p_shift_id: shiftId,
      p_employee_id: body.employeeId,
      p_declared: body.declared,
      p_justifications: body.justifications ?? {},
      p_counted_cash_cents: body.countedCashCents ?? null,
      p_next_day_float_cents: body.nextDayFloatCents ?? null,
      p_handover_no_changes: body.handover.noChanges,
      p_handover_conteudo: body.handover.conteudo || null,
    }),
  // Passagens de turno que este funcionário ainda não leu nesta unidade
  // (ver fa_kiosk_pending_handovers — últimos 7 dias, exclui as dele mesmo).
  pendingHandovers: (unitId: string, employeeId: string) =>
    unwrap<PendingHandover[]>(
      supabase().rpc("fa_kiosk_pending_handovers", { p_unit_id: unitId, p_employee_id: employeeId }),
    ),
  // Ciência de leitura. `leituraMs` é o tempo entre abrir o modal e
  // confirmar — é o que o Gerencial usa para distinguir leitura de clique.
  ackHandover: (handoverId: string, employeeId: string, shiftId: string | null, leituraMs: number | null) =>
    callResilient("fa_kiosk_ack_handover", {
      p_handover_id: handoverId,
      p_employee_id: employeeId,
      p_shift_id: shiftId,
      p_leitura_ms: leituraMs,
    }),
  // Histórico para a aba Gerencial > Passagem de Turno.
  handoverHistory: (unitId: string | null) => {
    let query = supabase()
      .from("fa_kiosk_shift_handovers")
      // String literal única: concatenar quebra a inferência do supabase-js.
      .select("id, unit_id, business_date, created_at_ms, no_changes, conteudo, closed_by_employee_id, fa_kiosk_shift_handover_acks(employee_id, acked_at_ms, leitura_ms)")
      .order("created_at_ms", { ascending: false })
      .limit(100);
    if (unitId) query = query.eq("unit_id", unitId);
    return unwrap<HandoverHistoryRow[]>(query);
  },
  // Número do envelope não é mais digitado pelo operador: sequência global
  // (independente da unidade) gerada pelo servidor, 2 dígitos, reiniciando
  // de "00" a cada 100 (ver migration fa_envelope_number_auto_sequencial).
  nextEnvelopeNumber: () => unwrap<string>(supabase().rpc("fa_next_envelope_number")),
  cashMovement: (shiftId: string, body: { employeeId: string; kind: string; amountCents: number; reason?: string; envelopeNumber?: string; photoUrl?: string; fundoCaixaCents?: number }) =>
    callResilient("fa_record_cash_movement", {
      p_shift_id: shiftId,
      p_kind: body.kind,
      p_amount_cents: body.amountCents,
      p_reason: body.reason ?? null,
      p_employee_id: body.employeeId,
      p_envelope_number: body.envelopeNumber ?? null,
      p_photo_url: body.photoUrl ?? null,
      p_fundo_caixa_cents: body.fundoCaixaCents ?? null,
    }),
  // Módulo FA — lançamento diário de locações/velocidade de atendimento
  // (CaixaScreen.tsx, card "Bonificação Diária & Locações"). Upsert por
  // unidade/funcionário/dia: reenviar no mesmo dia atualiza em vez de duplicar.
  saveDailyBonus: (body: { unitId: string; locacoesCount: number; vendas30m: number; vendas1h: number; vendas2h: number }) =>
    callResilient("fa_kiosk_save_daily_bonus", {
      p_unit_id: body.unitId,
      p_locacoes_count: body.locacoesCount,
      p_vendas_30m: body.vendas30m,
      p_vendas_1h: body.vendas1h,
      p_vendas_2h: body.vendas2h,
      p_now_ms: Date.now(),
    }),
  cashMovements: (shiftId: string) =>
    unwrap<CashMovement[]>(
      supabase()
        .from("fa_kiosk_cash_movements")
        .select("id, kind, amount_cents, reason, envelope_number, photo_url, fundo_caixa_cents, employee_id, at_ms")
        .eq("shift_id", shiftId)
        .order("at_ms", { ascending: true }),
    ),
  // Upload direto para o bucket público `envelope-fotos` (ver migration
  // fa_kiosk_envelope_photos_cash_status) — mesmo padrão de uploadAssetPhoto,
  // mas comprimida antes: foto de câmera sem redimensionar chegava a vários
  // MB por envelope e inflava o Storage sem necessidade (ver imageCompression.ts).
  uploadEnvelopePhoto: async (unitId: string, file: File): Promise<string> => {
    assertValidImageUpload(file);
    const prepared = await prepareUpload(file, "documento"); // comprovante: texto/números precisam ficar legíveis
    const path = `${unitId}/${Date.now()}.${prepared.ext}`;
    const { error } = await supabase().storage.from("envelope-fotos").upload(path, prepared.blob, {
      contentType: prepared.contentType,
      upsert: false,
    });
    if (error) throw new Error(error.message);
    const { data } = supabase().storage.from("envelope-fotos").getPublicUrl(path);
    return data.publicUrl;
  },
  // Histórico de abertura/fechamento de turno por unidade (ou todas, se
  // unitId for null) — usado pela aba gerencial "Abertura e Fechamento".
  unitShifts: (unitId: string | null) => {
    let query = supabase()
      .from("fa_kiosk_shifts")
      // String literal única de propósito: concatenação quebra a inferência de
      // tipos do select do supabase-js (vira GenericStringError[]).
      .select("id, unit_id, status, opening_cash_cents, opened_at_ms, closed_at_ms, opened_by_employee_id, closed_by_employee_id, close_justifications_json, expected_opening_cash_cents, opening_divergence_cents, counted_cash_cents, drawer_expected_cents, cash_break_cents, next_day_float_cents, envelope_cents")
      .order("opened_at_ms", { ascending: false })
      .limit(100);
    if (unitId) query = query.eq("unit_id", unitId);
    return unwrap<UnitShiftRow[]>(query);
  },
  // Sangrias com número de envelope registrado (com ou sem foto ainda),
  // mais recentes primeiro — usado pela aba gerencial "Fotos de Envelope".
  envelopeMovements: (unitId: string | null) => {
    let query = supabase()
      .from("fa_kiosk_cash_movements")
      .select("id, shift_id, amount_cents, reason, envelope_number, photo_url, fundo_caixa_cents, employee_id, at_ms, fa_kiosk_shifts!inner(unit_id)")
      .eq("kind", "SANGRIA")
      .not("envelope_number", "is", null)
      .order("at_ms", { ascending: false })
      .limit(200);
    if (unitId) query = query.eq("fa_kiosk_shifts.unit_id", unitId);
    return unwrap<EnvelopeMovement[]>(query);
  },
  // Saldo físico em caixa por unidade agora (ver RPC fa_units_cash_status) —
  // usado como linha secundária da aba gerencial "Saldo em Envelopes".
  unitsCashStatus: () => unwrap<UnitCashStatus[]>(supabase().rpc("fa_units_cash_status")),
  // Saldo em envelopes pendentes (ainda na loja) por unidade — aba gerencial
  // "Saldo em Envelopes" (ver RPC fa_units_envelope_balance).
  unitsEnvelopeBalance: () => unwrap<UnitEnvelopeBalance[]>(supabase().rpc("fa_units_envelope_balance")),
  // Cada envelope pendente individualmente (sem limite de linhas), para o
  // gestor escolher quais recolhe.
  pendingEnvelopes: () => unwrap<PendingEnvelope[]>(supabase().rpc("fa_pending_envelopes")),
  // Rotinas de notificação do Owner (Web Push) — abertura/acompanhamento
  // 17h-20h/fechamento de caixa, ver 20260818000001_fa_kiosk_owner_reports.
  ownerPushSubscribe: (endpoint: string, p256dh: string, auth: string) =>
    unwrap(supabase().rpc("fa_owner_push_subscribe", { p_endpoint: endpoint, p_p256dh: p256dh, p_auth: auth })),
  ownerPushUnsubscribe: (endpoint: string) =>
    unwrap(supabase().rpc("fa_owner_push_unsubscribe", { p_endpoint: endpoint })),
  ownerPushIsSubscribed: (endpoint: string) =>
    unwrap<boolean>(supabase().rpc("fa_owner_push_is_subscribed", { p_endpoint: endpoint })),
  // Candidaturas do Banco de Talentos, mais recentes primeiro — só quem tem
  // talentos.read enxerga (RLS de fa_kiosk_job_applications).
  jobApplications: () =>
    unwrap<JobApplication[]>(
      supabase()
        .from("fa_kiosk_job_applications")
        .select("id, full_name, email, phone, course, desired_area, preferred_unit, opportunity_type, resume_path, status, created_at_ms")
        .order("created_at_ms", { ascending: false }),
    ),
  updateJobApplicationStatus: async (id: string, status: JobApplication["status"]) => {
    const rpcRes = await supabase().rpc("fa_update_job_application_status", { p_id: id, p_status: status });
    if (!rpcRes.error) {
      return rpcRes.data;
    }
    const { data, error } = await supabase()
      .from("fa_kiosk_job_applications")
      .update({ status })
      .eq("id", id)
      .select("id, status");
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) {
      throw new Error("Não foi possível atualizar o status: verifique suas permissões no Banco de Talentos.");
    }
    return data[0];
  },
  // Bucket privado `curriculos` — link assinado de 60s, gerado sob demanda
  // no clique (nunca guardado), já que getPublicUrl não funciona em bucket
  // privado e a policy de select do Storage já exige talentos.read.
  jobApplicationResumeUrl: async (resumePath: string): Promise<string> => {
    const { data, error } = await supabase().storage.from("curriculos").createSignedUrl(resumePath, 60);
    if (error) throw new Error(error.message);
    return data.signedUrl;
  },
  // Marca todos os envelopes pendentes da unidade como recolhidos pelo gestor.
  collectEnvelopes: (unitId: string, employeeId: string) =>
    callResilient<{ ok: boolean; collected_count: number; collected_cents: number }>("fa_collect_envelopes", {
      p_unit_id: unitId,
      p_employee_id: employeeId,
    }),
  // Recolhe só os envelopes escolhidos (de uma unidade).
  collectSelectedEnvelopes: (unitId: string, employeeId: string, movementIds: string[]) =>
    callResilient<{ ok: boolean; requested_count: number; collected_count: number; collected_cents: number }>(
      "fa_collect_selected_envelopes",
      { p_unit_id: unitId, p_employee_id: employeeId, p_movement_ids: movementIds },
    ),
  revenueByMethod: async (shiftId: string) => {
    const rows = await unwrap<{ method: string; amount_cents: number }[]>(
      supabase().from("fa_kiosk_payments").select("method, amount_cents, fa_kiosk_orders!inner(shift_id)").eq("fa_kiosk_orders.shift_id", shiftId),
    );
    const totals = new Map<string, number>();
    for (const row of rows) totals.set(row.method, (totals.get(row.method) ?? 0) + row.amount_cents);
    return [...totals.entries()].map(([method, total_cents]) => ({ method, total_cents }));
  },
  // Extrato de cada venda do turno (a pedido do dono, para auditoria): uma
  // linha por pedido pago — código único, criança(s)/responsável para
  // check-outs, produtos para vendas de PDV, forma de pagamento, desconto
  // (fa_kiosk_sessions.coupon_discount_cents) e valor.
  shiftSales: async (shiftId: string): Promise<ShiftSale[]> => {
    // fa_kiosk_orders é a tabela-stub original (ver migration 05): tem
    // `created_at` (timestamptz), não `created_at_ms` como as tabelas
    // criadas do zero nesta fase.
    const orders = await unwrap<Record<string, unknown>[]>(
      supabase()
        .from("fa_kiosk_orders")
        .select("id, order_code, kind, total_cents, created_at")
        .eq("shift_id", shiftId)
        .eq("status", "PAGA")
        .order("created_at", { ascending: false }),
    );
    if (orders.length === 0) return [];
    const orderIds = orders.map((o) => o.id as string);

    const [payments, items] = await Promise.all([
      fetchInBatches(orderIds, 100, (batch) =>
        unwrap<Record<string, unknown>[]>(supabase().from("fa_kiosk_payments").select("order_id, method, amount_cents").in("order_id", batch)),
      ),
      fetchInBatches(orderIds, 100, (batch) =>
        unwrap<Record<string, unknown>[]>(
          supabase().from("fa_kiosk_order_items").select("order_id, session_id, description, quantity").in("order_id", batch),
        ),
      ),
    ]);

    const sessionIds = [...new Set(items.map((i) => i.session_id as string | null).filter((id): id is string => Boolean(id)))];
    const sessions = await fetchInBatches(sessionIds, 100, (batch) =>
      unwrap<Record<string, unknown>[]>(
        supabase().from("fa_kiosk_sessions").select("id, child_name_snapshot, guardian_id, coupon_discount_cents").in("id", batch),
      ),
    );
    const guardianIds = [...new Set(sessions.map((s) => s.guardian_id as string))];
    const guardians = await fetchInBatches(guardianIds, 100, (batch) =>
      unwrap<Record<string, unknown>[]>(supabase().from("fa_kiosk_guardians").select("id, full_name, phone_e164, cpf").in("id", batch)),
    );

    const sessionById = new Map(sessions.map((s) => [s.id as string, s]));
    const guardianById = new Map(guardians.map((g) => [g.id as string, g]));
    const paymentByOrder = new Map(payments.map((p) => [p.order_id as string, p]));
    const itemsByOrder = new Map<string, Record<string, unknown>[]>();
    for (const item of items) {
      const list = itemsByOrder.get(item.order_id as string) ?? [];
      list.push(item);
      itemsByOrder.set(item.order_id as string, list);
    }

    return orders.map((order) => {
      const orderId = order.id as string;
      const kind = order.kind as "SESSAO" | "PDV";
      const payment = paymentByOrder.get(orderId);
      const orderItems = itemsByOrder.get(orderId) ?? [];

      if (kind === "SESSAO") {
        const uniqueSessionIds = [...new Set(orderItems.map((i) => i.session_id as string | null).filter((id): id is string => Boolean(id)))];
        const sessionsForOrder = uniqueSessionIds.map((id) => sessionById.get(id)).filter((s): s is Record<string, unknown> => Boolean(s));
        const childNames = sessionsForOrder.map((s) => s.child_name_snapshot as string).join(", ");
        const firstSession = sessionsForOrder[0];
        const firstGuardian = firstSession ? guardianById.get(firstSession.guardian_id as string) : undefined;
        const discountCents = sessionsForOrder.reduce((sum, s) => sum + ((s.coupon_discount_cents as number) ?? 0), 0);
        return {
          orderId,
          orderCode: (order.order_code as string) ?? null,
          kind,
          createdAtMs: new Date(order.created_at as string).getTime(),
          method: (payment?.method as string) ?? "—",
          amountCents: order.total_cents as number,
          discountCents,
          childNames: childNames || "—",
          guardianId: (firstGuardian?.id as string) ?? (firstSession?.guardian_id as string) ?? null,
          guardianName: (firstGuardian?.full_name as string) ?? null,
          guardianPhone: (firstGuardian?.phone_e164 as string | undefined) ?? null,
          guardianCpf: (firstGuardian?.cpf as string | undefined) ?? null,
          productsSummary: null,
        };
      }

      const productsSummary = orderItems.map((i) => `${i.quantity}× ${i.description as string}`).join(", ");
      return {
        orderId,
        orderCode: (order.order_code as string) ?? null,
        kind,
        createdAtMs: order.created_at_ms as number,
        method: (payment?.method as string) ?? "—",
        amountCents: order.total_cents as number,
        discountCents: 0,
        childNames: "—",
        guardianName: null,
        productsSummary: productsSummary || "—",
      };
    });
  },

  /** Linha do tempo de uma sessão (pausas, retomadas, troca de plano, notificações) — botão "Sessão" no Painel. */
  sessionEvents: async (sessionId: string) => {
    const rows = await unwrap<Record<string, unknown>[]>(
      supabase()
        .from("fa_kiosk_session_events")
        .select("id, kind, at_ms, payload_json, fa_kiosk_employees(full_name)")
        .eq("session_id", sessionId)
        .order("at_ms", { ascending: true }),
    );
    return rows.map((r) => ({
      id: r.id as string,
      kind: r.kind as string,
      at_ms: r.at_ms as number,
      employee_name: (r.fa_kiosk_employees as unknown as { full_name: string } | null)?.full_name ?? null,
      payload: (r.payload_json as Record<string, unknown> | null) ?? null,
    })) as SessionEvent[];
  },
  /** Ocorrências (atestado/falta) de uma unidade — Gerencial > Ocorrências, exige `ocorrencias.read`. */
  ocorrencias: async (unitId: string) => {
    const rows = await unwrap<Record<string, unknown>[]>(
      supabase()
        .from("fa_kiosk_ocorrencias")
        .select("id, employee_id, unit_id, tipo, days_away, document_path, notes, created_at_ms, fa_kiosk_employees!fa_kiosk_ocorrencias_employee_id_fkey(full_name)")
        .eq("unit_id", unitId)
        .order("created_at_ms", { ascending: false }),
    );
    return rows.map((r) => ({
      id: r.id as string,
      employee_id: r.employee_id as string,
      unit_id: r.unit_id as string,
      tipo: r.tipo as "ATESTADO" | "FALTA",
      days_away: r.days_away as number,
      document_path: r.document_path as string | null,
      notes: r.notes as string | null,
      created_at_ms: r.created_at_ms as number,
      fa_kiosk_employees: (r.fa_kiosk_employees as unknown as { full_name: string } | null) ?? null,
    }));
  },
  /** Lança uma ocorrência (atestado/falta) — RPC fa_kiosk_register_ocorrencia, exige `ocorrencias.write`. */
  registerOcorrencia: (body: {
    employeeId: string;
    unitId: string;
    tipo: "ATESTADO" | "FALTA";
    daysAway: number;
    documentPath: string | null;
    notes: string | null;
  }) =>
    callResilient<{ id: string; atMs: number }>("fa_kiosk_register_ocorrencia", {
      p_employee_id: body.employeeId,
      p_unit_id: body.unitId,
      p_tipo: body.tipo,
      p_days_away: body.daysAway,
      p_document_path: body.documentPath,
      p_notes: body.notes,
    }),
  /** Upload do anexo (atestado etc.) — bucket privado `ocorrencia-documentos`, path prefixado por employeeId. */
  uploadOcorrenciaDocumento: async (employeeId: string, file: File): Promise<string> => {
    assertValidDocumentUpload(file);
    const prepared = await prepareUpload(file, "documento");
    const path = `${employeeId}/${Date.now()}-${uploadFileName(file.name, prepared.ext, "documento")}`;
    const { error } = await supabase().storage.from("ocorrencia-documentos").upload(path, prepared.blob, {
      contentType: prepared.contentType,
      upsert: false,
    });
    if (error) throw new Error(error.message);
    return path;
  },

  bonusRules: async (unitId: string): Promise<BonusRule[]> => {
    try {
      const rows = await unwrap<Record<string, unknown>[]>(
        supabase().from("fa_kiosk_bonus_rules").select("*").eq("unit_id", unitId).eq("active", true),
      );
      const rules = rows.map(bonusRuleFromRow);
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(`fa_bonus_rules_${unitId}`, JSON.stringify(rules));
      }
      return rules;
    } catch (err) {
      console.warn("Falha ao buscar bonusRules da API, buscando do localStorage:", err);
      if (typeof localStorage !== "undefined") {
        const cached = localStorage.getItem(`fa_bonus_rules_${unitId}`);
        if (cached) {
          try {
            return JSON.parse(cached) as BonusRule[];
          } catch { /* melhor esforço: falha ignorada */ }
        }
      }
      return [];
    }
  },
  /** Todas as regras de bonificação de todas as unidades (ativas e inativas) — Gerencial. */
  bonusRulesAllUnits: async (): Promise<BonusRule[]> => {
    try {
      const rows = await unwrap<Record<string, unknown>[]>(supabase().from("fa_kiosk_bonus_rules").select("*"));
      const rules = rows.map(bonusRuleFromRow);
      if (typeof localStorage !== "undefined") {
        localStorage.setItem("fa_bonus_rules_all", JSON.stringify(rules));
      }
      return rules;
    } catch (err) {
      console.warn("Falha ao buscar bonusRulesAllUnits da API, buscando do localStorage:", err);
      if (typeof localStorage !== "undefined") {
        const cached = localStorage.getItem("fa_bonus_rules_all");
        if (cached) {
          try {
            return JSON.parse(cached) as BonusRule[];
          } catch { /* melhor esforço: falha ignorada */ }
        }
      }
      return [];
    }
  },

  /**
   * Aniversariantes do mês, só desta unidade — uma criança só aparece aqui
   * se já teve check-in nesta unidade (fa_kiosk_children não tem unit_id
   * próprio). Sem esse filtro, uma unidade veria os aniversariantes de
   * todas as outras.
   */
  birthdaysByUnit: (unitId: string, month: number) =>
    unwrap<Birthday[]>(supabase().rpc("fa_kiosk_birthdays_by_unit", { p_unit_id: unitId, p_month: month })).then(
      (rows) => rows.sort((a, b) => a.day_of_month - b.day_of_month),
    ),
  /** Pool de 1000 mensagens de felicitação para sortear uma por criança. */
  birthdayMessages: () =>
    unwrap<{ id: number; message: string }[]>(supabase().from("fa_kiosk_birthday_messages").select("id, message")),
  /**
   * Registra que a felicitação já foi enviada este ano, nesta unidade — o
   * card correspondente some da lista (fa_kiosk_birthdays_by_unit passa a
   * excluí-lo) e só volta a aparecer no aniversário do ano seguinte.
   */
  markBirthdaySent: (unitId: string, childId: string, employeeId: string | null) =>
    unwrap<null>(
      supabase().rpc("fa_kiosk_mark_birthday_sent", { p_unit_id: unitId, p_child_id: childId, p_employee_id: employeeId }),
    ),
  createBonusRule: (body: { unitId: string; description: string; rewardValueCents: number }) =>
    unwrap<{ id: string }>(
      supabase()
        .from("fa_kiosk_bonus_rules")
        .insert({ unit_id: body.unitId, description: body.description, reward_value_cents: body.rewardValueCents })
        .select("id")
        .single(),
    ),
  setBonusRuleActive: (id: string, active: boolean) => unwrap(supabase().from("fa_kiosk_bonus_rules").update({ active }).eq("id", id)),
  updateBonusRule: (id: string, body: { description: string; rewardValueCents: number }) =>
    unwrap(supabase().from("fa_kiosk_bonus_rules").update({ description: body.description, reward_value_cents: body.rewardValueCents }).eq("id", id)),
  unitSetting: async (unitId: string, key: UnitSettingKey) => {
    try {
      const row = await unwrap<{ value: string } | null>(
        supabase().from("fa_kiosk_app_settings").select("value").eq("unit_id", unitId).eq("key", key).maybeSingle(),
      );
      if (row?.value) return { value: row.value };
    } catch (err) {
      console.warn("Falha ao ler fa_kiosk_app_settings do Supabase, buscando no localStorage:", err);
    }
    const localVal = typeof localStorage !== "undefined" ? localStorage.getItem(`fa_setting_${unitId}_${key}`) : null;
    return { value: localVal };
  },
  setUnitSetting: async (
    unitId: string,
    key: UnitSettingKey,
    value: string,
  ) => {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(`fa_setting_${unitId}_${key}`, value);
    }
    try {
      await unwrap(
        supabase()
          .from("fa_kiosk_app_settings")
          .upsert({ unit_id: unitId, key, value, updated_at_ms: Date.now() }, { onConflict: "unit_id,key" }),
      );
    } catch (err) {
      console.warn("Supabase RLS impediu gravação remota em fa_kiosk_app_settings (salvo localmente no quiosque):", err);
    }
    // Amarração implícita do terminal só como BOOTSTRAP de instalação
    // nova. Antes ela gravava sempre, com a unidade SELECIONADA na tela —
    // configurar a impressora da outra unidade a partir deste computador
    // reamarrava a máquina para lá, em silêncio.
    if (key === "printer_receipt" || key === "printer_wristband") {
      try {
        const current = await getTerminalUnit();
        if (current.available && !current.unitId) await setTerminalUnit(unitId);
      } catch (err) {
        console.warn("Não foi possível vincular automaticamente este computador à unidade:", err);
      }
    }
  },

  /** Bobina ATIVA da unidade, ou `null` se nenhum cupom foi impresso ainda (nenhuma bobina criada). */
  activePaperRoll: async (unitId: string): Promise<PaperRoll | null> => {
    const row = await unwrap<Record<string, unknown> | null>(
      supabase()
        .from("fa_kiosk_paper_rolls")
        .select("id, unit_id, roll_length_mm, consumed_mm, status, installed_at_ms, finished_at_ms")
        .eq("unit_id", unitId)
        .eq("status", "ACTIVE")
        .maybeSingle(),
    );
    return row ? mapPaperRoll(row as Parameters<typeof mapPaperRoll>[0]) : null;
  },

  /** Bobinas já trocadas desta unidade, mais recente primeiro — pra "Ver histórico de trocas". */
  paperRollHistory: async (unitId: string, limit = 10): Promise<PaperRoll[]> => {
    const rows = await unwrap<Array<Record<string, unknown>>>(
      supabase()
        .from("fa_kiosk_paper_rolls")
        .select("id, unit_id, roll_length_mm, consumed_mm, status, installed_at_ms, finished_at_ms")
        .eq("unit_id", unitId)
        .eq("status", "FINISHED")
        .order("finished_at_ms", { ascending: false })
        .limit(limit),
    );
    return rows.map((r) => mapPaperRoll(r as Parameters<typeof mapPaperRoll>[0]));
  },

  /**
   * Impressões de cupom (RECEIPT) da unidade desde `sinceMs`, com o
   * comprimento estimado de cada uma — matéria-prima pra `computePaperRollForecast`
   * (`@facaamigos/domain`) decidir ritmo de consumo e previsão de término.
   * Não agrega nada aqui de propósito: quem decide a janela/agregação é a
   * função de projeção, num lugar só.
   */
  paperConsumptionSince: async (unitId: string, sinceMs: number): Promise<PaperConsumptionSample[]> => {
    const rows = await unwrap<Array<{ printed_at_ms: number; paper_length_mm: number | null }>>(
      supabase()
        .from("fa_kiosk_print_jobs")
        .select("printed_at_ms, paper_length_mm")
        .eq("unit_id", unitId)
        .eq("kind", "RECEIPT")
        .eq("status", "PRINTED")
        .gte("printed_at_ms", sinceMs)
        .not("paper_length_mm", "is", null),
    );
    return rows.map((r) => ({ printedAtMs: r.printed_at_ms, lengthMm: r.paper_length_mm ?? 0 }));
  },

  /** Fecha a bobina ativa (se houver) e abre uma nova — botão "Registrar troca de bobina". */
  registerRollChange: (unitId: string, rollLengthMm = 30000): Promise<string> =>
    unwrap<string>(supabase().rpc("fa_kiosk_register_roll_change", { p_unit_id: unitId, p_roll_length_mm: rollLengthMm })),

  // ── CRM de WhatsApp (Gerencial > CRM WhatsApp) ──
  crmContacts: () =>
    unwrap<CrmContact[]>(
      supabase()
        .from("fa_crm_contacts")
        .select("*, fa_crm_channels(label)")
        .order("last_message_ms", { ascending: false, nullsFirst: false })
        .limit(500),
    ),
  crmMessages: (contactId: string) =>
    unwrap<CrmMessage[]>(
      supabase().from("fa_crm_messages").select("*").eq("contact_id", contactId).order("created_at_ms", { ascending: true }).limit(500),
    ),
  crmTemplates: () =>
    unwrap<CrmTemplate[]>(supabase().from("fa_crm_templates").select("id, name, preview, variable_count").eq("active", true).eq("purpose", "GERAL").order("name")),
  crmUpdateContact: (id: string, patch: Partial<Pick<CrmContact, "name" | "stage" | "tags" | "notes">>) =>
    unwrap<null>(supabase().from("fa_crm_contacts").update(patch).eq("id", id)),
  crmSendNps: (contactIds: string[]) =>
    unwrap<{ ok: boolean; sent: number; skippedOptOut: number; skippedRecent: number; failed: number }>(
      supabase().functions.invoke("crm-nps-send", { body: { contactIds } }),
    ),
  crmNpsFeed: (limit = 20) =>
    unwrap<
      {
        id: string;
        brand: string;
        score: number;
        feedback: string | null;
        scored_at_ms: number;
        score_team: number | null;
        score_space: number | null;
        unit_name: string | null;
      }[]
    >(
      supabase().rpc("fa_crm_nps_feed", { p_limit: limit }),
    ),
  crmNpsDashboard: (p: { fromMs: number; toMs: number; unitId?: string | null }) =>
    unwrap<NpsDashboardData>(
      supabase().rpc("fa_crm_nps_dashboard", { p_from_ms: p.fromMs, p_to_ms: p.toMs, p_unit_id: p.unitId ?? null }),
    ),
  crmNpsComments: (p: {
    fromMs: number;
    toMs: number;
    unitId?: string | null;
    band?: "PROMOTER" | "PASSIVE" | "DETRACTOR" | null;
    search?: string;
    onlyWithComment?: boolean;
    limit?: number;
    offset?: number;
  }) =>
    unwrap<NpsCommentRow[]>(
      supabase().rpc("fa_crm_nps_comments", {
        p_from_ms: p.fromMs,
        p_to_ms: p.toMs,
        p_unit_id: p.unitId ?? null,
        p_band: p.band ?? null,
        p_search: p.search?.trim() || null,
        p_only_with_comment: p.onlyWithComment ?? true,
        p_limit: p.limit ?? 50,
        p_offset: p.offset ?? 0,
      }),
    ),
  crmMarkRead: (contactId: string) => unwrap<null>(supabase().rpc("fa_crm_mark_read", { p_contact_id: contactId })),
  crmSend: (body: { contactId: string; body?: string; templateId?: string; variables?: Record<string, string> }) =>
    unwrap<{ ok: boolean; sid: string }>(supabase().functions.invoke("crm-whatsapp-send", { body })),

  /**
   * Meta diária de faturamento por dia da semana (1=segunda … 7=domingo),
   * fa_kiosk_unit_daily_goals — sucessora do `daily_goal_cents` único em
   * fa_kiosk_app_settings (ainda lido como fallback pelo servidor, ver
   * migration `20260904000001_fa_kiosk_unit_daily_goals`). Sempre retorna
   * os 7 dias (0 para o que não tiver linha configurada), pra tela de
   * edição não precisar tratar buraco no meio da semana.
   */
  dailyGoals: async (unitId: string): Promise<Record<number, number>> => {
    const rows = await unwrap<{ weekday: number; goal_cents: number }[]>(
      supabase().from("fa_kiosk_unit_daily_goals").select("weekday, goal_cents").eq("unit_id", unitId),
    );
    const byWeekday: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 };
    for (const r of rows) byWeekday[r.weekday] = r.goal_cents;
    return byWeekday;
  },
  setDailyGoal: (unitId: string, weekday: number, goalCents: number) =>
    unwrap(
      supabase()
        .from("fa_kiosk_unit_daily_goals")
        .upsert({ unit_id: unitId, weekday, goal_cents: goalCents, updated_at_ms: Date.now() }, { onConflict: "unit_id,weekday" }),
    ),
  /** Meta de hoje (já resolvida por dia da semana + fallback), pro termômetro do Painel. */
  todayGoal: async (unitId: string, cutoffHour: number) =>
    unwrap<number>(
      supabase().rpc("fa_kiosk_today_goal_cents", { p_unit_id: unitId, p_business_date: businessDateFor(Date.now(), cutoffHour) }),
    ),
  /**
   * Enfileira um pedido de impressão para o print bridge (processo local
   * em cada terminal, ver apps/kiosk) em vez de abrir o diálogo nativo do
   * navegador — só assim dá pra imprimir sem clique nenhum do operador,
   * direto na impressora escolhida em Configurações > Impressoras.
   */
  /**
   * Traduz o que a câmera leu (ou o que o operador digitou) numa sessão.
   *
   * Nunca lança para código errado: na porta de saída, apontar a câmera para
   * a etiqueta errada é rotina, não falha de sistema. O motivo vem em
   * `reason` para a tela reagir sem tratar tudo como erro vermelho.
   */
  resolveAccessCode: (unitId: string, code: string, employeeId?: string) =>
    unwrap<ResolvedAccessCode>(
      supabase().rpc("fa_resolve_access_code", {
        p_unit_id: unitId,
        p_code: code,
        p_employee_id: employeeId ?? null,
      }),
    ),
  /** Responsáveis autorizados a retirar a criança desta sessão, para conferência do documento. */
  saidaResponsaveis: async (sessionId: string) =>
    (await unwrap<AuthorizedGuardian[] | null>(
      supabase().rpc("fa_saida_responsaveis", { p_session_id: sessionId }),
    )) ?? [],
  /** Lista a base de clientes (responsáveis e crianças) consolidada no Gerencial. */
  gerencialClientes: async (search?: string, unitId?: string) =>
    (await unwrap<GerencialCliente[] | null>(
      supabase().rpc("fa_gerencial_clientes", {
        p_search: search ?? null,
        p_unit_id: unitId ?? null,
      }),
    )) ?? [],
  /**
   * Reinicia o contador de visitas exibido no Gerencial > Clientes sem
   * apagar o histórico real de check-ins: fa_gerencial_clientes passa a
   * contar só sessões a partir de agora (ver fa_kiosk_visit_counter_reset).
   */
  resetVisitCounter: () => unwrap(supabase().rpc("fa_config_reset_visit_counter")),
  /** Edita os dados do responsável no modal de detalhes do Gerencial > Clientes (exige `clientes.write`). */
  updateGerencialGuardian: (body: { guardianId: string; fullName: string; phoneE164: string; cpf?: string | null; email?: string | null }) =>
    unwrap(
      supabase().rpc("fa_gerencial_update_guardian", {
        p_guardian_id: body.guardianId,
        p_full_name: body.fullName,
        p_phone_e164: body.phoneE164,
        p_cpf: body.cpf ?? null,
        p_email: body.email ?? null,
      }),
    ),
  /** Edita os dados de uma criança vinculada no mesmo modal (exige `clientes.write`). */
  updateGerencialChild: (body: { childId: string; fullName: string; birthDate: string }) =>
    unwrap(
      supabase().rpc("fa_gerencial_update_child", {
        p_child_id: body.childId,
        p_full_name: body.fullName,
        p_birth_date: body.birthDate,
      }),
    ),
  /** Lista o audit log (`fa_kiosk_audit_log`) para o Gerencial > Auditoria — quem fez o quê, quando. */
  auditLog: async (filters: {
    search?: string;
    employeeId?: string;
    severity?: string;
    startMs?: number;
    endMs?: number;
  }) =>
    (await unwrap<AuditLogEntry[] | null>(
      supabase().rpc("fa_gerencial_audit_log", {
        p_search: filters.search ?? null,
        p_employee_id: filters.employeeId ?? null,
        p_severity: filters.severity ?? null,
        p_start_ms: filters.startMs ?? null,
        p_end_ms: filters.endMs ?? null,
        // pede o teto da RPC (500) em vez do default (200): a tela detecta o corte
        // comparando entries.length com esse mesmo teto e avisa o operador.
        p_limit: 500,
      }),
    )) ?? [],
  /** Registra a liberação de contingência (recibo perdido / etiqueta danificada) antes de cobrar. */
  saidaManualAuthorize: (body: {
    sessionId: string;
    guardianId: string | null;
    documentKind: string;
    documentNote?: string;
    reason?: string;
    employeeId: string;
  }) =>
    unwrap<{ authorizedPickup: boolean; guardianName: string | null }>(
      supabase().rpc("fa_saida_manual_authorize", {
        p_session_id: body.sessionId,
        p_guardian_id: body.guardianId,
        p_document_kind: body.documentKind,
        p_document_note: body.documentNote ?? null,
        p_reason: body.reason ?? null,
        p_employee_id: body.employeeId,
      }),
    ),
  /** Reimprime pulseira + recibo de guarda da mesma sessão, sem gerar código novo. */
  reimprimirEntrada: (sessionId: string, employeeId?: string) =>
    localDeviceId().then((deviceId) =>
      unwrap<{ accessCode: string }>(
        supabase().rpc("fa_reimprimir_entrada", {
          p_session_id: sessionId,
          p_employee_id: employeeId ?? null,
          p_device_id: deviceId,
        }),
      ),
    ),
  queuePrintJob: (unitId: string, kind: "WRISTBAND" | "RECEIPT", payload: unknown) =>
    // origin_device_id dá preferência de impressão ao computador que
    // pediu; passada a carência, qualquer terminal daquela unidade
    // assume — importante porque venda feita em tablet/PWA chega sem
    // origem e, com regra estrita, nunca imprimiria em lugar nenhum.
    localDeviceId().then((deviceId) =>
      unwrap(
        supabase()
          .from("fa_kiosk_print_jobs")
          .insert({
            unit_id: unitId.trim().toLowerCase(),
            kind,
            payload_json: payload,
            status: "PENDING",
            created_at_ms: Date.now(),
            origin_device_id: deviceId,
          }),
      ),
    ),
  todayRevenue: async (unitId: string, cutoffHour: number) => {
    const totalCents = await unwrap<number>(
      supabase().rpc("fa_kiosk_today_revenue", { p_unit_id: unitId, p_business_date: businessDateFor(Date.now(), cutoffHour) }),
    );
    return { totalCents };
  },
  /**
   * Sessões abertas hoje (dia operacional) até agora — inclui as que ainda estão
   * dentro e as já finalizadas. É a "quantidade de sessões do dia" do Gerencial.
   */
  todaySessionsCount: async (unitId: string, cutoffHour: number): Promise<number> => {
    const { count, error } = await supabase()
      .from("fa_kiosk_sessions")
      .select("id", { count: "exact", head: true })
      .eq("unit_id", unitId)
      .eq("business_date", businessDateFor(Date.now(), cutoffHour));
    if (error) throw error;
    return count ?? 0;
  },
  /**
   * Parte do faturamento do dia que é aluguel de pelúcia. O placar de
   * bonificação desconta isto, igual à apuração oficial.
   */
  todayRentalCents: async (unitId: string, cutoffHour: number) => {
    const totalCents = await unwrap<number>(
      supabase().rpc("fa_kiosk_today_rental_cents", { p_unit_id: unitId, p_business_date: businessDateFor(Date.now(), cutoffHour) }),
    );
    return { totalCents };
  },
  /** Quantidade de sessões vendidas por tipo de plano no intervalo de dias operacionais. */
  reportPlansSold: async (unitId: string | null, from: string, to: string) => {
    let query = supabase()
      .from("fa_kiosk_sessions")
      .select("plan_id, fa_kiosk_plans(name, color, activity)")
      .gte("business_date", from)
      .lte("business_date", to);
    if (unitId) query = query.eq("unit_id", unitId);
    const rows = await unwrap<Record<string, unknown>[]>(query);
    const map = new Map<string, { plan_id: string; plan_name: string; plan_color: string; activity: PlanSold["activity"]; sessions_count: number }>();
    for (const r of rows) {
      const planId = r.plan_id as string;
      const plan = r.fa_kiosk_plans as unknown as { name: string; color: string; activity: PlanSold["activity"] } | null;
      const cur = map.get(planId) ?? {
        plan_id: planId,
        plan_name: plan?.name ?? "Plano",
        plan_color: plan?.color ?? "#2ECFB5",
        activity: plan?.activity ?? "PLAYGROUND",
        sessions_count: 0,
      };
      cur.sessions_count += 1;
      map.set(planId, cur);
    }
    return [...map.values()] as PlanSold[];
  },
  notifySession: async (sessionId: string, body: { channel: "WHATSAPP" | "SMS"; message: string }) => {
    await unwrap(
      supabase().rpc("fa_kiosk_log_session_event", {
        p_session_id: sessionId,
        p_kind: body.channel === "WHATSAPP" ? "NOTIFICACAO_WHATSAPP" : "NOTIFICACAO_SMS_SIMULADA",
        p_employee_id: null,
        p_payload: { message: body.message },
      }),
    );
    return { ok: true, simulated: body.channel === "SMS" };
  },
  /**
   * `planId` prefixado com `PKG:` (mesmo truque de EntradaScreen/AcessoRapidoScreen)
   * indica que o operador escolheu um Pacote em vez de um Plano — o RPC troca a
   * sessão para o pacote (saldo novo em fa_kiosk_guardian_packages) em vez de plan_id.
   */
  changeSessionPlan: (sessionId: string, planId: string) => {
    const PACKAGE_PREFIX = "PKG:";
    const usingPackage = planId.startsWith(PACKAGE_PREFIX);
    return unwrap(
      supabase().rpc("fa_kiosk_change_session_plan", {
        p_session_id: sessionId,
        p_plan_id: usingPackage ? null : planId,
        p_package_id: usingPackage ? planId.slice(PACKAGE_PREFIX.length) : null,
      }),
    );
  },
  pauseSession: (sessionId: string, reason: string) =>
    unwrap(supabase().rpc("fa_kiosk_pause_session", { p_session_id: sessionId, p_reason: reason })),
  resumeSession: (sessionId: string) =>
    unwrap(supabase().rpc("fa_kiosk_resume_session", { p_session_id: sessionId })),
  /** Cancela uma sessão ativa sem checkout (aceite por engano, duplicidade). Exige a capacidade `sessao.cancel` — reforçada no servidor pelo trigger fa_kiosk_guard_session_exception. */
  cancelSession: (sessionId: string, reason?: string) =>
    unwrap(supabase().rpc("fa_kiosk_cancel_session", { p_session_id: sessionId, p_reason: reason ?? null })),

  coupons: (unitId: string) =>
    unwrap<Record<string, unknown>[]>(supabase().from("fa_kiosk_coupons").select("*").eq("unit_id", unitId)).then((rows) =>
      rows.map(couponFromRow),
    ),
  /**
   * Confere um cupom do Wi-Fi (ESPERA-XXXX) na unidade. Eles não aparecem em `coupons()` (um por família
   * encheria a lista e exporia nomes); a operadora digita o código e o servidor responde de quem é e se vale.
   */
  wifiCouponLookup: async (unitId: string, code: string): Promise<WifiCouponLookup> => {
    const r = await unwrap<Record<string, unknown>>(
      supabase().rpc("fa_kiosk_wifi_coupon_lookup", { p_unit_id: unitId, p_code: code }),
    );
    const found = r.found === true;
    return {
      found,
      status: (r.status as WifiCouponStatus) ?? "NAO_ENCONTRADO",
      guardianName: (r.guardianName as string | null | undefined) ?? null,
      coupon: found
        ? couponFromRow({
            id: r.id,
            code: r.code,
            kind: r.kind,
            value: r.value,
            max_uses: r.maxUses,
            used_count: r.usedCount,
            active: r.active,
            description: r.description,
            expires_at_ms: r.expiresAtMs,
            unit_id: unitId,
          })
        : null,
    };
  },
  /** Todos os cupons de todas as unidades — Gerencial. */
  couponsAllUnits: () =>
    unwrap<Record<string, unknown>[]>(supabase().from("fa_kiosk_coupons").select("*")).then((rows) => rows.map(couponFromRow)),
  createCoupon: (body: { unitId: string; code: string; kind: Coupon["kind"]; value: number; description?: string; allowedPlanId?: string | null } & CouponScheduleInput) =>
    unwrap<{ id: string }>(
      supabase()
        .from("fa_kiosk_coupons")
        .insert({
          unit_id: body.unitId,
          code: body.code,
          kind: body.kind,
          value: body.value,
          description: body.description ?? null,
          allowed_plan_id: body.allowedPlanId ?? null,
          schedule_days: body.scheduleDays?.length ? body.scheduleDays : null,
          schedule_start: body.scheduleStart || null,
          schedule_end: body.scheduleEnd || null,
        })
        .select("id")
        .single(),
    ),
  setCouponActive: (id: string, active: boolean) => unwrap(supabase().from("fa_kiosk_coupons").update({ active }).eq("id", id)),
  updateCoupon: (id: string, body: { code: string; kind: Coupon["kind"]; value: number; description?: string; allowedPlanId?: string | null } & CouponScheduleInput) =>
    unwrap(
      supabase()
        .from("fa_kiosk_coupons")
        .update({
          code: body.code,
          kind: body.kind,
          value: body.value,
          description: body.description ?? null,
          allowed_plan_id: body.allowedPlanId ?? null,
          schedule_days: body.scheduleDays?.length ? body.scheduleDays : null,
          schedule_start: body.scheduleStart || null,
          schedule_end: body.scheduleEnd || null,
        })
        .eq("id", id),
    ),
  loyaltyRules: (unitId: string) =>
    unwrap<Record<string, unknown>[]>(supabase().from("fa_kiosk_loyalty_rules").select("*").eq("unit_id", unitId)).then((rows) =>
      rows.map(loyaltyRuleFromRow),
    ),
  /** Todas as regras de fidelidade de todas as unidades — Gerencial. */
  loyaltyRulesAllUnits: () =>
    unwrap<Record<string, unknown>[]>(supabase().from("fa_kiosk_loyalty_rules").select("*")).then((rows) =>
      rows.map(loyaltyRuleFromRow),
    ),
  createLoyaltyRule: (body: {
    unitId: string;
    activity: LoyaltyRule["activity"];
    triggerVisits: number;
    rewardKind: LoyaltyRule["rewardKind"];
    rewardValue: number;
  }) =>
    unwrap<{ id: string }>(
      supabase()
        .from("fa_kiosk_loyalty_rules")
        .insert({
          unit_id: body.unitId,
          activity: body.activity,
          trigger_visits: body.triggerVisits,
          reward_kind: body.rewardKind,
          reward_value: body.rewardValue,
        })
        .select("id")
        .single(),
    ),
  createPlan: (body: {
    unitId: string;
    activity: Plan["activity"];
    name: string;
    valueCents: number;
    durationValue: number;
    durationUnit: Plan["durationUnit"];
    overageCentsPerMinute: number;
    color: string;
  }) =>
    unwrap<{ id: string }>(
      supabase()
        .from("fa_kiosk_plans")
        .insert({
          unit_id: body.unitId,
          activity: body.activity,
          name: body.name,
          value_cents: body.valueCents,
          duration_value: body.durationValue,
          duration_unit: body.durationUnit,
          overage_cents_per_minute: body.overageCentsPerMinute,
          color: body.color,
        })
        .select("id")
        .single(),
    ),
  setPlanActive: (id: string, active: boolean) => unwrap(supabase().from("fa_kiosk_plans").update({ active }).eq("id", id)),
  updatePlan: (id: string, body: { name: string; valueCents: number; durationValue: number; durationUnit: Plan["durationUnit"]; overageCentsPerMinute: number; color: string }) =>
    unwrap(supabase().from("fa_kiosk_plans").update({
      name: body.name,
      value_cents: body.valueCents,
      duration_value: body.durationValue,
      duration_unit: body.durationUnit,
      overage_cents_per_minute: body.overageCentsPerMinute,
      color: body.color,
    }).eq("id", id)),
  createProduct: (body: { unitId: string; name: string; emoji?: string; priceCents: number; costCents?: number | null; stock: number }) =>
    unwrap<{ id: string }>(
      supabase()
        .from("fa_kiosk_products")
        .insert({
          unit_id: body.unitId,
          name: body.name,
          emoji: body.emoji ?? null,
          price_cents: body.priceCents,
          cost_cents: body.costCents ?? null,
          stock: body.stock,
        })
        .select("id")
        .single(),
    ),
  setProductActive: (id: string, active: boolean) => unwrap(supabase().from("fa_kiosk_products").update({ active }).eq("id", id)),
  updateProduct: (id: string, body: { name: string; emoji?: string; priceCents: number; costCents?: number | null; stock: number }) =>
    unwrap(
      supabase()
        .from("fa_kiosk_products")
        .update({ name: body.name, emoji: body.emoji ?? null, price_cents: body.priceCents, cost_cents: body.costCents ?? null, stock: body.stock })
        .eq("id", id),
    ),
  createAsset: (body: {
    unitId: string;
    name: string;
    emoji: string;
    color: string;
    maintenanceThresholdHours: number;
    photoUrl?: string | null;
  }) =>
    unwrap<{ id: string }>(
      supabase()
        .from("fa_kiosk_assets")
        .insert({
          unit_id: body.unitId,
          name: body.name,
          emoji: body.emoji,
          color: body.color,
          maintenance_threshold_hours: body.maintenanceThresholdHours,
          photo_url: body.photoUrl ?? null,
        })
        .select("id")
        .single(),
    ),
  setAssetStatus: (id: string, status: Asset["status"]) => unwrap(supabase().from("fa_kiosk_assets").update({ status }).eq("id", id)),
  setAssetPhoto: (id: string, photoUrl: string | null) =>
    unwrap(supabase().from("fa_kiosk_assets").update({ photo_url: photoUrl }).eq("id", id)),
  // Bucket privado `crianca-fotos` (ver migration fa_kiosk_child_photos) —
  // diferente de `carrinho-fotos`, sem leitura pública: é foto de criança,
  // não de equipamento. O caminho é gravado via RPC (fa_set_child_photo_path),
  // não por UPDATE direto na tabela — mesma regra que vale para o resto de
  // fa_kiosk_children: escrita só por função SECURITY DEFINER (ver migration
  // fa_kiosk_temp_anon_read). Exibir a foto de volta exigiria uma signed URL,
  // fora do escopo deste formulário.
  uploadChildPhoto: async (childId: string, photo: Blob): Promise<void> => {
    assertValidImageUpload(photo);
    const prepared = await prepareUpload(photo, "foto");
    const path = `${childId}/${Date.now()}.${prepared.ext}`;
    const { error: uploadError } = await supabase().storage.from("crianca-fotos").upload(path, prepared.blob, {
      contentType: prepared.contentType,
      upsert: false,
    });
    if (uploadError) throw new Error(uploadError.message);
    await unwrap(supabase().rpc("fa_set_child_photo_path", { p_child_id: childId, p_photo_path: path }));
  },
  // Upload direto para o bucket público `carrinho-fotos` (ver migration
  // fa_kiosk_asset_photos) — comprimida antes do upload para economizar storage.
  uploadAssetPhoto: async (unitId: string, file: File): Promise<string> => {
    assertValidImageUpload(file);
    const prepared = await prepareUpload(file, "foto");
    const path = `${unitId}/${Date.now()}.${prepared.ext}`;
    const { error } = await supabase().storage.from("carrinho-fotos").upload(path, prepared.blob, {
      contentType: prepared.contentType,
      upsert: false,
    });
    if (error) throw new Error(error.message);
    const { data } = supabase().storage.from("carrinho-fotos").getPublicUrl(path);
    return data.publicUrl;
  },
  // Criação de funcionário exige uma conta real no Supabase Auth — não dá
  // para ser feita com a chave anônima/de sessão do cliente, só com a
  // service role. A Edge Function `admin-create-employee` confere que
  // quem chama é ADMIN autenticado e faz o resto (auth.users + linha em
  // fa_kiosk_employees + PIN em fa_kiosk_local_credentials) do lado do
  // servidor. Não existe e-mail/senha em nenhum passo — só o PIN.
  createEmployee: (body: NewEmployeeInput) =>
    unwrap<{ id: string }>(supabase().functions.invoke("admin-create-employee", { body })),
  // Ativar/desativar e trocar papel passam por RPC (e não por UPDATE direto)
  // para a alteração ficar na trilha de auditoria na mesma transação e para
  // o guard do último Owner disparar. Ver migration 20260807000005.
  setEmployeeActive: (id: string, active: boolean) =>
    unwrap(supabase().rpc("fa_config_set_employee_active", { p_employee_id: id, p_active: active })),
  setEmployeeRole: (id: string, role: Employee["role"]) =>
    unwrap(supabase().rpc("fa_config_set_employee_role", { p_employee_id: id, p_role: role })),
  setEmployeeSector: (id: string, sector: EmployeeSector | null) =>
    unwrap(supabase().rpc("fa_config_set_employee_sector", { p_employee_id: id, p_sector: sector })),

  // ── Olhar FaçaAmigos (planos >= 1h; internamente relatorio_sessao) ──
  sessionReportsPending: (unitId: string) =>
    unwrap<PendingSessionReport[]>(supabase().rpc("fa_session_reports_pending", { p_unit_id: unitId })),
  /** Preenchidos e ainda não entregues (de qualquer dia) — persistem até virar SENT/SENT_MANUAL. */
  sessionReportsUnsent: (unitId: string) =>
    unwrap<RecentSessionReport[]>(supabase().rpc("fa_session_reports_unsent", { p_unit_id: unitId })),
  sessionReportsRecent: (unitId: string, sinceMs: number) =>
    unwrap<RecentSessionReport[]>(supabase().rpc("fa_session_reports_recent", { p_unit_id: unitId, p_since_ms: sinceMs })),
  /**
   * Grava o relatório (idempotente por sessão). Sem rede lança OfflineQueuedError:
   * o formulário fica salvo na fila local e o envio ao responsável é reenviado pelo botão "Reenviar".
   */
  sessionReportSubmit: (body: { sessionId: string; catalogVersion: number; answers: SessionReportAnswers; observacao: string | null }) =>
    localDeviceId().then((deviceId) =>
      callResilient<SessionReportSubmitResult>("fa_session_report_submit", {
        p_session_id: body.sessionId,
        p_catalog_version: body.catalogVersion,
        p_answers: body.answers,
        p_observacao: body.observacao,
        p_device_id: deviceId,
      }),
    ),
  /** Gera o PDF (se ainda não existe) e envia o link ao responsável. `regenerate` refaz texto e PDF, mantendo o mesmo link. */
  sessionReportDispatch: (reportId: string, opts: { regenerate?: boolean } = {}) =>
    unwrap<SessionReportDispatchResult>(
      supabase().functions.invoke("session-report-dispatch", { body: { reportId, regenerate: opts.regenerate === true } }),
    ),
  /** Signed URL (60 s) do PDF do relatório — a policy do bucket exige 'relatorio_sessao.read'. */
  sessionReportPdfUrl: async (pdfPath: string): Promise<string> => {
    const { data, error } = await supabase().storage.from("relatorios-sessao").createSignedUrl(pdfPath, 60);
    if (error || !data?.signedUrl) throw new Error(error?.message ?? "Não foi possível abrir o PDF");
    return data.signedUrl;
  },
  /** Link público do PDF, o mesmo que o responsável recebeu no WhatsApp. */
  sessionReportPublicLink: (publicToken: string) =>
    `${(import.meta.env.VITE_SUPABASE_URL as string | undefined) || "https://ivjvpdzsfjdpyabbzzuj.supabase.co"}/functions/v1/session-report-view?t=${publicToken}`,
  /** Envio manual do Olhar FaçaAmigos em PDF via WhatsApp com mensagem padrão. */
  sessionReportSendManualPdf: async (reportId: string) => {
    await Api.sessionReportDispatch(reportId);
    const { data, error } = await supabase()
      .from("fa_kiosk_session_reports")
      .select("public_token, child_name_snapshot, guardian:fa_kiosk_guardians!guardian_id(full_name, phone_e164)")
      .eq("id", reportId)
      .single();

    if (error || !data?.public_token) {
      throw new Error("Não foi possível obter o link do PDF do relatório.");
    }

    const publicUrl = Api.sessionReportPublicLink(data.public_token);
    const childFirst = data.child_name_snapshot ? data.child_name_snapshot.trim().split(/\s+/)[0] : "criança";
    const guardianRaw = data.guardian as { full_name?: string | null; phone_e164?: string | null } | null;
    const guardianFirst = guardianRaw?.full_name ? guardianRaw.full_name.trim().split(/\s+/)[0] : "tudo bem";

    const defaultMsg = `Olá ${guardianFirst}! 💛 O Olhar FaçaAmigos em PDF de ${childFirst} sobre como foi a brincadeira hoje no FaçaAmigos está disponível!\n\nAcesse o PDF completo aqui:\n${publicUrl}\n\nRegistro observacional preparado com carinho pela nossa equipe de recreação. Qualquer dúvida, estamos à disposição! 💛`;

    const rawPhone = guardianRaw?.phone_e164 ?? "";
    const phoneDigits = rawPhone.replace(/\D/g, "");

    const waUrl = phoneDigits
      ? `https://wa.me/${phoneDigits}?text=${encodeURIComponent(defaultMsg)}`
      : `https://wa.me/?text=${encodeURIComponent(defaultMsg)}`;

    window.open(waUrl, "_blank", "noopener");

    // Marca como resolvido para o alerta piscante parar — o responsável já
    // recebeu o PDF pela mão do operador, mesmo que a Twilio tenha recusado.
    try {
      await Api.sessionReportMarkSentManually(reportId);
    } catch {
      /* não bloqueia o fluxo: o WhatsApp já abriu, o operador já pode enviar */
    }
  },
  /** Confirma que o operador enviou o PDF manualmente pelo WhatsApp dele — ver uso acima. */
  sessionReportMarkSentManually: (reportId: string) =>
    unwrap<SessionReportWhatsappStatus>(
      supabase().rpc("fa_session_report_mark_sent_manually", { p_report_id: reportId }),
    ),
  /** Histórico do Gerencial. A RLS já limita a quem tem 'relatorio_sessao.read'. */
  sessionReportsList: (filters: { unitId?: string | null; sinceMs: number; untilMs: number }) => {
    let q = supabase()
      .from("fa_kiosk_session_reports")
      .select("*, employee:fa_kiosk_employees!filled_by_employee_id(full_name), guardian:fa_kiosk_guardians!guardian_id(full_name, phone_e164)")
      .gte("filled_at_ms", filters.sinceMs)
      .lt("filled_at_ms", filters.untilMs)
      .order("filled_at_ms", { ascending: false })
      .limit(500);
    if (filters.unitId) q = q.eq("unit_id", filters.unitId);
    return unwrap<SessionReportRow[]>(q);
  },
  // Redefinição de PIN (ex.: colaborador esqueceu) — mesma exigência de
  // chamador ADMIN autenticado, resolvida do lado do servidor.
  setEmployeePin: (employeeId: string, pin: string) =>
    unwrap<{ ok: boolean }>(supabase().functions.invoke("admin-set-employee-pin", { body: { employeeId, pin } })),
  /** Substitui o conjunto de unidades em que o colaborador atua — Gerencial. */
  setEmployeeUnits: (employeeId: string, unitIds: string[]) =>
    unwrap(supabase().rpc("fa_config_set_employee_units", { p_employee_id: employeeId, p_unit_ids: unitIds })),
  /** Quem já completou o cadastro via convite — Gerencial > Colaboradores, exige `folha_pagamento.read`. */
  personalInfoStatus: async (): Promise<PersonalInfoStatus[]> => {
    const rows = await unwrap<Array<{ employee_id: string; completed: boolean }>>(
      supabase().rpc("fa_kiosk_personal_info_status"),
    );
    return rows.map((r) => ({ employeeId: r.employee_id, completed: r.completed }));
  },

  // Link de convite individual — gerar exige sessão de ADMIN (JWT), as
  // outras duas rodam ANTES de qualquer conta existir (anon, ver
  // supabase/config.toml) e por isso não passam por `supabase().rpc`.
  createOnboardingInvite: (body: CreateOnboardingInviteInput) =>
    unwrap<{ inviteId: string; token: string; expiresAtMs: number }>(
      supabase().functions.invoke("create-onboarding-invite", { body }),
    ),
  onboardingInviteInfo: (inviteId: string, token: string) =>
    unwrap<OnboardingInviteInfo>(
      supabase().functions.invoke("onboarding-invite-info", { body: { inviteId, token } }),
    ),
  onboardingComplete: (body: OnboardingCompleteInput) =>
    unwrap<{ id: string }>(supabase().functions.invoke("onboarding-complete", { body })),

  // Link Geral de auto-cadastro de estagiário — token fixo por unidade, ver
  // supabase/functions/general-invite-link. generalInviteLink exige sessão
  // com config.employees.write (JWT); as outras duas rodam ANTES de
  // qualquer conta existir (anon, ver supabase/config.toml).
  generalInviteLink: (unitId: string) =>
    unwrap<GeneralInviteLink>(supabase().functions.invoke("general-invite-link", { body: { unitId } })),
  generalInviteInfo: (unitId: string, token: string) =>
    unwrap<GeneralInviteInfo>(
      supabase().functions.invoke("general-invite-info", { body: { unitId, token } }),
    ),
  generalOnboardingComplete: (body: GeneralOnboardingCompleteInput) =>
    unwrap<{ id: string }>(supabase().functions.invoke("general-onboarding-complete", { body })),

  /**
   * Colaborador correspondente à sessão do Supabase Auth atual. É daqui
   * que o app descobre "quem está operando" ao restaurar uma sessão salva —
   * nunca do que o cliente afirma ser.
   */
  currentEmployee: async (): Promise<{ id: string; full_name: string; role: Employee["role"]; sector: EmployeeSector | null }> => {
    const { data: userData } = await supabase().auth.getUser();
    const authUserId = userData.user?.id;
    if (!authUserId) throw new Error("sem sessão");
    return unwrap<{ id: string; full_name: string; role: Employee["role"]; sector: EmployeeSector | null }>(
      supabase()
        .from("fa_kiosk_employees")
        .select("id, full_name, role, sector")
        .eq("auth_user_id", authUserId)
        .eq("active", true)
        .single(),
    );
  },

  /**
   * Lista usada na TELA DE LOGIN, antes de existir sessão. Vai por Edge
   * Function porque fa_kiosk_employees só é legível por `authenticated`
   * (e deve continuar assim: tem CPF, PIS e cargo). Devolve só id + nome —
   * sem o papel, para um ataque de força bruta não saber qual nome é o
   * Owner. Ver supabase/functions/list-employees.
   */
  employeesForLogin: async (): Promise<{ id: string; full_name: string }[]> => {
    const { data, error } = await supabase().functions.invoke<{
      employees: { id: string; full_name: string }[];
    }>("list-employees", { body: {} });
    if (error) {
      console.error("[api] list-employees falhou:", error, error?.context);
      let detail = error instanceof Error ? error.message : String(error);
      // FunctionsHttpError carrega a Response da edge function em .context —
      // o corpo tem o motivo real (ex.: erro de RLS/DB), que error.message
      // sozinho não mostra (vem só "Edge Function returned a non-2xx status code").
      if (error?.context instanceof Response) {
        try {
          const body = await error.context.clone().text();
          detail = `HTTP ${error.context.status} — ${body || detail}`;
        } catch {
          // corpo já consumido ou ilegível: mantém a mensagem original
        }
      }
      throw new Error(`Não foi possível carregar a lista de colaboradores (${detail})`);
    }
    if (!data) throw new Error("Não foi possível carregar a lista de colaboradores (resposta vazia)");
    return data.employees;
  },

  /** Unidades às quais o colaborador logado está vinculado (fa_kiosk_employee_units). */
  myUnitIds: (employeeId: string) =>
    unwrap<{ unit_id: string }[]>(
      supabase().from("fa_kiosk_employee_units").select("unit_id").eq("employee_id", employeeId),
    ).then((rows) => rows.map((r) => r.unit_id)),

  /** Capacidades do colaborador logado (view fa_kiosk_my_capabilities). */
  myCapabilities: async () => {
    const { data } = await supabase().auth.getSession();
    if (!data?.session) return [];
    return unwrap<{ capability: string }[]>(supabase().from("fa_kiosk_my_capabilities").select("capability")).catch(() => []);
  },

  /** Matriz completa papel→capacidade — Gerencial > Permissões, exige `config.rbac.write`. */
  roleCapabilities: () =>
    unwrap<{ role: Employee["role"]; capability: string }[]>(supabase().rpc("fa_config_list_role_capabilities")),
  /** Troca o papel mínimo dono de uma capacidade — Gerencial > Permissões. */
  setCapabilityRole: (capability: string, role: Employee["role"]) =>
    unwrap(supabase().rpc("fa_config_set_capability_role", { p_capability: capability, p_role: role })),

  // --- Configurações: unidade, fiscal e termos de uso -----------------------
  // Todas passam por RPC `fa_config_*`, que checa fa_kiosk_can() no servidor
  // ANTES de tocar em qualquer linha e registra a alteração na trilha de
  // auditoria. Esconder a aba no menu é UX; isto é o que de fato protege.
  createUnit: (body: { name: string; kind: Unit["kind"]; timezone?: string; businessDayCutoffHour?: number }) =>
    unwrap<string>(supabase().rpc("fa_config_create_unit", { p_payload: body })),
  updateUnit: (
    unitId: string,
    body: {
      name?: string;
      timezone?: string;
      businessDayCutoffHour?: number;
      address?: string | null;
      phone?: string | null;
      latitude?: number | null;
      longitude?: number | null;
      geofenceRadiusM?: number | null;
      openingHourMonSat?: string | null;
      closingHourMonSat?: string | null;
      openingHourSun?: string | null;
      closingHourSun?: string | null;
    },
  ) => unwrap(supabase().rpc("fa_config_update_unit", { p_unit_id: unitId, p_payload: body })),
  unitFiscal: (unitId: string) =>
    unwrap<UnitFiscal>(
      supabase()
        .from("fa_kiosk_units")
        .select(
          "id, name, cnpj, razao_social, nome_fantasia, inscricao_estadual, inscricao_municipal, cnae_principal, crt, " +
            "end_logradouro, end_numero, end_complemento, end_bairro, end_municipio_ibge, end_municipio_nome, end_uf, end_cep, fone, " +
            "fiscal_ambiente, fiscal_enabled, nfce_serie, nfce_csc_id, nfce_qrcode_url_consulta, " +
            "nfse_item_lista_servico, nfse_codigo_tributacao_municipio, nfse_aliquota_iss_bp, nfse_iss_retido, " +
            "nfse_regime_especial, nfse_serie_rps, nfse_ambiente, nfse_enabled",
        )
        .eq("id", unitId)
        .single(),
    ),
  /**
   * As chaves do payload são as do formulário da FiscalTab (camelCase:
   * endMunicipioIbge, endMunicipioNome, nfceCscId...); a RPC
   * fa_config_update_unit_fiscal é quem mapeia para as colunas.
   */
  updateUnitFiscal: (unitId: string, payload: Record<string, unknown>) =>
    unwrap(supabase().rpc("fa_config_update_unit_fiscal", { p_unit_id: unitId, p_payload: payload })),
  /**
   * Status do token do CSC (NFC-e) — a view fa_kiosk_fiscal_csc_status só
   * diz SE existe e QUANDO foi gravado; o token em si nunca sai da nuvem
   * para o Gerencial.
   */
  fiscalCscStatus: (unitId: string) =>
    unwrap<{ unit_id: string; updated_at_ms: number } | null>(
      supabase().from("fa_kiosk_fiscal_csc_status").select("unit_id, updated_at_ms").eq("unit_id", unitId).maybeSingle(),
    ),
  /**
   * Grava o token do CSC (SEFA-PA) cifrado na nuvem pela Edge Function
   * fiscal-csc-upload (exige config.fiscal.write). Só o worker fiscal do PC
   * do balcão consegue lê-lo depois, para assinar o QR Code da NFC-e.
   */
  uploadFiscalCsc: (unitId: string, cscId: string, cscToken: string) =>
    unwrap<{ ok: boolean }>(supabase().functions.invoke("fiscal-csc-upload", { body: { unitId, cscId, cscToken } })),
  /**
   * Volta uma NFC-e BLOQUEADA/REJEITADA para PENDENTE, para o worker tentar
   * de novo (ex.: depois de corrigir o NCM do produto ou o CSC). Capability
   * nfce.retry (OPERADOR+).
   */
  retryNfce: (fiscalDocId: string) =>
    unwrap<{ fiscalDocId: string; status: string }>(supabase().rpc("fa_fiscal_retry_nfce", { p_fiscal_doc_id: fiscalDocId })),
  /**
   * Status do certificado A1 configurado para a unidade — nunca traz a
   * senha (nem cifrada): a view fa_kiosk_fiscal_certificate_status já
   * seleciona só o que é seguro mostrar no Gerencial.
   */
  fiscalCertificateStatus: (unitId: string) =>
    unwrap<{ unit_id: string; subject_cn: string | null; issuer_cn: string | null; expires_at_ms: number | null; uploaded_at_ms: number } | null>(
      supabase().from("fa_kiosk_fiscal_certificate_status").select("*").eq("unit_id", unitId).maybeSingle(),
    ),
  /**
   * Upload do certificado A1 (.pfx) para transmissão de NFS-e. O arquivo
   * e a senha só passam pela Edge Function nfse-certificate-upload, que
   * cifra a senha e grava o .pfx num bucket privado — nunca tocam uma
   * tabela legível pelo client. Ver comentário da function no repositório.
   */
  uploadFiscalCertificate: (unitId: string, pfxBase64: string, password: string, fileName?: string) =>
    unwrap<{ ok: boolean }>(
      supabase().functions.invoke("nfse-certificate-upload", { body: { unitId, pfxBase64, password, fileName } }),
    ),
  productsFiscal: (unitId: string) =>
    unwrap<ProductFiscal[]>(
      supabase()
        .from("fa_kiosk_products")
        .select("id, name, ncm, cest, cfop, csosn, origem, unidade_comercial, gtin, pis_cst, cofins_cst")
        .eq("unit_id", unitId)
        .eq("active", true)
        .order("name"),
    ),
  updateProductFiscal: (productId: string, payload: Record<string, unknown>) =>
    unwrap(supabase().rpc("fa_config_update_product_fiscal", { p_product_id: productId, p_payload: payload })),
  fiscalTerminalStatus: (unitId: string) =>
    unwrap<FiscalTerminalStatus[]>(
      supabase()
        .from("fa_kiosk_fiscal_terminal_status")
        .select("unit_id, terminal_id, worker_version, cert_subject_cn, cert_not_after_ms, csc_configured, environment, last_heartbeat_ms, last_error")
        .eq("unit_id", unitId),
    ),
  setTerms: (unitId: string, terms: string) =>
    unwrap(supabase().rpc("fa_config_set_terms", { p_unit_id: unitId, p_terms: terms })),

  // Os relatórios abaixo chamavam `/api/reports/...` (servidor Fastify
  // local, apps/kiosk) — removido na migração para Supabase (commit
  // cafbda6), então todo relatório voltava 404. Reescritos como consultas
  // diretas ao Supabase, agregadas no cliente (mesmo padrão de
  // apps/backoffice/.../relatorios/page.tsx).
  // `unitId: null` no relatório de vendas/visitas/planos/frota/sessões
  // significa "todas as unidades" — usado pelo Gerencial, que enxerga as 3
  // de uma vez (mesmo padrão de apps/backoffice/.../relatorios/page.tsx,
  // que resolvia esse mesmo dilema antes de ser desativado).
  /**
   * Passivo de saldos pré-pagos em aberto — não tem período (from/to):
   * é o retrato de HOJE do que já foi recebido e ainda não foi usado,
   * e não vence sozinho (decisão do dono: saldo sem validade).
   */
  prepaidCreditLiability: async (unitId: string) => {
    const rows = await unwrap<{ credits_count: number; remaining_minutes: number; estimated_value_cents: number }[]>(
      supabase().rpc("fa_kiosk_prepaid_credit_liability", { p_unit_id: unitId }),
    );
    // A função é uma agregação sem GROUP BY — sempre devolve exatamente
    // uma linha (com zeros, se não houver saldo em aberto), mas o
    // fallback cobre qualquer resposta vazia inesperada.
    return rows[0] ?? { credits_count: 0, remaining_minutes: 0, estimated_value_cents: 0 };
  },

  reportSales: async (unitId: string | null, from: string, to: string) => {
    let ordersQuery = supabase()
      .from("fa_kiosk_orders")
      .select("id, business_date, total_cents")
      .eq("status", "PAGA")
      .gte("business_date", from)
      .lte("business_date", to);
    if (unitId) ordersQuery = ordersQuery.eq("unit_id", unitId);
    const orders = await unwrap<Record<string, unknown>[]>(ordersQuery);
    const byDayMap = new Map<string, { orders_count: number; total_cents: number }>();
    for (const o of orders) {
      const d = o.business_date as string;
      const cur = byDayMap.get(d) ?? { orders_count: 0, total_cents: 0 };
      cur.orders_count += 1;
      cur.total_cents += o.total_cents as number;
      byDayMap.set(d, cur);
    }
    const byDay: DailySales[] = [...byDayMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([business_date, v]) => ({ business_date, ...v }));

    let byMethod: RevenueByMethod[] = [];
    if (orders.length > 0) {
      // Junção embutida via FK (payments.order_id -> orders.id) em vez de
      // `.in("order_id", orderIds)`: com muitos pedidos no período essa lista
      // vira uma query string gigante e o Supabase (Kong/PostgREST) rejeita
      // com 400 Bad Request antes mesmo de chegar no Postgres.
      let paymentsQuery = supabase()
        .from("fa_kiosk_payments")
        .select("method, amount_cents, fa_kiosk_orders!inner(business_date, status, unit_id)")
        .eq("fa_kiosk_orders.status", "PAGA")
        .gte("fa_kiosk_orders.business_date", from)
        .lte("fa_kiosk_orders.business_date", to);
      if (unitId) paymentsQuery = paymentsQuery.eq("fa_kiosk_orders.unit_id", unitId);
      const payments = await unwrap<Record<string, unknown>[]>(paymentsQuery);
      const methodMap = new Map<string, number>();
      for (const p of payments) {
        const m = p.method as string;
        methodMap.set(m, (methodMap.get(m) ?? 0) + (p.amount_cents as number));
      }
      byMethod = [...methodMap.entries()].map(([method, total_cents]) => ({ method, total_cents }));
    }
    return { byDay, byMethod };
  },
  reportVisits: async (unitId: string | null, from: string, to: string) => {
    let query = supabase().from("fa_kiosk_sessions").select("business_date").gte("business_date", from).lte("business_date", to);
    if (unitId) query = query.eq("unit_id", unitId);
    const sessions = await unwrap<Record<string, unknown>[]>(query);
    const map = new Map<string, number>();
    for (const s of sessions) {
      const d = s.business_date as string;
      map.set(d, (map.get(d) ?? 0) + 1);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([business_date, sessions_count]) => ({ business_date, sessions_count }));
  },
  /**
   * Check-ins por hora do dia, agrupado por unidade — hora local do
   * navegador (mesmo padrão de reportVisits: agregação no cliente, sem
   * RPC), já que checkin_at_ms é o mesmo instante real em qualquer
   * fuso e as 3 unidades hoje operam no mesmo horário.
   */
  reportCheckinsByHour: async (unitId: string | null, from: string, to: string): Promise<CheckinsByHour[]> => {
    let query = supabase()
      .from("fa_kiosk_sessions")
      .select("unit_id, checkin_at_ms, checkin_at, fa_kiosk_units(id, name)")
      .gte("business_date", from)
      .lte("business_date", to);
    if (unitId) query = query.eq("unit_id", unitId);
    const sessions = await unwrap<Record<string, unknown>[]>(query);
    const map = new Map<string, { unit_id: string; unit_name: string; hour: number; count: number }>();
    for (const s of sessions) {
      const uid = s.unit_id as string;
      let uname = "—";
      if (s.fa_kiosk_units) {
        if (Array.isArray(s.fa_kiosk_units) && s.fa_kiosk_units[0]) {
          uname = (s.fa_kiosk_units[0] as { name?: string }).name ?? "—";
        } else if (typeof s.fa_kiosk_units === "object") {
          uname = (s.fa_kiosk_units as { name?: string }).name ?? "—";
        }
      }
      const rawTs = s.checkin_at_ms ? Number(s.checkin_at_ms) : (s.checkin_at ? new Date(s.checkin_at as string).getTime() : 0);
      if (!rawTs) continue;
      const hour = new Date(rawTs).getHours();
      const key = `${uid}:${hour}`;
      const cur = map.get(key) ?? { unit_id: uid, unit_name: uname, hour, count: 0 };
      cur.count += 1;
      map.set(key, cur);
    }
    return [...map.values()].sort((a, b) => a.hour - b.hour || a.unit_name.localeCompare(b.unit_name));
  },
  /** Ticket médio de hoje (faturado / pedidos pagos) para o termômetro do Painel. */
  todayTicketMedio: async (unitId: string, cutoffHour: number) => {
    const rows = await unwrap<{ total_cents: number; orders_count: number; avg_cents: number }[]>(
      supabase().rpc("fa_kiosk_today_ticket_medio", { p_unit_id: unitId, p_business_date: businessDateFor(Date.now(), cutoffHour) }),
    );
    const row = rows[0] ?? { total_cents: 0, orders_count: 0, avg_cents: 0 };
    return { totalCents: row.total_cents, ordersCount: row.orders_count, avgCents: row.avg_cents };
  },
  /** Meta de Ticket Médio (mínimo/alvo) configurada pelo Owner para a unidade — null se ainda não configurada. */
  ticketGoal: async (unitId: string): Promise<TicketGoal | null> => {
    try {
      const rows = await unwrap<Record<string, unknown>[]>(
        supabase().from("fa_kiosk_unit_ticket_goals").select("unit_id, min_ticket_cents, target_ticket_cents").eq("unit_id", unitId),
      );
      const row = rows[0];
      if (!row) return null;
      const res = { unitId: row.unit_id as string, minTicketCents: row.min_ticket_cents as number, targetTicketCents: row.target_ticket_cents as number };
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(`fa_ticket_goal_${unitId}`, JSON.stringify(res));
      }
      return res;
    } catch (err) {
      console.warn("Falha ao buscar ticketGoal da API, buscando do localStorage:", err);
      if (typeof localStorage !== "undefined") {
        const cached = localStorage.getItem(`fa_ticket_goal_${unitId}`);
        if (cached) {
          try {
            return JSON.parse(cached) as TicketGoal;
          } catch { /* melhor esforço: falha ignorada */ }
        }
      }
      return null;
    }
  },
  setTicketGoal: async (unitId: string, minTicketCents: number, targetTicketCents: number) => {
    const val = { unitId, minTicketCents, targetTicketCents };
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(`fa_ticket_goal_${unitId}`, JSON.stringify(val));
    }
    return unwrap(
      supabase()
        .from("fa_kiosk_unit_ticket_goals")
        .upsert({ unit_id: unitId, min_ticket_cents: minTicketCents, target_ticket_cents: targetTicketCents, updated_at_ms: Date.now() }, { onConflict: "unit_id" }),
    );
  },
  reportBirthdays: async (month?: number, day?: number) => {
    const query = supabase().from("fa_kiosk_children").select("id, full_name, birth_date");
    const children = await unwrap<Record<string, unknown>[]>(query);
    const filtered = children.filter((c) => {
      if (!c.birth_date) return false;
      const dt = new Date(c.birth_date as string);
      const mMatch = month === undefined || dt.getUTCMonth() + 1 === month;
      const dMatch = day === undefined || dt.getUTCDate() === day;
      return mMatch && dMatch;
    });

    const childIds = filtered.map((c) => c.id as string);
    if (childIds.length === 0) return [] as BirthdayChild[];

    const childGuardians = await unwrap<Record<string, unknown>[]>(
      supabase().from("fa_kiosk_child_guardians").select("child_id, guardian_id").in("child_id", childIds)
    );
    const guardianIds = [...new Set(childGuardians.map((cg) => cg.guardian_id as string))];
    const guardians = guardianIds.length > 0
      ? await unwrap<Record<string, unknown>[]>(supabase().from("fa_kiosk_guardians").select("id, full_name, phone_e164").in("id", guardianIds))
      : [];

    const guardianById = new Map(guardians.map((g) => [g.id as string, g]));
    const guardianIdByChildId = new Map(childGuardians.map((cg) => [cg.child_id as string, cg.guardian_id as string]));

    return filtered.map((c) => {
      const gId = guardianIdByChildId.get(c.id as string);
      const g = gId ? guardianById.get(gId) : null;
      return {
        id: c.id as string,
        full_name: c.full_name as string,
        birth_date: c.birth_date as string,
        guardian_name: (g?.full_name as string | undefined) ?? null,
        guardian_phone: (g?.phone_e164 as string | undefined) ?? null,
      } satisfies BirthdayChild;
    });
  },
  reportShifts: (unitId: string) =>
    unwrap<ShiftSummary[]>(
      supabase()
        .from("fa_kiosk_shifts")
        .select("id, opened_at_ms, closed_at_ms, status, declared_json, expected_json")
        .eq("unit_id", unitId)
        .order("opened_at_ms", { ascending: false }),
    ),
  reportAssetUsage: async (unitId: string, from: string, to: string) => {
    const sessionsQuery = supabase()
      .from("fa_kiosk_sessions")
      .select("asset_id, checkin_at_ms, checkout_at_ms")
      .eq("unit_id", unitId)
      .eq("activity", "CARRINHO")
      .not("asset_id", "is", null)
      .gte("business_date", from)
      .lte("business_date", to);
    const [assets, sessions] = await Promise.all([
      unwrap<Record<string, unknown>[]>(supabase().from("fa_kiosk_assets").select("id, name, emoji, color").eq("unit_id", unitId)),
      unwrap<Record<string, unknown>[]>(sessionsQuery),
    ]);
    const usageByAsset = new Map<string, { sessions_count: number; total_minutes: number }>();
    const nowMs = Date.now();
    for (const s of sessions) {
      const assetId = s.asset_id as string;
      const checkin = s.checkin_at_ms as number;
      const checkout = (s.checkout_at_ms as number | null) ?? nowMs;
      const cur = usageByAsset.get(assetId) ?? { sessions_count: 0, total_minutes: 0 };
      cur.sessions_count += 1;
      cur.total_minutes += Math.max(0, Math.round((checkout - checkin) / 60000));
      usageByAsset.set(assetId, cur);
    }
    return assets.map((a) => {
      const usage = usageByAsset.get(a.id as string) ?? { sessions_count: 0, total_minutes: 0 };
      return { id: a.id as string, name: a.name as string, emoji: a.emoji as string, color: a.color as string, ...usage };
    }) as AssetUsage[];
  },
  // Saldo de bonificação acumulado por operador no mês (aba Gerencial >
  // Bonificação, e o menu individual "Minha Bonificação"), mesma lógica de
  // docs/bonificacao/apuracao_bonificacao.sql (ver
  // apps/kiosk-ui/src/lib/apuracaoBonificacao.ts) — só que buscando os dados
  // brutos aqui, no mesmo padrão dos outros relatórios (reportSales etc.),
  // em vez de rodar a query manual contra o Supabase.
  bonusAccrualMonth: async (unitIds: string[], from: string, to: string): Promise<ApuracaoOperador[]> => {
    if (unitIds.length === 0) return [];
    const { dias, units, employees, programs } = await fetchApuracaoDias(unitIds, from, to);
    return agregarPorOperador(dias, units, employees, programs);
  },
  // Mesma apuração acima, mas filtrada a UM colaborador — usada pelo menu
  // individual "Minha Bonificação" para mostrar o dia de hoje e o acumulado
  // do mês sem expor os dados dos colegas (a apuração inteira roda no
  // cliente, então o filtro por employeeId acontece depois, não é uma
  // policy no banco).
  myBonusAccrual: async (
    employeeId: string,
    unitIds: string[],
    from: string,
    to: string,
  ): Promise<{ dias: ApuracaoDia[]; mes: ApuracaoOperador[] }> => {
    if (unitIds.length === 0) return { dias: [], mes: [] };
    const { dias, units, employees, programs } = await fetchApuracaoDias(unitIds, from, to);
    const minhasDias = dias.filter((d) => d.employeeId === employeeId);
    return { dias: minhasDias, mes: agregarPorOperador(minhasDias, units, employees, programs) };
  },
  // Configuração do programa de bonificação (meta/supermeta por dia da
  // semana + teto/produtos/bônus extras) das unidades pedidas — usada pelo
  // card "Hoje" do Painel/Minha Bonificação (só a unidade atual) e pela
  // aba Gerencial > Metas (todas as unidades, para editar).
  bonusProgramsByUnit: (unitIds: string[]): Promise<BonusProgramsByUnit> => fetchBonusProgramsByUnit(unitIds),
  // Salva as 7 metas (uma por dia da semana) + a configuração geral de UMA
  // unidade de uma vez só — sempre os dois juntos, para nunca existir meta
  // sem configuração geral (ou vice-versa) e a apuração ler estado parcial.
  setBonusProgram: async (
    unitId: string,
    goals: BonusProgramGoal[],
    config: Omit<BonusProgramConfig, "goals" | "planRules" | "planosTetoMesCents" | "aberturaMinPorDia" | "aberturaMinPorData">,
  ): Promise<void> => {
    const now = Date.now();
    await Promise.all([
      unwrap(
        supabase()
          .from("fa_kiosk_bonus_program_goals")
          .upsert(
            goals.map((g) => ({
              unit_id: unitId,
              weekday: g.weekday,
              meta_valor: g.metaValor,
              super_valor: g.superValor,
              meta_bonus_cents: g.metaBonusCents,
              super_bonus_cents: g.superBonusCents,
              updated_at_ms: now,
            })),
            { onConflict: "unit_id,weekday" },
          ),
      ),
      unwrap(
        supabase()
          .from("fa_kiosk_bonus_program_config")
          .upsert(
            {
              unit_id: unitId,
              teto_mes_cents: config.tetoMesCents,
              produto_preco_corte_cents: config.produtoPrecoCorteCents,
              produto_bonus_baixo_cents: config.produtoBonusBaixoCents,
              produto_bonus_alto_cents: config.produtoBonusAltoCents,
              itens_mes_meta: config.itensMesMeta,
              itens_mes_bonus_cents: config.itensMesBonusCents,
              sessao_1h_percentual_min: config.sessao1hPercentualMin,
              sessao_1h_bonus_cents: config.sessao1hBonusCents,
              locacao_extra_bonus_cents: config.locacaoExtraBonusCents,
              updated_at_ms: now,
            },
            { onConflict: "unit_id" },
          ),
      ),
    ]);
  },
  // Horário de abertura da unidade por dia da semana (isodow 1-7 -> minutos
  // desde 00:00). A trava de abertura da bonificação vale até esse horário + 15 min.
  setBonusOpeningHours: async (unitId: string, aberturaMinPorDia: Record<number, number>): Promise<void> => {
    const now = Date.now();
    const rows = Object.entries(aberturaMinPorDia).map(([weekday, aberturaMin]) => ({
      unit_id: unitId,
      weekday: Number(weekday),
      abertura_min: aberturaMin,
      updated_at_ms: now,
    }));
    if (rows.length === 0) return;
    await unwrap(supabase().from("fa_kiosk_unit_opening_hours").upsert(rows, { onConflict: "unit_id,weekday" }));
  },
  // Exceção de horário de abertura para uma data (feriado, evento, horário
  // especial do shopping). Vence o horário do dia da semana.
  setBonusOpeningOverride: async (unitId: string, businessDate: string, aberturaMin: number, motivo?: string): Promise<void> => {
    await unwrap(
      supabase()
        .from("fa_kiosk_unit_opening_overrides")
        .upsert(
          { unit_id: unitId, business_date: businessDate, abertura_min: aberturaMin, motivo: motivo ?? null, updated_at_ms: Date.now() },
          { onConflict: "unit_id,business_date" },
        ),
    );
  },
  deleteBonusOpeningOverride: async (unitId: string, businessDate: string): Promise<void> => {
    await unwrap(
      supabase().from("fa_kiosk_unit_opening_overrides").delete().eq("unit_id", unitId).eq("business_date", businessDate),
    );
  },
  /**
   * Bônus de Planos Longos de UMA unidade: regras por plano/pacote + teto mensal
   * próprio (0 = sem teto). Plano desmarcado é gravado com `active = false` em
   * vez de apagado, para o histórico e para regravar sem perder os valores.
   * Dois upserts, não atômicos, como `setBonusProgram`.
   */
  setBonusPlanRules: async (unitId: string, rules: BonusPlanRule[], planosTetoMesCents: number): Promise<void> => {
    const now = Date.now();
    await unwrap(
      supabase()
        .from("fa_kiosk_bonus_program_config")
        .upsert({ unit_id: unitId, planos_teto_mes_cents: planosTetoMesCents, updated_at_ms: now }, { onConflict: "unit_id" }),
    );
    if (rules.length === 0) return;
    await unwrap(
      supabase()
        .from("fa_kiosk_bonus_plan_rules")
        .upsert(
          rules.map((r) => ({
            unit_id: unitId,
            kind: r.kind,
            ref_id: r.refId,
            label: r.label,
            bonus_cents: r.bonusCents,
            escada_meta: r.escadaMeta,
            escada_bonus_cents: r.escadaBonusCents,
            active: r.active,
            sort_order: r.sortOrder,
            updated_at_ms: now,
          })),
          { onConflict: "unit_id,kind,ref_id" },
        ),
    );
  },
  reportSessions: async (unitId: string | null, from: string, to: string) => {
    let sessionsQuery = supabase()
      .from("fa_kiosk_sessions")
      .select("id, unit_id, access_code, checkin_at_ms, checkout_at_ms, status, activity, child_name_snapshot, guardian_id, plan_id, checkin_by_employee_id, legacy_source, operator_name_snapshot")
      .gte("business_date", from)
      .lte("business_date", to)
      .order("checkin_at_ms", { ascending: false });
    if (unitId) sessionsQuery = sessionsQuery.eq("unit_id", unitId);
    const sessions = await unwrap<Record<string, unknown>[]>(sessionsQuery);
    if (sessions.length === 0) return [] as SessionAudit[];

    const guardianIds = [...new Set(sessions.map((s) => s.guardian_id as string))];
    const planIds = [...new Set(sessions.map((s) => s.plan_id as string).filter(Boolean))];
    const employeeIds = [...new Set(sessions.map((s) => s.checkin_by_employee_id as string).filter(Boolean))];

    const [guardians, plans, employees] = await Promise.all([
      unwrap<Record<string, unknown>[]>(supabase().from("fa_kiosk_guardians").select("id, full_name, phone_e164, cpf").in("id", guardianIds)),
      planIds.length > 0
        ? unwrap<Record<string, unknown>[]>(supabase().from("fa_kiosk_plans").select("id, name").in("id", planIds))
        : Promise.resolve([]),
      employeeIds.length > 0
        ? unwrap<Record<string, unknown>[]>(supabase().from("fa_kiosk_employees").select("id, full_name").in("id", employeeIds))
        : Promise.resolve([]),
    ]);
    const guardianById = new Map(guardians.map((g) => [g.id as string, g]));
    const planById = new Map(plans.map((p) => [p.id as string, p]));
    const employeeById = new Map(employees.map((e) => [e.id as string, e]));

    return sessions.map((s) => {
      const guardian = guardianById.get(s.guardian_id as string);
      const plan = planById.get(s.plan_id as string);
      const employee = employeeById.get(s.checkin_by_employee_id as string);
      return {
        id: s.id as string,
        unit_id: s.unit_id as string,
        access_code: s.access_code as string | null,
        checkin_at_ms: s.checkin_at_ms as number,
        checkout_at_ms: s.checkout_at_ms as number | null,
        status: s.status as string,
        activity: s.activity as "PLAYGROUND" | "CARRINHO",
        child_name: s.child_name_snapshot as string,
        guardian_name: (guardian?.full_name as string | undefined) ?? "—",
        guardian_phone: (guardian?.phone_e164 as string | undefined) ?? null,
        guardian_cpf: (guardian?.cpf as string | undefined) ?? null,
        plan_name: (plan?.name as string | undefined) ?? null,
        employee_name: (employee?.full_name as string | undefined) ?? (s.operator_name_snapshot as string | undefined) ?? (s.legacy_source ? "Legado" : null),
        legacy_source: s.legacy_source as string | null,
        operator_name_snapshot: s.operator_name_snapshot as string | null,
      } satisfies SessionAudit;
    });
  },
  getFolhaPagamentoData: async (unitId: string, year: number, month: number, timezone?: string) => {
    const { fromMs, toMs } = monthRangeMs(year, month, timezone);
    let tablesMissing = false;
    const [employees, payrollInfos, pontoRecords, runs] = await Promise.all([
      unwrap<Record<string, unknown>[]>(
        supabase()
          .from("fa_kiosk_employees")
          .select("id, full_name, cpf, role, position, weekly_hours_contracted")
          .eq("unit_id", unitId)
          .eq("active", true)
          .order("full_name"),
      ),
      unwrap<Record<string, unknown>[]>(
        supabase().from("fa_kiosk_employee_payroll_info").select("*"),
      ).catch(() => {
        tablesMissing = true;
        return [];
      }),
      unwrap<Record<string, unknown>[]>(
        supabase()
          .from("fa_kiosk_ponto_records")
          .select("employee_id, kind, at_ms")
          .eq("unit_id", unitId)
          .gte("at_ms", fromMs)
          .lt("at_ms", toMs),
      ),
      unwrap<Record<string, unknown>[]>(
        supabase()
          .from("fa_kiosk_payroll_runs")
          .select("id, year, month, total_cents, created_at_ms, fa_kiosk_payroll_items(*)")
          .eq("unit_id", unitId)
          .order("year", { ascending: false })
          .order("month", { ascending: false }),
      ).catch(() => {
        tablesMissing = true;
        return [];
      }),
    ]);


    const payrollInfoByEmployee = new Map((payrollInfos ?? []).map((p) => [p.employee_id as string, p]));

    const pontoByEmployee = new Map<string, { kind: PontoKind; at_ms: number }[]>();
    for (const record of pontoRecords ?? []) {
      const list = pontoByEmployee.get(record.employee_id as string) ?? [];
      list.push({ kind: record.kind as PontoKind, at_ms: record.at_ms as number });
      pontoByEmployee.set(record.employee_id as string, list);
    }

    const folhaEmployees: FolhaPagamentoEmployee[] = (employees ?? []).map((e) => {
      const info = payrollInfoByEmployee.get(e.id as string);
      const worked = computeWorkedMinutes(pontoByEmployee.get(e.id as string) ?? []);
      return {
        id: e.id as string,
        fullName: e.full_name as string,
        cpf: (e.cpf as string | null) ?? null,
        role: e.role as Employee["role"],
        position: (e.position as string | null) ?? null,
        weeklyHoursContracted: (e.weekly_hours_contracted as number | null) ?? null,
        workedMinutes: worked.minutes,
        workedIncomplete: worked.incomplete,
        salaryBaseCents: (info?.salary_base_cents as number | null) ?? null,
        bankCode: (info?.bank_code as string | null) ?? null,
        bankAgencia: (info?.bank_agencia as string | null) ?? null,
        bankAgenciaDv: (info?.bank_agencia_dv as string | null) ?? null,
        bankConta: (info?.bank_conta as string | null) ?? null,
        bankContaDv: (info?.bank_conta_dv as string | null) ?? null,
        bankAccountType: (info?.bank_account_type as string | null) ?? null,
        pixKey: (info?.pix_key as string | null) ?? null,
      };
    });

    const parsedRuns: ClosedRun[] = (runs ?? []).map((r) => ({
      id: r.id as string,
      year: r.year as number,
      month: r.month as number,
      totalCents: r.total_cents as number,
      createdAtMs: r.created_at_ms as number,
      items: (r.fa_kiosk_payroll_items as Record<string, unknown>[] ?? []).map((item) => ({
        id: item.id as string,
        employee_id: (item.employee_id as string | null) ?? null,
        full_name_snapshot: item.full_name_snapshot as string,
        cpf_snapshot: (item.cpf_snapshot as string | null) ?? null,
        bank_code_snapshot: (item.bank_code_snapshot as string | null) ?? null,
        bank_agencia_snapshot: (item.bank_agencia_snapshot as string | null) ?? null,
        bank_agencia_dv_snapshot: (item.bank_agencia_dv_snapshot as string | null) ?? null,
        bank_conta_snapshot: (item.bank_conta_snapshot as string | null) ?? null,
        bank_conta_dv_snapshot: (item.bank_conta_dv_snapshot as string | null) ?? null,
        bank_account_type_snapshot: (item.bank_account_type_snapshot as string | null) ?? null,
        salary_base_cents: item.salary_base_cents as number,
        adjustment_cents: item.adjustment_cents as number,
        adjustment_note: (item.adjustment_note as string | null) ?? null,
        total_cents: item.total_cents as number,
        hours_contracted: (item.hours_contracted as number | null) ?? null,
        hours_worked_minutes: (item.hours_worked_minutes as number | null) ?? null,
        hours_worked_incomplete: (item.hours_worked_incomplete as boolean | null) ?? null,
      })),
    }));

    const closedRun = parsedRuns.find((r) => r.year === year && r.month === month) ?? null;

    return {
      employees: folhaEmployees,
      runs: parsedRuns,
      closedRun,
      tablesMissing,
    };

  },
  updatePayrollInfo: async (
    employeeId: string,
    info: {
      salaryBaseCents: number | null;
      bankCode: string | null;
      bankAgencia: string | null;
      bankAgenciaDv: string | null;
      bankConta: string | null;
      bankContaDv: string | null;
      bankAccountType: string | null;
      pixKey: string | null;
    },
  ) => {
    await unwrap(
      supabase().from("fa_kiosk_employee_payroll_info").upsert(
        {
          employee_id: employeeId,
          salary_base_cents: info.salaryBaseCents,
          bank_code: info.bankCode,
          bank_agencia: info.bankAgencia,
          bank_agencia_dv: info.bankAgenciaDv,
          bank_conta: info.bankConta,
          bank_conta_dv: info.bankContaDv,
          bank_account_type: info.bankAccountType,
          pix_key: info.pixKey,
          updated_at_ms: Date.now(),
        },
        { onConflict: "employee_id" },
      ),
    );
  },
  closePayrollRun: async (unitId: string, year: number, month: number, items: PayrollCloseItem[]) => {
    const formattedItems = items.map((item) => ({
      employee_id: item.employeeId,
      full_name_snapshot: item.fullName,
      cpf_snapshot: item.cpf,
      bank_code_snapshot: item.bankCode,
      bank_agencia_snapshot: item.bankAgencia,
      bank_agencia_dv_snapshot: item.bankAgenciaDv,
      bank_conta_snapshot: item.bankConta,
      bank_conta_dv_snapshot: item.bankContaDv,
      bank_account_type_snapshot: item.bankAccountType,
      salary_base_cents: item.salaryBaseCents,
      adjustment_cents: item.adjustmentCents,
      adjustment_note: item.adjustmentNote,
      total_cents: item.totalCents,
      hours_contracted: item.hoursContracted,
      hours_worked_minutes: item.hoursWorkedMinutes,
    }));

    await unwrap(
      supabase().rpc("fa_kiosk_close_payroll_run", {
        p_unit_id: unitId,
        p_year: year,
        p_month: month,
        p_items: formattedItems,
      }),
    );
  },
};

