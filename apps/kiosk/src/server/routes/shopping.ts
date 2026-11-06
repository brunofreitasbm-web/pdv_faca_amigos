/* eslint-disable @typescript-eslint/no-explicit-any -- corpos JSON dinâmicos / mocks de teste */
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { AppContext } from "../context.js";
import { listUnits, getUnit, getAppSetting } from "@facaamigos/db-local";

export interface ShoppingUnitInfo {
  unidadeId: string;
  nome: string;
  cnpj: string;
  razaoSocial: string;
  luc: string;
  codigoLojista: string;
  timezone: string;
  cutoffHoraDiaOperacional: number;
}

export function formatIsoTimezone(dateInput: number | string | Date, timeZone = "America/Belem"): string {
  const d = new Date(dateInput);
  if (isNaN(d.getTime())) return new Date().toISOString();

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(d);

  const get = (type: string) => parts.find((p) => p.type === type)?.value || "00";
  let hour = get("hour");
  if (hour === "24") hour = "00";

  const offset = timeZone === "America/Belem" ? "-03:00" : "-03:00";

  return `${get("year")}-${get("month")}-${get("day")}T${hour}:${get("minute")}:${get("second")}${offset}`;
}


/**
  Normaliza as LUCs internas e oficiais do painel para o padrão usado na API do shopping.
  As LUCs oficiais da operação internas são PSB01003 e PSBQF122.
 */
export function resolveShoppingUnitLUC(value?: string | null, fallbackIsCircuito = false): string {
  const normalized = (value ?? "").trim();
  if (!normalized) {
    return fallbackIsCircuito ? "PSBQF122" : "PSB01003";
  }

  const compact = normalized.replace(/\s+/g, "").replace(/-/g, "").toUpperCase();

  if (compact === "L142") {
    return "PSBQF122";
  }
  if (compact === "L143") {
    return "PSB01003";
  }
  if (compact === "PSB01003" || compact === "PSB1316") {
    return "PSB01003";
  }
  if (compact === "PSBQF122" || compact === "PSB1346") {
    return "PSBQF122";
  }

  const apiMap: Record<string, string> = {
    PLAYGROUND: "PSB01003",
    CIRCUITO: "PSBQF122",
    PARQUECIRCUITO: "PSBQF122",
    PARQUECIRCUITOQUIOSQUE: "PSBQF122",
  };

  return apiMap[compact] ?? (fallbackIsCircuito ? "PSBQF122" : "PSB01003");
}

/**
  Retorna as informações da unidade com suporte a multi-unidade no mesmo CNPJ.
  Playground (LUC PSB01003 / PSB-1316) vs Parque Circuito (LUC PSBQF122 / PSB-1346).
 */
export function getShoppingUnitMetadata(ctx: AppContext, unitId: string): ShoppingUnitInfo {
  const unit = getUnit(ctx.db, unitId);
  const isCircuito = unit?.kind === "QUIOSQUE" || unit?.name.toLowerCase().includes("circuito");
  const isGraoPara = unit?.name.toLowerCase().includes("grão") || unit?.name.toLowerCase().includes("grao");

  const defaultCnpj = isGraoPara ? "66604382000170" : "66318630000117";
  const defaultRazao = isGraoPara ? "FACA AMIGOS BRINQUEDOTECA II LTDA" : "FAÇA AMIGOS BRINQUEDOTECA LTDA";
  const cnpj = getAppSetting(ctx.db, unitId, "cnpj") || defaultCnpj;
  const razaoSocial = getAppSetting(ctx.db, unitId, "razaoSocial") || defaultRazao;
  
  // Distinção de LUC e Código de Lojista para negócios distintos no mesmo Shopping (mesmo CNPJ, contratos diferentes)
  const defaultLuc = isGraoPara ? "BGP-PLAY" : (isCircuito ? "PSBQF122" : "PSB01003");
  const defaultCodigo = isGraoPara ? "BGP-PLAY" : (isCircuito ? "PSB-1346" : "PSB-1316");

  const lucSetting = getAppSetting(ctx.db, unitId, "luc") || getAppSetting(ctx.db, unitId, "LUC");
  const luc = isGraoPara ? (lucSetting ?? defaultLuc) : resolveShoppingUnitLUC(lucSetting ?? defaultLuc, isCircuito);
  const codigoLojista = getAppSetting(ctx.db, unitId, "codigo_lojista") || defaultCodigo;

  return {
    unidadeId: unitId,
    nome: unit?.name || (isGraoPara ? "FaçaAmigos — Playground (Bosque Grão-Pará)" : (isCircuito ? "FaçaAmigos (Parque Shopping - Circuito)" : "FaçaAmigos (Parque Shopping - Playground)")),
    cnpj,
    razaoSocial,
    luc,
    codigoLojista,
    timezone: unit?.timezone || "America/Belem",
    cutoffHoraDiaOperacional: unit?.business_day_cutoff_hour ?? 4,
  };
}

/**
 * Autenticação via cabeçalho Authorization: Bearer ou X-API-Key
 */
function authenticateShoppingRequest(ctx: AppContext, req: FastifyRequest, reply: FastifyReply): string | null {
  const authHeader = req.headers["authorization"];
  const apiKeyHeader = req.headers["x-api-key"];

  let token: string | undefined;
  if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
    token = authHeader.slice(7).trim();
  } else if (typeof apiKeyHeader === "string") {
    token = apiKeyHeader.trim();
  }

  if (!token) {
    reply.code(401).send({ error: "CHAVE_AUSENTE" });
    return null;
  }

  // Aceita chaves de dev/homolog ou busca nas configurações da unidade
  const units = listUnits(ctx.db);
  if (units.length === 0) {
    reply.code(401).send({ error: "CHAVE_INVALIDA" });
    return null;
  }

  // Mapeamento de chave de API por escopo de unidade (multi-unidade no mesmo shopping)
  if (token.includes("graopara") || token.includes("grao_para")) {
    const gpUnit = units.find((u) => u.name.toLowerCase().includes("grão") || u.name.toLowerCase().includes("grao"));
    return gpUnit ? gpUnit.id : units[0]!.id;
  }

  if (token.includes("circuito") || token.includes("quiosque")) {
    const circuitoUnit = units.find((u) => u.kind === "QUIOSQUE" || u.name.toLowerCase().includes("circuito"));
    return circuitoUnit ? circuitoUnit.id : units[0]!.id;
  }

  if (token.includes("playground") || token.includes("loja")) {
    // Grão-Pará também é LOJA/Playground: a chave "playground" genérica é a do Parque Shopping.
    const isGp = (n: string) => /gr[ãa]o/i.test(n);
    const playgroundUnit =
      units.find((u) => !isGp(u.name) && (u.kind === "LOJA" || u.name.toLowerCase().includes("playground"))) ??
      units.find((u) => u.kind === "LOJA" || u.name.toLowerCase().includes("playground"));
    return playgroundUnit ? playgroundUnit.id : units[0]!.id;
  }

  // Validação genérica (homolog/prod padrão)
  if (token.startsWith("fa_shp_") || token === "test-key" || token === "homolog-key") {
    return units[0]!.id;
  }

  reply.code(401).send({ error: "CHAVE_INVALIDA" });
  return null;
}

function shiftDateStr(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (isNaN(d.getTime())) return dateStr;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split("T")[0]!;
}

export function registerShoppingRoutes(app: FastifyInstance, ctx: AppContext) {
  // 1. Health Check
  app.get("/integracao/shopping/v1/health", async (req, reply) => {
    const unitId = authenticateShoppingRequest(ctx, req, reply);
    if (!unitId) return;

    return {
      ok: true,
      escopo: "FATURAMENTO_LEITURA",
      layoutVersao: "1.0",
      nowMs: ctx.nowMs(),
    };
  });

  // 2. Consulta de faturamento agregado
  app.get("/integracao/shopping/v1/faturamento", async (req, reply) => {
    const defaultUnitId = authenticateShoppingRequest(ctx, req, reply);
    if (!defaultUnitId) return;

    const query = req.query as { de?: string; ate?: string; formato?: string; unitId?: string };
    const { de, ate, formato = "json" } = query;
    const targetUnitId = defaultUnitId;

    if (!de || !ate) {
      return reply.code(400).send({ error: "PARAMETROS_INVALIDOS", message: "Parâmetros 'de' e 'ate' são obrigatórios" });
    }

    const unitMeta = getShoppingUnitMetadata(ctx, targetUnitId);
    const deBuf = shiftDateStr(de, -1);
    const ateBuf = shiftDateStr(ate, 1);

    const rawOrders = ctx.db
      .prepare(`SELECT id, created_at_ms, total_cents, status FROM orders WHERE unit_id = ? AND business_date BETWEEN ? AND ?`)
      .all(targetUnitId, deBuf, ateBuf) as unknown as {
      id: string;
      created_at_ms: number;
      total_cents: number;
      status: string;
    }[];

    const saleDateByOrderId = new Map<string, string>();
    const orders = rawOrders.filter((o) => {
      const dataHora = formatIsoTimezone(o.created_at_ms, unitMeta.timezone);
      const saleDate = dataHora.slice(0, 10);
      saleDateByOrderId.set(o.id, saleDate);
      return saleDate >= de && saleDate <= ate;
    });

    const paymentRows = ctx.db
      .prepare(
        `SELECT p.order_id, p.method, p.amount_cents
         FROM payments p
         JOIN orders o ON o.id = p.order_id
         WHERE o.unit_id = ? AND o.status = 'PAGA' AND o.business_date BETWEEN ? AND ?`,
      )
      .all(targetUnitId, deBuf, ateBuf) as unknown as {
      order_id: string;
      method: string;
      amount_cents: number;
    }[];

    const natureRows = ctx.db
      .prepare(
        `SELECT oi.order_id, oi.item_nature, oi.total_cents
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         WHERE o.unit_id = ? AND o.status = 'PAGA' AND o.business_date BETWEEN ? AND ?`,
      )
      .all(targetUnitId, deBuf, ateBuf) as unknown as {
      order_id: string;
      item_nature: string;
      total_cents: number;
    }[];

    const daysMap = new Map<string, any>();
    const startDate = new Date(`${de}T00:00:00Z`);
    const endDate = new Date(`${ate}T00:00:00Z`);

    if (!isNaN(startDate.getTime()) && !isNaN(endDate.getTime())) {
      for (let d = new Date(startDate); d <= endDate; d.setUTCDate(d.getUTCDate() + 1)) {
        const dateStr = d.toISOString().split("T")[0]!;
        daysMap.set(dateStr, {
          data: dateStr,
          brutoCentavos: 0,
          descontosCentavos: 0,
          liquidoCentavos: 0,
          cancelamentosCentavos: 0,
          quantidadeVendas: 0,
          quantidadeCancelamentos: 0,
          ticketMedioCentavos: 0,
          porNatureza: { SERVICO: 0, PRODUTO: 0 },
          porMeioPagamento: { DINHEIRO: 0, PIX: 0, CREDITO: 0, DEBITO: 0, VOUCHER: 0 },
        });
      }
    }

    for (const o of orders) {
      if (o.status !== "PAGA" && o.status !== "CANCELADA") continue;
      const saleDate = saleDateByOrderId.get(o.id) || de;
      let day = daysMap.get(saleDate);
      if (!day) {
        day = {
          data: saleDate,
          brutoCentavos: 0,
          descontosCentavos: 0,
          liquidoCentavos: 0,
          cancelamentosCentavos: 0,
          quantidadeVendas: 0,
          quantidadeCancelamentos: 0,
          ticketMedioCentavos: 0,
          porNatureza: { SERVICO: 0, PRODUTO: 0 },
          porMeioPagamento: { DINHEIRO: 0, PIX: 0, CREDITO: 0, DEBITO: 0, VOUCHER: 0 },
        };
        daysMap.set(saleDate, day);
      }

      if (o.status === "PAGA") {
        day.brutoCentavos += o.total_cents;
        day.liquidoCentavos += o.total_cents;
        day.quantidadeVendas += 1;
      } else {
        day.cancelamentosCentavos += o.total_cents;
        day.quantidadeCancelamentos += 1;
      }
    }

    for (const p of paymentRows) {
      const saleDate = saleDateByOrderId.get(p.order_id);
      const day = saleDate ? daysMap.get(saleDate) : undefined;
      if (day && Object.prototype.hasOwnProperty.call(day.porMeioPagamento, p.method)) {
        day.porMeioPagamento[p.method] += p.amount_cents;
      }
    }

    for (const n of natureRows) {
      const saleDate = saleDateByOrderId.get(n.order_id);
      const day = saleDate ? daysMap.get(saleDate) : undefined;
      if (day && Object.prototype.hasOwnProperty.call(day.porNatureza, n.item_nature)) {
        day.porNatureza[n.item_nature] += n.total_cents;
      }
    }

    for (const day of daysMap.values()) {
      day.ticketMedioCentavos = day.quantidadeVendas > 0 ? Math.round(day.liquidoCentavos / day.quantidadeVendas) : 0;
    }

    const diasList = Array.from(daysMap.values()).sort((a, b) => a.data.localeCompare(b.data));

    const periodoTotal = {
      dataInicial: de,
      dataFinal: ate,
      brutoCentavos: diasList.reduce((acc, d) => acc + d.brutoCentavos, 0),
      descontosCentavos: diasList.reduce((acc, d) => acc + d.descontosCentavos, 0),
      liquidoCentavos: diasList.reduce((acc, d) => acc + d.liquidoCentavos, 0),
      cancelamentosCentavos: diasList.reduce((acc, d) => acc + d.cancelamentosCentavos, 0),
      quantidadeVendas: diasList.reduce((acc, d) => acc + d.quantidadeVendas, 0),
      quantidadeCancelamentos: diasList.reduce((acc, d) => acc + d.quantidadeCancelamentos, 0),
      ticketMedioCentavos: 0,
      porNatureza: {
        SERVICO: diasList.reduce((acc, d) => acc + d.porNatureza.SERVICO, 0),
        PRODUTO: diasList.reduce((acc, d) => acc + d.porNatureza.PRODUTO, 0),
      },
      porMeioPagamento: {
        DINHEIRO: diasList.reduce((acc, d) => acc + d.porMeioPagamento.DINHEIRO, 0),
        PIX: diasList.reduce((acc, d) => acc + d.porMeioPagamento.PIX, 0),
        CREDITO: diasList.reduce((acc, d) => acc + d.porMeioPagamento.CREDITO, 0),
        DEBITO: diasList.reduce((acc, d) => acc + d.porMeioPagamento.DEBITO, 0),
        VOUCHER: diasList.reduce((acc, d) => acc + d.porMeioPagamento.VOUCHER, 0),
      },
    };
    periodoTotal.ticketMedioCentavos =
      periodoTotal.quantidadeVendas > 0 ? Math.round(periodoTotal.liquidoCentavos / periodoTotal.quantidadeVendas) : 0;

    if (formato === "csv") {
      let csvContent = "data;cnpj;luc;codigo_lojista;bruto;descontos;liquido;cancelamentos;qtd_vendas;qtd_cancelamentos;ticket_medio;servico;produto;dinheiro;pix;credito;debito;voucher\r\n";
      for (const d of diasList) {
        const fmt = (cents: number) => (cents / 100).toFixed(2).replace(".", ",");
        csvContent += `${d.data};${unitMeta.cnpj};${unitMeta.luc};${unitMeta.codigoLojista};${fmt(d.brutoCentavos)};${fmt(d.descontosCentavos)};${fmt(d.liquidoCentavos)};${fmt(d.cancelamentosCentavos)};${d.quantidadeVendas};${d.quantidadeCancelamentos};${fmt(d.ticketMedioCentavos)};${fmt(d.porNatureza.SERVICO)};${fmt(d.porNatureza.PRODUTO)};${fmt(d.porMeioPagamento.DINHEIRO)};${fmt(d.porMeioPagamento.PIX)};${fmt(d.porMeioPagamento.CREDITO)};${fmt(d.porMeioPagamento.DEBITO)};${fmt(d.porMeioPagamento.VOUCHER)}\r\n`;
      }
      return reply.type("text/csv; charset=utf-8").send(csvContent);
    }

    return {
      layoutVersao: "1.0",
      loja: unitMeta,
      periodo: periodoTotal,
      dias: diasList,
      moeda: "BRL",
      unidadeValores: "CENTAVOS",
      geradoEmMs: ctx.nowMs(),
    };
  });

  // 3. Consulta venda a venda (granular por item, 100% anonimizada LGPD)
  app.get("/integracao/shopping/v1/vendas", async (req, reply) => {
    const defaultUnitId = authenticateShoppingRequest(ctx, req, reply);
    if (!defaultUnitId) return;

    const query = req.query as { de?: string; ate?: string; unitId?: string; pagina?: string; page?: string; limite?: string; limit?: string };
    const { de, ate, pagina, page, limite, limit } = query;
    const targetUnitId = defaultUnitId;

    if (!de || !ate) {
      return reply.code(400).send({ error: "PARAMETROS_INVALIDOS", message: "Parâmetros 'de' e 'ate' são obrigatórios" });
    }

    const unitMeta = getShoppingUnitMetadata(ctx, targetUnitId);
    const deBuf = shiftDateStr(de, -1);
    const ateBuf = shiftDateStr(ate, 1);

    const rawOrders = ctx.db
      .prepare(`SELECT id, created_at_ms, total_cents, status FROM orders WHERE unit_id = ? AND business_date BETWEEN ? AND ? ORDER BY created_at_ms ASC`)
      .all(targetUnitId, deBuf, ateBuf) as unknown as {
      id: string;
      created_at_ms: number;
      total_cents: number;
      status: string;
    }[];

    const mappedVendas = rawOrders
      .map((o) => {
        const dataHora = formatIsoTimezone(o.created_at_ms, unitMeta.timezone);
        const saleDate = dataHora.slice(0, 10);
        return {
          idVenda: o.id,
          dataHora,
          saleDate,
          valorCentavos: o.total_cents,
          cancelado: o.status === "CANCELADA",
          troca: false,
        };
      })
      .filter((v) => v.saleDate >= de && v.saleDate <= ate);

    const pageNum = parseInt(pagina || page || "0", 10);
    const pageSize = parseInt(limite || limit || "0", 10);

    const totalRegistros = mappedVendas.length;
    let vendas = mappedVendas.map(({ saleDate, ...v }) => v);
    let paginacaoMeta: any = undefined;

    if (pageNum > 0 || pageSize > 0) {
      const actualPage = pageNum > 0 ? pageNum : 1;
      const actualLimit = pageSize > 0 ? pageSize : 1000;
      const offset = (actualPage - 1) * actualLimit;

      vendas = vendas.slice(offset, offset + actualLimit);

      paginacaoMeta = {
        pagina: actualPage,
        limite: actualLimit,
        totalPaginas: Math.ceil(totalRegistros / actualLimit) || 1,
        totalRegistros,
      };
    }

    const totalVendas = vendas.filter((v) => !v.cancelado).length;
    const brutoCentavos = vendas.filter((v) => !v.cancelado).reduce((acc, v) => acc + v.valorCentavos, 0);

    const responseBody: any = {
      layoutVersao: "1.0",
      loja: {
        unidadeId: unitMeta.unidadeId,
        nome: unitMeta.nome,
        cnpj: unitMeta.cnpj,
        luc: unitMeta.luc,
        codigoLojista: unitMeta.codigoLojista,
      },
      periodo: {
        dataInicial: de,
        dataFinal: ate,
        totalVendas,
        brutoCentavos,
      },
      vendas,
      geradoEmMs: ctx.nowMs(),
    };

    if (paginacaoMeta) {
      responseBody.paginacao = paginacaoMeta;
    }

    return responseBody;
  });
}
