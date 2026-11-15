import { useEffect, useState } from "react";
import { Button, Input, Select } from "@facaamigos/ui";
import { Card, FORM_GRID, FULL_ROW } from "../GCard.js";
import { Api, isWifiClinicCoupon } from "../../../api/client.js";
import type { Coupon, Plan } from "../../../api/client.js";
import { useAppState } from "../../../state/AppState.js";
import { useToast } from "../../../state/ToastContext.js";
import { UnitCheckboxGroup } from "../UnitCheckboxGroup.js";
import { Emoji3D } from "../../../components/Emoji3D.js";

function planLabel(p: Plan): string {
  const duration = p.durationUnit === "HORA" ? `${p.durationValue}h` : `${p.durationValue}min`;
  return `${p.name} (${duration})`;
}

const WEEKDAYS: { iso: number; label: string }[] = [
  { iso: 1, label: "Seg" },
  { iso: 2, label: "Ter" },
  { iso: 3, label: "Qua" },
  { iso: 4, label: "Qui" },
  { iso: 5, label: "Sex" },
  { iso: 6, label: "Sáb" },
  { iso: 7, label: "Dom" },
];

function scheduleLabel(c: Coupon): string | null {
  const days = c.scheduleDays ?? [];
  const hasTime = c.scheduleStart && c.scheduleEnd;
  if (days.length === 0 && !hasTime) return null;
  const isWeek = days.length === 5 && [1, 2, 3, 4, 5].every((d) => days.includes(d));
  const dayText = days.length === 0 ? "todos os dias" : isWeek ? "seg a sex" : WEEKDAYS.filter((w) => days.includes(w.iso)).map((w) => w.label).join(", ");
  return hasTime ? `${dayText}, ${c.scheduleStart}–${c.scheduleEnd}` : dayText;
}

export function CuponsTab() {
  const toast = useToast();
  const { units } = useAppState();

  const [coupons, setCoupons] = useState<Coupon[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);

  const [code, setCode] = useState("");
  const [kind, setKind] = useState<Coupon["kind"]>("MINUTOS_EXTRA");
  const [value, setValue] = useState("10");
  const [description, setDescription] = useState("");
  const [unitIds, setUnitIds] = useState<string[]>(units.map((u) => u.id));
  const [allowedPlanId, setAllowedPlanId] = useState("");
  const [busy, setBusy] = useState(false);
  const [limitSchedule, setLimitSchedule] = useState(false);
  const [scheduleDays, setScheduleDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [scheduleStart, setScheduleStart] = useState("14:00");
  const [scheduleEnd, setScheduleEnd] = useState("17:00");

  function load() {
    Api.couponsAllUnits().then((list) => setCoupons(list.filter((c) => !isWifiClinicCoupon(c.code))));
    Api.plansAllUnits().then(setPlans);
  }
  useEffect(load, []);
  useEffect(() => setUnitIds(units.map((u) => u.id)), [units]);

  // Restringir a um plano só faz sentido quando dá para saber a que unidade
  // o cupom pertence — na edição (uma unidade só) ou na criação quando o
  // operador restringiu a seleção a uma única unidade.
  const planRestrictionUnitId = editingId
    ? coupons.find((c) => c.id === editingId)?.unitId
    : unitIds.length === 1
      ? unitIds[0]
      : undefined;
  const plansForRestriction = plans.filter((p) => p.unitId === planRestrictionUnitId);

  function startEdit(c: Coupon) {
    setEditingId(c.id);
    setCode(c.code);
    setKind(c.kind);
    setValue(String(c.value));
    setDescription(c.description ?? "");
    setAllowedPlanId(c.allowedPlanId ?? "");
    const has = Boolean((c.scheduleDays && c.scheduleDays.length) || (c.scheduleStart && c.scheduleEnd));
    setLimitSchedule(has);
    setScheduleDays(c.scheduleDays?.length ? c.scheduleDays : [1, 2, 3, 4, 5]);
    setScheduleStart(c.scheduleStart ?? "14:00");
    setScheduleEnd(c.scheduleEnd ?? "17:00");
  }

  function cancelEdit() {
    setEditingId(null);
    setCode("");
    setKind("MINUTOS_EXTRA");
    setValue("10");
    setDescription("");
    setUnitIds(units.map((u) => u.id));
    setAllowedPlanId("");
    setLimitSchedule(false);
    setScheduleDays([1, 2, 3, 4, 5]);
    setScheduleStart("14:00");
    setScheduleEnd("17:00");
  }

  async function save() {
    setBusy(true);
    try {
      const payload = {
        code,
        kind,
        value: Number(value),
        description: description || undefined,
        allowedPlanId: planRestrictionUnitId ? allowedPlanId || null : null,
        scheduleDays: limitSchedule ? scheduleDays : null,
        scheduleStart: limitSchedule ? scheduleStart : null,
        scheduleEnd: limitSchedule ? scheduleEnd : null,
      };

      if (editingId) {
        await Api.updateCoupon(editingId, payload);
        toast.success("Cupom atualizado.");
      } else {
        await Promise.all(unitIds.map((unitId) => Api.createCoupon({ unitId, ...payload })));
        toast.success(`Cupom criado em ${unitIds.length} unidade(s).`);
      }
      cancelEdit();
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Não foi possível salvar o cupom.");
    } finally {
      setBusy(false);
    }
  }

  async function handleToggleActive(c: Coupon) {
    if (!window.confirm(`Deseja realmente ${c.active ? "inativar/excluir" : "reativar"} o cupom "${c.code}"?`)) return;
    try {
      await Api.setCouponActive(c.id, !c.active);
      toast.success(c.active ? "Cupom removido com sucesso." : "Cupom reativado.");
      load();
    } catch {
      toast.error("Não foi possível alterar o cupom.");
    }
  }

  const reviewCoupons = coupons.filter((c) => c.description === "10% desconto - 5 Avaliação Google");
  const totalReviewIssued = reviewCoupons.length;

  return (
    <div className="g-split">
      <aside>
      <Card style={{ marginBottom: "10px", background: "var(--surface-sunken)", borderLeft: "4px solid var(--color-primary)", borderRadius: "12px" }}>
        <h3 style={{ fontSize: "16px", margin: "0 0 8px 0", color: "var(--text-primary)" }}><Emoji3D e="⭐" /> Desempenho: Avaliações do Google</h3>
        <p style={{ margin: 0, fontSize: "14px", color: "var(--text-secondary)" }}>
          <strong>{totalReviewIssued}</strong> descontos (cupons) emitidos
        </p>
      </Card>

      <Card bodyStyle={FORM_GRID}>
        <div style={{ ...FULL_ROW, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2 style={{ fontFamily: "var(--font-display)", fontSize: "16px", margin: 0 }}>
            {editingId ? "Editar cupom" : "Novo cupom"}
          </h2>
          {editingId && (
            <Button variant="secondary" onClick={cancelEdit} disabled={busy}>
              Cancelar Edição
            </Button>
          )}
        </div>
        <Input label="Código" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} />
        <Select label="Tipo" value={kind} onChange={(e) => setKind(e.target.value as Coupon["kind"])}>
          <option value="MINUTOS_EXTRA">Minutos extras</option>
          <option value="DESCONTO_PCT">Desconto %</option>
          <option value="DESCONTO_VALOR">Desconto em R$</option>
        </Select>
        <Input label="Valor" type="number" value={value} onChange={(e) => setValue(e.target.value)} />
        <Input label="Descrição" value={description} onChange={(e) => setDescription(e.target.value)} />
        {!editingId && <div style={FULL_ROW}><UnitCheckboxGroup units={units} selected={unitIds} onChange={setUnitIds} /></div>}
        {planRestrictionUnitId ? (
          <Select label="Restringir a um plano" value={allowedPlanId} onChange={(e) => setAllowedPlanId(e.target.value)}>
            <option value="">Vale para todos os planos da unidade</option>
            {plansForRestriction.map((p) => (
              <option key={p.id} value={p.id}>
                {planLabel(p)}
              </option>
            ))}
          </Select>
        ) : (
          !editingId && unitIds.length > 1 && (
            <p style={{ ...FULL_ROW, fontSize: "12px", color: "var(--text-muted)", margin: 0 }}>
              Restrição de plano só pode ser definida ao criar o cupom em uma única unidade.
            </p>
          )
        )}
        <label style={{ ...FULL_ROW, display: "flex", alignItems: "center", gap: "8px", fontSize: "14px" }}>
          <input type="checkbox" checked={limitSchedule} onChange={(e) => setLimitSchedule(e.target.checked)} />
          Limitar a dias e horários específicos
        </label>
        {limitSchedule && (
          <div style={{ ...FULL_ROW, display: "flex", flexDirection: "column", gap: "8px" }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
              {WEEKDAYS.map((w) => {
                const on = scheduleDays.includes(w.iso);
                return (
                  <Button
                    key={w.iso}
                    variant={on ? "primary" : "secondary"}
                    onClick={() => setScheduleDays(on ? scheduleDays.filter((d) => d !== w.iso) : [...scheduleDays, w.iso].sort())}
                  >
                    {w.label}
                  </Button>
                );
              })}
            </div>
            <div style={{ display: "flex", gap: "12px" }}>
              <Input label="Início" type="time" value={scheduleStart} onChange={(e) => setScheduleStart(e.target.value)} />
              <Input label="Fim" type="time" value={scheduleEnd} onChange={(e) => setScheduleEnd(e.target.value)} />
            </div>
            <p style={{ fontSize: "12px", color: "var(--text-muted)", margin: 0 }}>
              Valem as unidades marcadas acima. Fora desse dia/horário o cupom não aparece nem é aceito.
            </p>
          </div>
        )}
        <Button variant="primary" style={{ ...FULL_ROW, justifySelf: "start" }} disabled={busy || !code || (limitSchedule && (!scheduleStart || !scheduleEnd || scheduleDays.length === 0)) || (!editingId && unitIds.length === 0)} onClick={save}>
          {editingId ? "Salvar cupom" : `Criar cupom em ${unitIds.length} unidade(s)`}
        </Button>
      </Card>
      </aside>
      <div className="g-cards">
      {coupons.map((c) => (
        <Card key={c.id} style={{ display: "flex", flexDirection: "column", alignItems: "stretch", gap: "6px", opacity: c.active ? 1 : 0.5 }}>
          <span>
            <strong>{c.code}</strong> — {c.kind} ({c.value}) — usado {c.used_count}× {c.description ? `— ${c.description}` : ""}
            <span style={{ fontSize: "12px", color: "var(--text-muted)" }}> · {units.find((u) => u.id === c.unitId)?.name ?? "—"}</span>
            {c.allowedPlanId && (
              <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>
                {" "}
                · só no plano {planLabel(plans.find((p) => p.id === c.allowedPlanId) ?? ({ name: "?", durationValue: 0, durationUnit: "MINUTO" } as Plan))}
              </span>
            )}
            {scheduleLabel(c) && (
              <span style={{ fontSize: "12px", color: "var(--text-muted)" }}> · <Emoji3D e="⏰" /> {scheduleLabel(c)}</span>
            )}
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: "8px", justifyContent: "flex-end" }}>
            <Button variant="secondary" onClick={() => startEdit(c)} disabled={busy}>
              Editar
            </Button>
            {c.active ? (
              <Button variant="secondary" style={{ color: "var(--color-error-text)", borderColor: "var(--color-error)" }} onClick={() => handleToggleActive(c)} disabled={busy}>
                Excluir
              </Button>
            ) : (
              <Button variant="secondary" onClick={() => handleToggleActive(c)} disabled={busy}>
                Reativar
              </Button>
            )}
          </span>
        </Card>
      ))}
      </div>
    </div>
  );
}
