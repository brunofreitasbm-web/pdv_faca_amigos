import { useEffect, useState } from "react";
import { Button, HelpText, Input, Modal, Select, Tag } from "@facaamigos/ui";
import { Card } from "../GCard.js";
import { Api } from "../../../api/client.js";
import type { Employee, PersonalInfoStatus } from "../../../api/client.js";
import { useAppState } from "../../../state/AppState.js";
import { useToast } from "../../../state/ToastContext.js";
import { ROLE_LABEL, ROLE_DESCRIPTION, ROLE_OPTIONS, type Role } from "../../../auth/capabilities.js";
import { UnitCheckboxGroup } from "../UnitCheckboxGroup.js";
import { dateBrFromIso, EMPLOYEE_SECTOR_OPTIONS, EMPLOYEE_SECTOR_OPTION_LABEL, type EmployeeSectorOption as EmployeeSector } from "@facaamigos/domain";
import { getPublicAppUrl } from "../../../lib/appUrl.js";
import { Emoji3D, renderEmoji } from "../../../components/Emoji3D.js";

export function ColaboradoresTab() {
  const toast = useToast();
  const { units } = useAppState();
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [cadastroStatus, setCadastroStatus] = useState<Map<string, boolean>>(new Map());
  const [showForm, setShowForm] = useState(false);
  const [showOptionalFields, setShowOptionalFields] = useState(false);

  const [fullName, setFullName] = useState("");
  const [cpf, setCpf] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [pin, setPin] = useState("");
  const [birthDate, setBirthDate] = useState("");
  const [admissionDate, setAdmissionDate] = useState("");
  const [role, setRole] = useState<Role>("OPERADOR");
  const [contractType, setContractType] = useState<NonNullable<Employee["contract_type"]>>("CLT");
  const [weeklyHours, setWeeklyHours] = useState("44");
  const [unitIds, setUnitIds] = useState<string[]>(units.map((u) => u.id));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function selectRole(value: Role) {
    setRole(value);
    if (value === "ESTAGIARIO") setContractType("ESTAGIO");
  }

  const [resetPinTarget, setResetPinTarget] = useState<Employee | null>(null);
  const [newPin, setNewPin] = useState("");
  const [resetBusy, setResetBusy] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);

  const [unitsTarget, setUnitsTarget] = useState<Employee | null>(null);
  const [unitsTargetIds, setUnitsTargetIds] = useState<string[]>([]);
  const [unitsBusy, setUnitsBusy] = useState(false);

  // "⋯ Mais" por colaborador: Unidades/PIN/Desativar são ações ocasionais —
  // ficavam no mesmo nível visual que os dois seletores (Permissão, Setor),
  // que são os que o gestor troca com frequência. Lei de Hick: menos opções
  // sempre à vista, decisão mais rápida por card. Mesmo padrão do Painel.
  const [moreMenuFor, setMoreMenuFor] = useState<string | null>(null);
  useEffect(() => {
    if (!moreMenuFor) return;
    const onPointerDown = (ev: PointerEvent) => {
      if (!(ev.target as Element).closest?.("[data-more-menu]")) setMoreMenuFor(null);
    };
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setMoreMenuFor(null);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [moreMenuFor]);

  // Link de convite individual: o Owner decide permissão/unidade(s)/
  // admissão aqui — quem preenche o convite depois só completa os próprios
  // dados pessoais, nunca escolhe o próprio nível de acesso.
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [inviteRole, setInviteRole] = useState<Role>("OPERADOR");
  const [inviteUnitIds, setInviteUnitIds] = useState<string[]>(units.map((u) => u.id));
  const [inviteFullNameHint, setInviteFullNameHint] = useState("");
  const [inviteAdmissionDate, setInviteAdmissionDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteLink, setInviteLink] = useState<string | null>(null);

  function closeInviteModal() {
    setShowInviteModal(false);
    setInviteRole("OPERADOR");
    setInviteUnitIds(units.map((u) => u.id));
    setInviteFullNameHint("");
    setInviteAdmissionDate(new Date().toISOString().slice(0, 10));
    setInviteError(null);
    setInviteLink(null);
  }

  async function generateInvite() {
    setInviteBusy(true);
    setInviteError(null);
    try {
      const { inviteId, token } = await Api.createOnboardingInvite({
        role: inviteRole,
        position: ROLE_LABEL[inviteRole],
        unitIds: inviteUnitIds,
        fullNameHint: inviteFullNameHint.trim() || undefined,
        admissionDate: inviteAdmissionDate || undefined,
      });
      setInviteLink(`${window.location.origin}${window.location.pathname}?convite=${inviteId}.${token}`);
    } catch (err) {
      setInviteError(err instanceof Error ? err.message : "Não foi possível gerar o convite");
    } finally {
      setInviteBusy(false);
    }
  }

  async function copyInviteLink() {
    if (!inviteLink) return;
    await navigator.clipboard.writeText(inviteLink);
    toast.success("Link copiado.");
  }

  // Link Geral de auto-cadastro de estagiário (?cadastro-estagiario=<unitId>.<token>)
  const [showGeneralInviteModal, setShowGeneralInviteModal] = useState(false);
  const [generalInviteUnitId, setGeneralInviteUnitId] = useState(units[0]?.id ?? "");
  const [generalInviteBusy, setGeneralInviteBusy] = useState(false);
  const [generalInviteError, setGeneralInviteError] = useState<string | null>(null);
  const [generalInviteLink, setGeneralInviteLink] = useState<string | null>(null);

  function closeGeneralInviteModal() {
    setShowGeneralInviteModal(false);
    setGeneralInviteError(null);
    setGeneralInviteLink(null);
  }

  async function fetchGeneralInvite() {
    if (!generalInviteUnitId) return;
    setGeneralInviteBusy(true);
    setGeneralInviteError(null);
    try {
      const { unitId, token } = await Api.generalInviteLink(generalInviteUnitId);
      const publicAppOrigin = getPublicAppUrl();
      setGeneralInviteLink(
        `${publicAppOrigin.replace(/\/$/, "")}${window.location.pathname}?cadastro-estagiario=${unitId}.${token}`,
      );
    } catch (err) {
      setGeneralInviteError(err instanceof Error ? err.message : "Não foi possível gerar o link");
    } finally {
      setGeneralInviteBusy(false);
    }
  }

  async function copyGeneralInviteLink() {
    if (!generalInviteLink) return;
    await navigator.clipboard.writeText(generalInviteLink);
    toast.success("Link copiado.");
  }

  // Link Geral de auto-cadastro de Prestador PJ (?cadastro-pj=<unitId>.<token>)
  const [showPjInviteModal, setShowPjInviteModal] = useState(false);
  const [pjInviteUnitId, setPjInviteUnitId] = useState(units[0]?.id ?? "");
  const [pjInviteBusy, setPjInviteBusy] = useState(false);
  const [pjInviteError, setPjInviteError] = useState<string | null>(null);
  const [pjInviteLink, setPjInviteLink] = useState<string | null>(null);

  const [categoryFilter, setCategoryFilter] = useState<"ALL" | "CLT" | "PJ">("ALL");

  function closePjInviteModal() {
    setShowPjInviteModal(false);
    setPjInviteError(null);
    setPjInviteLink(null);
  }

  async function fetchPjInvite() {
    if (!pjInviteUnitId) return;
    setPjInviteBusy(true);
    setPjInviteError(null);
    try {
      const { unitId, token } = await Api.generalInviteLink(pjInviteUnitId);
      const publicAppOrigin = getPublicAppUrl();
      setPjInviteLink(
        `${publicAppOrigin.replace(/\/$/, "")}${window.location.pathname}?cadastro-pj=${unitId}.${token}`,
      );
    } catch (err) {
      setPjInviteError(err instanceof Error ? err.message : "Não foi possível gerar o link PJ");
    } finally {
      setPjInviteBusy(false);
    }
  }

  async function copyPjInviteLink() {
    if (!pjInviteLink) return;
    await navigator.clipboard.writeText(pjInviteLink);
    toast.success("Link PJ copiado.");
  }

  function load() {
    Api.allEmployees().then(setEmployees);
    // Quem já completou o auto-cadastro de RH (módulo "Cadastro de
    // Colaboradores") — só pra sinalizar quem o RH ainda precisa cobrar,
    // não expõe o conteúdo dos dados aqui.
    Api.personalInfoStatus()
      .then((rows: PersonalInfoStatus[]) => setCadastroStatus(new Map(rows.map((r) => [r.employeeId, r.completed]))))
      .catch(() => setCadastroStatus(new Map()));
  }
  useEffect(load, []);
  useEffect(() => setUnitIds(units.map((u) => u.id)), [units]);
  useEffect(() => {
    if (!generalInviteUnitId && units[0]) setGeneralInviteUnitId(units[0].id);
  }, [units, generalInviteUnitId]);

  function resetForm() {
    setFullName("");
    setCpf("");
    setEmail("");
    setPhone("");
    setPin("");
    setBirthDate("");
    setAdmissionDate("");
    setRole("OPERADOR");
    setContractType("CLT");
    setWeeklyHours("44");
    setShowOptionalFields(false);
    setUnitIds(units.map((u) => u.id));
  }

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const created = await Api.createEmployee({
        fullName: fullName.trim(),
        role,
        cpf: cpfDigits ? cpfDigits : undefined,
        email: email.trim() ? email.trim() : undefined,
        phone: phoneDigits ? phoneDigits : undefined,
        pin,
        birthDate: birthDate || undefined,
        admissionDate: admissionDate || undefined,
        position: ROLE_LABEL[role],
        contractType,
        weeklyHoursContracted: Number(weeklyHours) || 44,
      });
      // Grava a atribuição de unidade(s) na mesma ação, para não deixar um
      // colaborador "sem unidade" entre o cadastro e um segundo passo.
      if (unitIds.length > 0) {
        await Api.setEmployeeUnits(created.id, unitIds);
      }
      toast.success("Colaborador criado — já pode entrar com o PIN definido.");
      resetForm();
      setShowForm(false);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao criar colaborador");
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(emp: Employee) {
    try {
      await Api.setEmployeeActive(emp.id, !emp.active);
      toast.success(`${emp.full_name} foi ${emp.active ? "desativado(a)" : "reativado(a)"}.`);
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Não foi possível atualizar o colaborador");
    }
  }

  async function changeRole(emp: Employee, next: Employee["role"]) {
    if (next === emp.role) return;
    try {
      await Api.setEmployeeRole(emp.id, next);
      toast.success(`${emp.full_name} agora é ${ROLE_LABEL[next]}.`);
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Não foi possível alterar o nível de acesso");
      load();
    }
  }

  async function changeSector(emp: Employee, next: EmployeeSector | null) {
    if (next === (emp.sector ?? null)) return;
    try {
      await Api.setEmployeeSector(emp.id, next);
      toast.success(next ? `${emp.full_name} agora atua em ${EMPLOYEE_SECTOR_OPTION_LABEL[next]}.` : `${emp.full_name} ficou sem setor.`);
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Não foi possível alterar o setor");
      load();
    }
  }

  function closeResetPin() {
    setResetPinTarget(null);
    setNewPin("");
    setResetError(null);
  }

  async function confirmResetPin() {
    if (!resetPinTarget) return;
    setResetBusy(true);
    setResetError(null);
    try {
      await Api.setEmployeePin(resetPinTarget.id, newPin);
      toast.success(`PIN de ${resetPinTarget.full_name} redefinido.`);
      closeResetPin();
    } catch (err) {
      setResetError(err instanceof Error ? err.message : "Não foi possível redefinir o PIN");
    } finally {
      setResetBusy(false);
    }
  }

  function openUnitsModal(emp: Employee) {
    setUnitsTarget(emp);
    setUnitsTargetIds(emp.unitIds ?? []);
  }

  async function confirmUnits() {
    if (!unitsTarget) return;
    setUnitsBusy(true);
    try {
      await Api.setEmployeeUnits(unitsTarget.id, unitsTargetIds);
      toast.success(`Unidades de ${unitsTarget.full_name} atualizadas.`);
      setUnitsTarget(null);
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Não foi possível atualizar as unidades");
    } finally {
      setUnitsBusy(false);
    }
  }

  const cpfDigits = cpf.replace(/\D/g, "");
  const phoneDigits = phone.replace(/\D/g, "");
  const emailValid = !email.trim() || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const cpfValid = !cpf || cpfDigits.length === 11;
  const phoneValid = !phone || phoneDigits.length === 10 || phoneDigits.length === 11;

  const formValid = Boolean(fullName.trim().length >= 2 && pin.length === 6 && cpfValid && emailValid && phoneValid);

  return (
    <div>
      {!showForm && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px", flexWrap: "wrap", gap: "10px" }}>
          <div>
            <HelpText>{employees.length} colaboradores cadastrados, nas 3 unidades.</HelpText>
          </div>
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
            <Button variant="secondary" onClick={() => setShowInviteModal(true)} style={{ borderRadius: "9999px" }}>
              <Emoji3D e="🔗" /> Gerar link de cadastro
            </Button>
            <Button variant="primary" onClick={() => setShowForm(true)} style={{ borderRadius: "9999px" }}>
              <Emoji3D e="⚡" /> + Novo colaborador rápido
            </Button>
          </div>
        </div>
      )}

      {/* Filtro por categoria oculto por decisão de produto (reativar trocando false por true). */}
      {/* eslint-disable-next-line no-constant-binary-expression */}
      {false && !showForm && (
        <div style={{ display: "flex", gap: "8px", marginBottom: "16px" }}>
          <Button
            variant={categoryFilter === "ALL" ? "primary" : "ghost"}
            size="sm"
            onClick={() => setCategoryFilter("ALL")}
            style={{ borderRadius: "9999px" }}
          >
            Todos ({employees.length})
          </Button>
          <Button
            variant={categoryFilter === "CLT" ? "primary" : "ghost"}
            size="sm"
            onClick={() => setCategoryFilter("CLT")}
            style={{ borderRadius: "9999px" }}
          >
            Equipe CLT / Estágio ({employees.filter((e) => e.role !== "PRESTADOR_PJ" && e.contract_type !== "PJ").length})
          </Button>
          <Button
            variant={categoryFilter === "PJ" ? "primary" : "ghost"}
            size="sm"
            onClick={() => setCategoryFilter("PJ")}
            style={{ borderRadius: "9999px" }}
          >
            Prestadores PJ ({employees.filter((e) => e.role === "PRESTADOR_PJ" || e.contract_type === "PJ").length})
          </Button>
        </div>
      )}

      {showForm && (
        <Card style={{ padding: "20px", marginBottom: "20px", borderRadius: "18px", border: "2px solid var(--color-primary, #f0196b)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
            <div>
              <h2 style={{ fontFamily: "var(--font-display)", fontSize: "18px", margin: 0 }}><Emoji3D e="⚡" /> Cadastro Rápido de Colaborador</h2>
              <HelpText style={{ margin: 0 }}>Apenas Nome, Permissão e PIN são obrigatórios para cadastro imediato.</HelpText>
            </div>
            <Button variant="ghost" size="sm" onClick={() => { setShowForm(false); resetForm(); }}>
              ✕ Fechar
            </Button>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "12px" }}>
              <Input label="Nome completo *" placeholder="Ex: Maria Silva" value={fullName} onChange={(e) => setFullName(e.target.value)} />

              <Select label="Permissão *" title={ROLE_DESCRIPTION[role]} value={role} onChange={(e) => selectRole(e.target.value as Role)}>
                {ROLE_OPTIONS.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABEL[r]}
                  </option>
                ))}
              </Select>

              <Input
                label="PIN de Acesso (6 dígitos) *"
                placeholder="Ex: 123456"
                type="password"
                inputMode="numeric"
                autoComplete="new-password"
                maxLength={6}
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
                error={pin && pin.length !== 6 ? "PIN deve ter 6 dígitos" : undefined}
              />
            </div>

            <HelpText style={{ margin: 0 }}>
              Permissão concedida: <strong>{ROLE_LABEL[role]}</strong> — {ROLE_DESCRIPTION[role]}
            </HelpText>

            <UnitCheckboxGroup units={units} selected={unitIds} onChange={setUnitIds} />

            <div style={{ marginTop: "4px" }}>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setShowOptionalFields((v) => !v)}
                style={{ color: "var(--color-primary-hover)", fontWeight: "bold" }}
              >
                {showOptionalFields ? "− Ocultar dados complementares" : "＋ Adicionar dados complementares (CPF, E-mail, Telefone, Admissão — Opcional)"}
              </Button>

              {showOptionalFields && (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "12px", marginTop: "12px", padding: "14px", background: "var(--surface-sunken)", borderRadius: "14px" }}>
                  <Input label="CPF (Opcional)" placeholder="000.000.000-00" value={cpf} onChange={(e) => setCpf(e.target.value.replace(/\D/g, "").slice(0, 11))} error={cpf && !cpfValid ? "CPF precisa ter 11 dígitos" : undefined} />
                  <Input label="E-mail (Opcional)" type="email" placeholder="colaborador@empresa.com" value={email} onChange={(e) => setEmail(e.target.value)} error={email && !emailValid ? "E-mail inválido" : undefined} />
                  <Input label="Telefone com DDD (Opcional)" placeholder="(91) 99999-9999" value={phone} onChange={(e) => setPhone(e.target.value.replace(/\D/g, "").slice(0, 11))} error={phone && !phoneValid ? "Telefone precisa ter 10 ou 11 dígitos" : undefined} />
                  <Input label="Data de nascimento (Opcional)" type="date" value={birthDate} onChange={(e) => setBirthDate(e.target.value)} />
                  <Input label="Data de admissão (Opcional)" type="date" value={admissionDate} onChange={(e) => setAdmissionDate(e.target.value)} />
                  <Select label="Tipo de contrato" value={contractType} onChange={(e) => setContractType(e.target.value as typeof contractType)}>
                    <option value="CLT">CLT</option>
                    <option value="ESTAGIO">Estágio</option>
                    <option value="AUTONOMO">Autônomo</option>
                  </Select>
                  <Input label="Jornada semanal (horas)" type="number" value={weeklyHours} onChange={(e) => setWeeklyHours(e.target.value)} />
                </div>
              )}
            </div>

            {error && <p style={{ color: "var(--color-error-text)", margin: 0, fontWeight: "bold" }}>{error}</p>}

            <div style={{ display: "flex", gap: "10px", marginTop: "8px" }}>
              <Button variant="primary" disabled={busy || !formValid} onClick={create} style={{ borderRadius: "9999px" }}>
                ✓ Cadastrar Colaborador
              </Button>
              <Button variant="ghost" onClick={() => { setShowForm(false); resetForm(); }}>
                Cancelar
              </Button>
            </div>
          </div>
        </Card>
      )}

      {resetPinTarget && (
        <Modal onClose={closeResetPin} title={renderEmoji(`🔑 Redefinir PIN de ${resetPinTarget.full_name}`)}>
          <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
            <p style={{ margin: 0, fontSize: "14px", color: "var(--text-muted)" }}>
              Informe o novo PIN numérico de 6 dígitos que o colaborador usará para login no sistema.
            </p>
            <Input
              label="Novo PIN (6 dígitos)"
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              maxLength={6}
              value={newPin}
              onChange={(e) => setNewPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
              error={newPin && newPin.length !== 6 ? "PIN deve ter exatamente 6 dígitos" : undefined}
            />
            {resetError && <p style={{ color: "var(--color-error-text)", margin: 0, fontWeight: "bold" }}>{resetError}</p>}
            <div style={{ display: "flex", gap: "10px", marginTop: "8px" }}>
              <Button variant="primary" disabled={resetBusy || newPin.length !== 6} onClick={confirmResetPin} style={{ borderRadius: "9999px", flex: 1 }}>
                Salvar Novo PIN
              </Button>
              <Button variant="ghost" onClick={closeResetPin}>
                Cancelar
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {unitsTarget && (
        <Modal onClose={() => setUnitsTarget(null)} title={renderEmoji(`🗂️ Unidades de ${unitsTarget.full_name}`)}>
          <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
            <p style={{ margin: 0, fontSize: "14px", color: "var(--text-muted)" }}>
              Em quais unidades este colaborador atua? Aparece na Configurações só das unidades marcadas.
            </p>
            <UnitCheckboxGroup units={units} selected={unitsTargetIds} onChange={setUnitsTargetIds} />
            <div style={{ display: "flex", gap: "10px", marginTop: "8px" }}>
              <Button variant="primary" disabled={unitsBusy} onClick={confirmUnits} style={{ borderRadius: "9999px", flex: 1 }}>
                Salvar unidades
              </Button>
              <Button variant="ghost" onClick={() => setUnitsTarget(null)}>
                Cancelar
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {showInviteModal && (
        <Modal onClose={closeInviteModal} title={renderEmoji("🔗 Gerar link de cadastro")}>
          <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
            {!inviteLink ? (
              <>
                <p style={{ margin: 0, fontSize: "14px", color: "var(--text-muted)" }}>
                  Escolha a permissão, unidade(s) e data de admissão — quem abrir o link só completa os próprios
                  dados pessoais e escolhe o PIN, sem poder alterar o nível de acesso.
                </p>
                <Select label="Permissão *" title={ROLE_DESCRIPTION[inviteRole]} value={inviteRole} onChange={(e) => setInviteRole(e.target.value as Role)}>
                  {ROLE_OPTIONS.map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABEL[r]}
                    </option>
                  ))}
                </Select>
                <UnitCheckboxGroup units={units} selected={inviteUnitIds} onChange={setInviteUnitIds} />
                <Input label="Data de admissão" type="date" value={inviteAdmissionDate} onChange={(e) => setInviteAdmissionDate(e.target.value)} />
                <Input label="Nome (opcional, se já souber)" value={inviteFullNameHint} onChange={(e) => setInviteFullNameHint(e.target.value)} />
                {inviteError && <p style={{ color: "var(--color-error-text)", margin: 0, fontWeight: "bold" }}>{inviteError}</p>}
                <div style={{ display: "flex", gap: "10px", marginTop: "8px" }}>
                  <Button variant="primary" disabled={inviteBusy || inviteUnitIds.length === 0} onClick={generateInvite} style={{ borderRadius: "9999px", flex: 1 }}>
                    {inviteBusy ? "Gerando…" : "Gerar link"}
                  </Button>
                  <Button variant="ghost" onClick={closeInviteModal}>
                    Cancelar
                  </Button>
                </div>
              </>
            ) : (
              <>
                <p style={{ margin: 0, fontSize: "14px", color: "var(--text-muted)" }}>
                  Válido por 7 dias ou até a pessoa preencher — o que vier primeiro. Mande por um canal que só ela
                  tenha acesso (WhatsApp direto, por exemplo).
                </p>
                <Input label="Link de cadastro" value={inviteLink} readOnly onFocus={(e) => e.target.select()} />
                <div style={{ display: "flex", gap: "10px", marginTop: "8px" }}>
                  <Button variant="primary" onClick={copyInviteLink} style={{ borderRadius: "9999px", flex: 1 }}>
                    <Emoji3D e="📋" /> Copiar link
                  </Button>
                  <Button variant="ghost" onClick={closeInviteModal}>
                    Fechar
                  </Button>
                </div>
              </>
            )}
          </div>
        </Modal>
      )}

      {showGeneralInviteModal && (
        <Modal onClose={closeGeneralInviteModal} title={renderEmoji("🎓 Link Geral de Estagiário")}>
          <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
            {!generalInviteLink ? (
              <>
                <p style={{ margin: 0, fontSize: "14px", color: "var(--text-muted)" }}>
                  Link fixo por unidade — pode divulgar livremente (grupo do WhatsApp, cartaz). Quem abrir preenche os
                  próprios dados, escolhe o PIN e já entra como Estagiário, sem fila de aprovação. Reabrir aqui mostra
                  sempre o mesmo link.
                </p>
                <Select label="Unidade *" value={generalInviteUnitId} onChange={(e) => setGeneralInviteUnitId(e.target.value)}>
                  {units.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </Select>
                {generalInviteError && <p style={{ color: "var(--color-error-text)", margin: 0, fontWeight: "bold" }}>{generalInviteError}</p>}
                <div style={{ display: "flex", gap: "10px", marginTop: "8px" }}>
                  <Button variant="primary" disabled={generalInviteBusy || !generalInviteUnitId} onClick={fetchGeneralInvite} style={{ borderRadius: "9999px", flex: 1 }}>
                    {generalInviteBusy ? "Gerando…" : "Gerar link"}
                  </Button>
                  <Button variant="ghost" onClick={closeGeneralInviteModal}>
                    Cancelar
                  </Button>
                </div>
              </>
            ) : (
              <>
                <p style={{ margin: 0, fontSize: "14px", color: "var(--text-muted)" }}>
                  Não expira e não é de uso único — qualquer pessoa com o link vira Estagiário nesta unidade assim que
                  preencher o cadastro.
                </p>
                <Input label="Link de cadastro" value={generalInviteLink} readOnly onFocus={(e) => e.target.select()} />
                <div style={{ display: "flex", gap: "10px", marginTop: "8px" }}>
                  <Button variant="primary" onClick={copyGeneralInviteLink} style={{ borderRadius: "9999px", flex: 1 }}>
                    <Emoji3D e="📋" /> Copiar link
                  </Button>
                  <Button variant="ghost" onClick={closeGeneralInviteModal}>
                    Fechar
                  </Button>
                </div>
              </>
            )}
          </div>
        </Modal>
      )}

      {showPjInviteModal && (
        <Modal onClose={closePjInviteModal} title={renderEmoji("💼 Link de Auto-Cadastro de Prestador PJ")}>
          <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
            {!pjInviteLink ? (
              <>
                <p style={{ margin: 0, fontSize: "14px", color: "var(--text-muted)" }}>
                  Link fixo por unidade para envio a profissionais parceiros PJ. O formulário solicita Razão Social, CNPJ,
                  dados de pagamento (PIX), aceitação do termo autônomo sem vínculo empregatício e biometria opcional.
                </p>
                <Select label="Unidade *" value={pjInviteUnitId} onChange={(e) => setPjInviteUnitId(e.target.value)}>
                  {units.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </Select>
                {pjInviteError && <p style={{ color: "var(--color-error-text)", margin: 0, fontWeight: "bold" }}>{pjInviteError}</p>}
                <div style={{ display: "flex", gap: "10px", marginTop: "8px" }}>
                  <Button variant="primary" disabled={pjInviteBusy || !pjInviteUnitId} onClick={fetchPjInvite} style={{ borderRadius: "9999px", flex: 1 }}>
                    {pjInviteBusy ? "Gerando…" : "Gerar link PJ"}
                  </Button>
                  <Button variant="ghost" onClick={closePjInviteModal}>
                    Cancelar
                  </Button>
                </div>
              </>
            ) : (
              <>
                <p style={{ margin: 0, fontSize: "14px", color: "var(--text-muted)" }}>
                  Link público de auto-cadastro para Prestador PJ nesta unidade. Pode enviar via WhatsApp ou e-mail.
                </p>
                <Input label="Link de auto-cadastro PJ" value={pjInviteLink} readOnly onFocus={(e) => e.target.select()} />
                <div style={{ display: "flex", gap: "10px", marginTop: "8px" }}>
                  <Button variant="primary" onClick={copyPjInviteLink} style={{ borderRadius: "9999px", flex: 1 }}>
                    <Emoji3D e="📋" /> Copiar link PJ
                  </Button>
                  <Button variant="ghost" onClick={closePjInviteModal}>
                    Fechar
                  </Button>
                </div>
              </>
            )}
          </div>
        </Modal>
      )}

      <div className="g-cards g-cards-wide">
        {employees
          .filter((e) => {
            if (categoryFilter === "CLT") return e.role !== "PRESTADOR_PJ" && e.contract_type !== "PJ";
            if (categoryFilter === "PJ") return e.role === "PRESTADOR_PJ" || e.contract_type === "PJ";
            return true;
          })
          .map((e) => {
            const roleBadgeStyle =
              e.role === "PRESTADOR_PJ" || e.contract_type === "PJ"
                ? { bg: "rgba(16, 185, 129, 0.12)", color: "var(--color-success-text)", label: "💼 Prestador PJ" }
                : e.role === "ADMIN"
                ? { bg: "rgba(124, 58, 237, 0.12)", color: "#6d28d9", label: "👑 Admin" }
                : e.role === "GERENTE"
                ? { bg: "rgba(37, 99, 235, 0.12)", color: "#1d4ed8", label: "⭐ Gerente" }
                : e.role === "ESTAGIARIO"
                ? { bg: "rgba(180, 83, 9, 0.12)", color: "var(--color-amber-text)", label: "🎓 Estagiário" }
                : { bg: "rgba(13, 148, 136, 0.12)", color: "var(--color-teal-text)", label: "👤 Operador" };
          const employeeUnitNames = (e.unitIds ?? []).map((id) => units.find((u) => u.id === id)?.name).filter(Boolean);

          return (
            <Card
              key={e.id}
              style={{
                padding: "16px",
                borderRadius: "16px",
                opacity: e.active === false ? 0.6 : 1,
                border: e.active === false ? "1px dashed var(--border-subtle)" : "1px solid var(--border-subtle)",
                // O menu "⋯ Mais" abre para baixo a partir do rodapé do card — não pode ser cortado.
                overflow: "visible",
              }}
            >
              <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
                  <div
                    style={{
                      width: "42px",
                      height: "42px",
                      borderRadius: "50%",
                      background: roleBadgeStyle.bg,
                      color: roleBadgeStyle.color,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontWeight: "bold",
                      fontSize: "18px",
                      fontFamily: "var(--font-display)",
                    }}
                  >
                    {e.full_name.charAt(0).toUpperCase()}
                  </div>
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                      <strong style={{ fontSize: "16px" }}>{e.full_name}</strong>
                      <span style={{ fontSize: "12px", fontWeight: "bold", padding: "2px 8px", borderRadius: "9999px", background: roleBadgeStyle.bg, color: roleBadgeStyle.color }}>
                        {renderEmoji(roleBadgeStyle.label)}
                      </span>
                      {e.active === false ? <Tag color="var(--text-muted)">Inativo</Tag> : <Tag color="var(--color-teal, #1d9b84)">Ativo</Tag>}
                      {cadastroStatus.get(e.id) ? (
                        <Tag color="var(--color-teal, #1d9b84)"><Emoji3D e="📋" /> Cadastro completo</Tag>
                      ) : (
                        <Tag color="var(--color-warning, var(--color-amber-text))">⚠️ Cadastro pendente</Tag>
                      )}
                    </div>
                    <div style={{ fontSize: "13px", color: "var(--text-muted)", marginTop: "2px" }}>
                      Permissão: {ROLE_LABEL[e.role]}
                      {e.sector ? ` · Setor: ${EMPLOYEE_SECTOR_OPTION_LABEL[e.sector]}` : ""}
                      {e.cpf ? ` · CPF: ${e.cpf}` : ""}
                      {e.phone ? ` · Tel: ${e.phone}` : ""}
                      {e.admission_date ? ` · Admitido: ${dateBrFromIso(e.admission_date)}` : ""}
                    </div>
                    <div style={{ fontSize: "13px", color: "var(--text-secondary)", marginTop: "2px" }}>
                      <Emoji3D e="🗂️" /> {employeeUnitNames.length > 0 ? employeeUnitNames.join(", ") : "sem unidade atribuída"}
                    </div>
                  </div>
                </div>

                <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                  <div style={{ flex: "1 1 140px", minWidth: 0 }}>
                  <Select
                    aria-label={`Nível de acesso de ${e.full_name}`}
                    title={ROLE_DESCRIPTION[e.role]}
                    value={e.role}
                    onChange={(ev) => void changeRole(e, ev.target.value as Employee["role"])}
                    style={{ minWidth: "120px", fontSize: "13px" }}
                  >
                    {ROLE_OPTIONS.map((r) => (
                      <option key={r} value={r}>
                        {ROLE_LABEL[r]}
                      </option>
                    ))}
                  </Select>
                  </div>

                  <div style={{ flex: "1 1 140px", minWidth: 0 }}>
                  <Select
                    aria-label={`Setor de ${e.full_name}`}
                    title="Setor de atuação: identifica a especialidade de quem preenche o Olhar FaçaAmigos e a Avaliação do playground"
                    value={e.sector ?? ""}
                    onChange={(ev) => void changeSector(e, (ev.target.value || null) as EmployeeSector | null)}
                    style={{ minWidth: "120px", fontSize: "13px" }}
                  >
                    <option value="">Sem setor</option>
                    {EMPLOYEE_SECTOR_OPTIONS.map((s) => (
                      <option key={s} value={s}>
                        {EMPLOYEE_SECTOR_OPTION_LABEL[s]}
                      </option>
                    ))}
                  </Select>
                  </div>

                  <div data-more-menu style={{ position: "relative", marginLeft: "auto" }}>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-haspopup="menu"
                      aria-expanded={moreMenuFor === e.id}
                      aria-label={`Mais ações de ${e.full_name}`}
                      title="Unidades, redefinir PIN, ativar/desativar"
                      onClick={() => setMoreMenuFor(moreMenuFor === e.id ? null : e.id)}
                    >
                      ⋯ Mais
                    </Button>
                    {moreMenuFor === e.id && (
                      <div role="menu" className="more-menu">
                        <button type="button" role="menuitem" onClick={() => { setMoreMenuFor(null); openUnitsModal(e); }}>
                          <Emoji3D e="🗂️" /> Unidades
                        </button>
                        <button type="button" role="menuitem" onClick={() => { setMoreMenuFor(null); setResetError(null); setResetPinTarget(e); }}>
                          <Emoji3D e="🔑" /> Redefinir PIN
                        </button>
                        <button type="button" role="menuitem" onClick={() => { setMoreMenuFor(null); toggleActive(e); }}>
                          {e.active === false ? "Reativar acesso" : "Desativar acesso"}
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
