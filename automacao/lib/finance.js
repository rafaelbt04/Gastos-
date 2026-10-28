// ============================================================================
// Motor financeiro do Cofrinho — funções puras, sem DOM.
//
// REGRAS DE CONTABILIZAÇÃO
// R1  Compra no cartão = gasto na data da compra. O pagamento da fatura na conta
//     é "Entre contas" (kind interna) e nunca vira gasto de novo.
// R2  Assinaturas, contas fixas e parcelas geram PREVISÕES. Uma previsão é
//     "conciliada" quando existe um gasto do mesmo mês com a mesma loja e valor
//     próximo; aí ela conta só como gasto realizado, nunca duas vezes.
// R3  Parcela compromete só o valor da parcela no mês dela, nunca o total.
// R4  Cada compromisso do mês tem um estado: lançado (já no extrato), a vencer
//     (data futura) ou sem lançamento (data passou e não achamos no extrato —
//     contado como pendente por segurança).
// R5  Investimentos (kind investimento) e caixinhas ficam fora dos gastos.
// R6  Limite do cartão nunca é dinheiro. "Disponível" usa só saldo em conta e
//     caixinhas livres informadas, menos o que vence antes do próximo salário.
// R7  Salário só entra no disponível depois da data de recebimento.
// R8  Assinatura anual/semestral/trimestral tem dois números: custo mensal
//     equivalente (para planejar) e cobrança real do mês (para o caixa).
// ============================================================================

const BUCKETS = [
  { id: "essenciais", nome: "Essenciais", desc: "mercado, alimentação, transporte, moradia, contas e saúde" },
  { id: "dividas", nome: "Dívidas e parcelas", desc: "parcelas e pagamentos de dívidas" },
  { id: "assinaturas", nome: "Assinaturas", desc: "serviços recorrentes" },
  { id: "lazer", nome: "Lazer e pessoais", desc: "saídas, compras, presentes e o resto" },
  { id: "reserva", nome: "Reserva de emergência", desc: "dinheiro para imprevistos" },
  { id: "investimentos", nome: "Investimentos", desc: "carteira de longo prazo" }
];
const GASTO_BUCKETS = ["essenciais", "dividas", "assinaturas", "lazer"];
const DEFAULT_GROUP = {
  "Alimentação": "essenciais", "Conveniência e mercado": "essenciais", "Transporte": "essenciais", "Casa e contas": "essenciais",
  "Saúde": "essenciais", "Educação": "essenciais", "Apps e assinaturas": "assinaturas",
  "Pix para pessoas": "lazer", "Compras online": "lazer", "Lazer": "lazer", "Outros gastos": "lazer"
};
const FREQ = { mensal: 1, trimestral: 3, semestral: 6, anual: 12 };
const FREQ_LABEL = { mensal: "mensal", trimestral: "trimestral", semestral: "semestral", anual: "anual" };

// ---------- datas (strings YYYY-MM-DD / YYYY-MM) ----------
const ymOf = d => String(d).slice(0, 7);
function addMonths(ym, n) { let [y, m] = ym.split("-").map(Number); m += n; y += Math.floor((m - 1) / 12); m = ((m - 1) % 12 + 12) % 12 + 1; return y + "-" + String(m).padStart(2, "0"); }
function monthsBetween(a, b) { const [ya, ma] = a.split("-").map(Number), [yb, mb] = b.split("-").map(Number); return (yb - ya) * 12 + (mb - ma); }
function daysInYM(ym) { const [y, m] = ym.split("-").map(Number); return new Date(y, m, 0).getDate(); }
function dateIn(ym, day) { return ym + "-" + String(Math.min(Math.max(1, +day || 1), daysInYM(ym))).padStart(2, "0"); }
function addDays(d, n) { const x = new Date(d + "T12:00:00"); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); }
function daysBetween(a, b) { return Math.round((new Date(b + "T12:00:00") - new Date(a + "T12:00:00")) / 864e5); }
const r2 = v => Math.round((v + Number.EPSILON) * 100) / 100;
const sum = (arr, f = x => x) => arr.reduce((a, x) => a + (f(x) || 0), 0);

// ---------- dados com padrões seguros ----------
function perfilOf(st) {
  const p = st.perfil || {};
  return {
    salario: p.salario || null,                 // {valor, dia, chave}
    extras: p.extras || [],                     // [{id,nome,valor,tipo:'mensal'|'pontual',mes,ativa}]
    saldoConta: p.saldoConta || null,           // {valor, data, fonte}
    caixinhasLivres: p.caixinhasLivres || null, // {valor, data}
    reserva: p.reserva || null,                 // {valor, data}
    metaReservaMeses: p.metaReservaMeses ?? 6,
    cartao: p.cartao || null,                   // {nome, fechamento, vencimento}
    colchao: p.colchao ?? 0,
    guardarPct: p.guardarPct ?? 40,
    reservaPctDoGuardar: p.reservaPctDoGuardar ?? 70,
    grupos: p.grupos || {},
    tetos: p.tetos || {}                        // {lazer, reserva, investimentos} valores personalizados
  };
}
function groupOf(cat, perfil) { return (perfil.grupos || {})[cat] || DEFAULT_GROUP[cat] || "lazer"; }
const ativos = list => (list || []).filter(x => (x.status || "ativa") === "ativa");

// ---------- ocorrências de compromissos num mês ----------
function subOcc(s, ym) {
  if ((s.status || "ativa") !== "ativa" || !s.proxima || !(s.valor > 0)) return null;
  const f = FREQ[s.freq] || 1, diff = monthsBetween(ymOf(s.proxima), ym);
  if (((diff % f) + f) % f !== 0) return null;
  const date = dateIn(ym, +s.proxima.slice(8));
  if (s.inicio && date < s.inicio) return null;
  if (s.fim && date > s.fim) return null;
  return { tipo: "assinatura", ref: s, id: "a:" + s.id + ":" + ym, nome: s.nome, date, valor: +s.valor, forma: s.pagamento || "cartao", cat: s.cat || "Apps e assinaturas", grupo: "assinaturas" };
}
function parcelaValor(p, k) { const v = +p.valorParcela || (+p.total / +p.n); return k === +p.n && +p.total > 0 ? r2(+p.total - r2(v) * (p.n - 1)) : r2(v); }
function parcelaNum(p, ym) { return +p.atual + monthsBetween(ymOf(p.proxima), ym); }
function parcOcc(p, ym) {
  if (!p.proxima || !(+p.n > 0)) return null;
  const k = parcelaNum(p, ym);
  if (k < 1 || k > +p.n) return null;
  return { tipo: "parcela", ref: p, id: "p:" + p.id + ":" + ym, nome: p.desc, k, n: +p.n, date: dateIn(ym, +p.proxima.slice(8)), valor: parcelaValor(p, k), forma: p.pagamento || "cartao", cat: p.cat || "Compras online", grupo: "dividas" };
}
function fixaOcc(f, ym) {
  if ((f.status || "ativa") !== "ativa" || !(f.valor > 0)) return null;
  const date = dateIn(ym, f.dia || 10);
  if (f.inicio && ymOf(f.inicio) > ym) return null;
  if (f.fim && ymOf(f.fim) < ym) return null;
  return { tipo: "fixa", ref: f, id: "f:" + f.id + ":" + ym, nome: f.nome, date, valor: +f.valor, forma: f.pagamento || "conta", cat: f.cat || "Casa e contas", grupo: f.grupo || "essenciais", variavel: !!f.variavel };
}
function occurrences(st, ym) {
  const out = [];
  for (const f of st.fixas || []) { const o = fixaOcc(f, ym); if (o) out.push(o); }
  for (const s of st.assinaturas || []) { const o = subOcc(s, ym); if (o) out.push(o); }
  for (const p of st.parcelas || []) { if (parcelaCancelada(st, p)) continue; const o = parcOcc(p, ym); if (o) out.push(o); }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

// ---------- conciliação com o extrato (R2) ----------
function nameHit(o, t) {
  const ref = o.ref;
  if (ref.chave && t.key === ref.chave) return true;
  const nn = norm(ref.nome || ref.desc || "");
  if (nn.length < 4) return false;
  const hay = norm(t.merchant + " " + t.memo);
  return hay.includes(nn) || nn.split(" ").filter(w => w.length >= 5).some(w => hay.includes(w));
}
function amountOk(o, v) { const tol = o.tipo === "fixa" ? Math.max(5, o.valor * 0.25) : Math.max(1, o.valor * 0.08); return Math.abs(v - o.valor) <= tol; }
// Devolve {occ:[...com status e txId], byTx: Map(txId -> occ)}
function reconcile(st, ym, today) {
  const occ = occurrences(st, ym).map(o => ({ ...o }));
  const txs = (st.tx || []).filter(t => t.kind === "gasto" && t.amount < 0 && t.date.startsWith(ym));
  const used = new Set(), byTx = new Map();
  // parcelas primeiro (o número k/n no texto é a pista mais forte), depois assinaturas, depois fixas
  const order = { parcela: 0, assinatura: 1, fixa: 2 };
  for (const o of occ.slice().sort((a, b) => order[a.tipo] - order[b.tipo])) {
    let best = null, bestScore = -1;
    for (const t of txs) {
      if (used.has(t.id) || !nameHit(o, t)) continue;
      if (o.tipo === "assinatura" && t.source !== "cartao") continue;
      const v = -t.amount;
      if (!amountOk(o, v)) continue;
      let score = 1 - Math.abs(v - o.valor) / Math.max(o.valor, 1);
      if (o.tipo === "parcela") { const m = /parcela\s*(\d+)\s*\/\s*(\d+)/i.exec(t.memo || ""); if (m) { if (+m[1] !== o.k) continue; score += 1; } }
      if (score > bestScore) { best = t; bestScore = score; }
    }
    if (best) { used.add(best.id); o.txId = best.id; o.valorReal = -best.amount; o.status = "lancado"; byTx.set(best.id, o); }
    else o.status = o.date >= today ? "a_vencer" : "sem_lancamento";
  }
  return { occ, byTx };
}

// grupo de um gasto já conciliado (assinatura → assinaturas, parcela → dívidas, fixa → grupo da fixa)
function txGroup(t, byTx, perfil) { const o = byTx.get(t.id); return o ? o.grupo : groupOf(t.cat, perfil); }

// ---------- renda ----------
// Salário pode ser (a) valor fixo informado ou (b) automático: soma do que a fonte
// pagadora (ex.: Portal do Líbano) depositou no último mês em que pagou.
function isSalaryTx(t, p) {
  if (t.kind !== "entrada" || !(t.amount > 0)) return false;
  const s = (p || {}).salario; if (!s) return false;
  if (s.chave && t.key === s.chave) return true;
  const f = norm(s.fonte || ""); return f.length >= 4 && norm(t.merchant + " " + t.memo).includes(f);
}
function salarioRecebidoMes(st, ym) { const p = perfilOf(st); return r2(sum((st.tx || []).filter(t => t.date.startsWith(ym) && isSalaryTx(t, p)), t => t.amount)); }
function salarioInfo(st) {
  const p = perfilOf(st), s = p.salario; if (!s) return null;
  const pagos = (st.tx || []).filter(t => isSalaryTx(t, p)).sort((a, b) => a.date.localeCompare(b.date));
  const ult = pagos[pagos.length - 1];
  const ultMes = ult ? ymOf(ult.date) : null;
  const auto = !(s.valor > 0);
  const valor = auto ? (ultMes ? salarioRecebidoMes(st, ultMes) : 0) : +s.valor;
  const dia = s.dia || (ult ? +ult.date.slice(8) : null);
  return { valor, dia, auto, fonte: s.fonte || (ult ? ult.merchant : null), ultimo: ult || null, ultMes, pagamentos: pagos.length };
}
function rendaPlan(st, ym) {
  const p = perfilOf(st), si = salarioInfo(st);
  let v = si ? Math.max(si.valor, salarioRecebidoMes(st, ym)) : 0;
  for (const e of p.extras) if (e.ativa !== false && e.valor > 0 && (e.tipo === "mensal" ? (!e.desde || ymOf(e.desde) <= ym) : e.mes === ym)) v += +e.valor;
  return r2(v);
}
function rendaReal(st, ym) { return r2(sum((st.tx || []).filter(t => t.kind === "entrada" && t.date.startsWith(ym)), t => t.amount)); }
function salarioRecebido(st, ym) { const p = perfilOf(st); return (st.tx || []).find(t => t.date.startsWith(ym) && isSalaryTx(t, p)) || null; }
function proximoSalario(st, today) {
  const si = salarioInfo(st); if (!si || !si.dia) return null;
  const ym = ymOf(today), d = dateIn(ym, si.dia);
  // se o salário deste mês já caiu, o próximo é no mês seguinte
  if (salarioRecebido(st, ym) || d <= today) return dateIn(addMonths(ym, 1), si.dia);
  return d;
}

// ---------- realizado por grupo ----------
function realizado(st, ym, today) {
  const perfil = perfilOf(st), { occ, byTx } = reconcile(st, ym, today);
  const g = { essenciais: 0, dividas: 0, assinaturas: 0, lazer: 0 };
  const varEss = { valor: 0 };
  for (const t of (st.tx || []).filter(t => t.kind === "gasto" && t.date.startsWith(ym))) {
    const grp = txGroup(t, byTx, perfil); g[grp] = (g[grp] || 0) - t.amount;
    if (grp === "essenciais" && !byTx.has(t.id)) varEss.valor -= t.amount;
  }
  const lazerVar = g.lazer - sum(occ.filter(o => o.status === "lancado" && o.grupo === "lazer"), o => o.valorReal);
  const inv = -sum((st.tx || []).filter(t => t.kind === "investimento" && t.date.startsWith(ym)), t => t.amount);
  const total = sum(Object.values(g));
  return { grupos: Object.fromEntries(Object.entries(g).map(([k, v]) => [k, r2(v)])), total: r2(total), essVar: r2(varEss.valor), lazerVar: r2(lazerVar), investido: r2(inv), occ, byTx };
}

// ---------- médias históricas (essenciais variáveis e lazer) ----------
function mesesComDados(st) { return [...new Set((st.tx || []).map(t => t.date.slice(0, 7)))].sort(); }
function mediaVariavel(st, ym, today) {
  const ms = mesesComDados(st).filter(m => m < ym).slice(-3);
  if (ms.length) {
    const vals = ms.map(m => realizado(st, m, today));
    return { ess: r2(sum(vals, v => v.essVar) / ms.length), lazer: r2(sum(vals, v => v.lazerVar) / ms.length), base: `média de ${ms.length} ${ms.length === 1 ? "mês" : "meses"} anteriores`, confiavel: ms.length >= 2 };
  }
  const cur = mesesComDados(st).includes(ym) ? realizado(st, ym, today) : null;
  if (!cur) return { ess: 0, lazer: 0, base: "sem histórico ainda", confiavel: false };
  const isCur = ymOf(today) === ym, days = daysInYM(ym);
  const el = isCur ? Math.max(+today.slice(8), 1) : days, f = isCur ? days / el : 1;
  return { ess: r2(cur.essVar * f), lazer: r2(cur.lazerVar * f), base: isCur ? `projeção de ${el} dias deste mês` : "só este mês", confiavel: false };
}

// ---------- compromissos do mês ----------
function compromissos(st, ym, today) {
  const { occ } = reconcile(st, ym, today);
  const by = t => r2(sum(occ.filter(o => o.tipo === t), o => o.status === "lancado" ? o.valorReal : o.valor));
  const pend = occ.filter(o => o.status !== "lancado");
  return {
    occ, fixas: by("fixa"), assinaturas: by("assinatura"), parcelas: by("parcela"),
    fixasEss: r2(sum(occ.filter(o => o.tipo === "fixa" && o.grupo === "essenciais"), o => o.status === "lancado" ? o.valorReal : o.valor)),
    fixasDiv: r2(sum(occ.filter(o => o.tipo === "fixa" && o.grupo === "dividas"), o => o.status === "lancado" ? o.valorReal : o.valor)),
    fixasOutras: r2(sum(occ.filter(o => o.tipo === "fixa" && !["essenciais", "dividas"].includes(o.grupo)), o => o.status === "lancado" ? o.valorReal : o.valor)),
    total: r2(sum(occ, o => o.status === "lancado" ? o.valorReal : o.valor)),
    pendente: r2(sum(pend, o => o.valor)), pendentes: pend
  };
}
function assinaturasMensalEquiv(st) { return r2(sum(ativos(st.assinaturas), s => (+s.valor || 0) / (FREQ[s.freq] || 1))); }

// ---------- plano recomendado do mês ----------
function plano(st, ym, today) {
  const p = perfilOf(st), renda = rendaPlan(st, ym);
  const c = compromissos(st, ym, today), media = mediaVariavel(st, ym, today), real = realizado(st, ym, today);
  const essVar = media.ess;
  const essenciais = r2(c.fixasEss + essVar);
  const dividas = r2(c.parcelas + c.fixasDiv);
  const assin = c.assinaturas;
  const obrig = r2(essenciais + dividas + assin + c.fixasOutras);
  const livre = r2(renda - obrig);
  const custoEssMensal = r2(sum(ativos(st.fixas), f => +f.valor) + essVar + assinaturasMensalEquiv(st) + dividas);
  const metaReserva = r2(custoEssMensal * p.metaReservaMeses);
  const reservaAtual = p.reserva ? +p.reserva.valor : null;
  const gapReserva = reservaAtual == null ? null : r2(Math.max(0, metaReserva - reservaAtual));
  let guardar = livre > 0 ? r2(livre * p.guardarPct / 100) : 0;
  let reserva, invest;
  if (gapReserva === 0) { reserva = 0; invest = guardar; }
  else { reserva = r2(Math.min(guardar * p.reservaPctDoGuardar / 100, gapReserva ?? Infinity)); invest = r2(guardar - reserva); }
  let lazer = r2(Math.max(0, livre - guardar));
  const custom = {};
  for (const k of ["lazer", "reserva", "investimentos"]) if (p.tetos[k] != null && p.tetos[k] !== "") custom[k] = +p.tetos[k];
  if ("reserva" in custom) reserva = custom.reserva;
  if ("investimentos" in custom) invest = custom.investimentos;
  if ("lazer" in custom) lazer = custom.lazer;
  else if ("reserva" in custom || "investimentos" in custom) lazer = r2(Math.max(0, livre - reserva - invest));
  const sobra = r2(renda - obrig - lazer - reserva - invest);
  const pct = v => renda > 0 ? v / renda * 100 : null;
  const items = [
    { id: "essenciais", rec: essenciais, real: real.grupos.essenciais, why: `Contas fixas essenciais (${fmtR(c.fixasEss)}) + gasto variável essencial estimado (${fmtR(essVar)}, ${media.base}).` },
    { id: "dividas", rec: dividas, real: real.grupos.dividas, why: `Parcelas deste mês (${fmtR(c.parcelas)})${c.fixasDiv ? ` + dívidas fixas (${fmtR(c.fixasDiv)})` : ""}. É compromisso, não escolha.` },
    { id: "assinaturas", rec: assin, real: real.grupos.assinaturas, why: `Cobranças de assinaturas que caem neste mês. Custo mensal equivalente de todas: ${fmtR(assinaturasMensalEquiv(st))}.` },
    { id: "lazer", rec: lazer, real: real.grupos.lazer, custom: "lazer" in custom, why: "lazer" in custom ? "Valor definido por você." : `O que sobra da renda depois dos compromissos (${fmtR(livre)} livres) menos os ${p.guardarPct}% que você quer guardar.` },
    { id: "reserva", rec: reserva, real: null, custom: "reserva" in custom, why: "reserva" in custom ? "Valor definido por você." : gapReserva == null ? `Informe quanto já tem de reserva para o app calcular a meta. Sugestão provisória: ${p.reservaPctDoGuardar}% do que você guarda.` : gapReserva === 0 ? `Sua reserva já cobre ${p.metaReservaMeses} meses de custo essencial (${fmtR(metaReserva)}). Tudo que guardar pode ir para investimentos.` : `Faltam ${fmtR(gapReserva)} para a meta de ${p.metaReservaMeses} meses de custo essencial (${fmtR(metaReserva)}). Por isso ${p.reservaPctDoGuardar}% do que você guarda vai para a reserva.` },
    { id: "investimentos", rec: invest, real: real.investido, custom: "investimentos" in custom, why: "investimentos" in custom ? "Valor definido por você." : gapReserva === 0 ? `Todo o valor guardado, já que a reserva está completa.` : `O restante do que você guarda depois da reserva.` }
  ].map(x => ({ ...x, ...BUCKETS.find(b => b.id === x.id), pct: pct(x.rec) }));
  return { renda, obrig, livre, guardar: r2(reserva + invest), lazer, reserva, invest, sobra, items, media, c, real, metaReserva, reservaAtual, gapReserva, custoEssMensal, comprometidoPct: pct(obrig), perfil: p };
}
function fmtR(v) { return "R$ " + (+v || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

// ---------- fatura do cartão ----------
// Ciclo: compras feitas do dia do fechamento do mês anterior até a véspera do fechamento
// deste mês entram na fatura que fecha agora (ex.: fecha 27 → de 27/09 a 26/10).
// Lançamentos importados de uma fatura CSV (Nubank_AAAA-MM-DD.csv) carregam o vencimento
// e ficam SEMPRE nessa fatura, como no app do banco (vale para parcelas e estornos).
function faturaVenc(closeYM, F, V) { return V > F ? dateIn(closeYM, V) : dateIn(addMonths(closeYM, 1), V); }
function faturaDaData(d, F, V) { const ym = ymOf(d); const closeYM = d < dateIn(ym, F) ? ym : addMonths(ym, 1); return faturaVenc(closeYM, F, V); }
function faturaCiclos(st, today) {
  const p = perfilOf(st); if (!p.cartao || !p.cartao.fechamento || !p.cartao.vencimento) return null;
  const F = +p.cartao.fechamento, V = +p.cartao.vencimento;
  const ciclo = closeYM => {
    const close = dateIn(closeYM, F), prevClose = dateIn(addMonths(closeYM, -1), F), venc = faturaVenc(closeYM, F, V);
    // ciclo começa no dia do fechamento (27) e vai até a véspera do próximo (26).
    // O Nubank data as parcelas na véspera do início do ciclo (ex.: 26/09 na fatura que começa em 27/09).
    const dataCiclo = t => /parcela\s*\d+\s*\/\s*\d+/i.test(t.memo || "") ? addDays(t.date, 1) : t.date;
    const doCiclo = t => t.fatura ? Math.abs(daysBetween(t.fatura, venc)) <= 5 : (dataCiclo(t) >= prevClose && dataCiclo(t) < close);
    const itens = (st.tx || []).filter(t => t.source === "cartao" && t.kind === "gasto" && doCiclo(t));
    const compras = r2(-sum(itens.filter(t => t.amount < 0), t => t.amount));
    const estornos = r2(sum(itens.filter(t => t.amount > 0), t => t.amount));
    const real = r2(compras - estornos);
    let prev = 0; const prevList = [];
    for (const m of [...new Set([ymOf(prevClose), ymOf(close)])]) for (const o of reconcile(st, m, today).occ) if (o.forma === "cartao" && o.status !== "lancado" && o.date >= prevClose && o.date < close) { prev += o.valor; prevList.push(o); }
    const pago = (st.tx || []).some(t => t.kind === "interna" && t.source === "conta" && /fatura/i.test(t.cat + " " + t.merchant + " " + t.memo) && t.date >= addDays(close, -1) && t.date <= addDays(venc, 3))
      || (st.tx || []).some(t => t.kind === "interna" && t.source === "cartao" && /pagamento recebido/i.test(t.memo || "") && t.date >= close && t.date <= addDays(venc, 3));
    return { close, prevClose, venc, compras, estornos, real, previsto: r2(prev), prevList, total: r2(real + prev), pago, aberto: today < close, itens: itens.length, importada: itens.some(t => t.fatura) };
  };
  const ym = ymOf(today);
  const c0 = dateIn(ym, F) > today ? ym : addMonths(ym, 1); // fatura aberta fecha em c0
  return { anterior: ciclo(addMonths(c0, -1)), atual: ciclo(c0), proximo: ciclo(addMonths(c0, 1)), F, V };
}

// ---------- caixinhas: saldo acompanhado pelo extrato ----------
// Parte do último valor informado e soma o que entrou/saiu das caixinhas DEPOIS dessa data.
// Aplicação RDB (saída da conta, valor negativo) aumenta a caixinha; Resgate RDB diminui.
// Rendimento das caixinhas não aparece no extrato: o valor real tende a ser um pouco maior.
function caixinhasSaldo(st, today) {
  const b = perfilOf(st).caixinhasLivres; if (!b) return null;
  const movs = (st.tx || []).filter(t => t.kind === "caixinha" && t.date > b.data && t.date <= (today || "9999"));
  const mov = r2(-sum(movs, t => t.amount));
  const ap = r2(-sum(movs.filter(t => t.amount < 0), t => t.amount)), rs = r2(sum(movs.filter(t => t.amount > 0), t => t.amount));
  const ultimaExtrato = (st.tx || []).filter(t => t.source === "conta").map(t => t.date).sort().pop() || null;
  const valor = r2(+b.valor + mov);
  return { valor, base: +b.valor, baseData: b.data, mov, aplicado: ap, resgatado: rs, n: movs.length, ultimaExtrato, negativo: valor < -0.004, desatualizado: ultimaExtrato && ultimaExtrato < b.data ? false : null };
}

// ---------- dinheiro realmente disponível (R6, R7) ----------
function disponivel(st, today) {
  const p = perfilOf(st), pl = plano(st, ymOf(today), today);
  const falta = [];
  if (!p.saldoConta) falta.push("saldo em conta");
  if (!p.salario) falta.push("salário e dia de recebimento");
  const saldo = p.saldoConta ? +p.saldoConta.valor : null;
  const cxs = caixinhasSaldo(st, today), cx = cxs ? Math.max(0, cxs.valor) : 0;
  const prox = proximoSalario(st, today);
  const ate = prox || dateIn(ymOf(today), daysInYM(ymOf(today)));
  // contas e débitos que vencem antes do próximo salário (fora do cartão)
  const meses = [...new Set([ymOf(today), ymOf(ate)])];
  const debitos = [];
  for (const m of meses) for (const o of reconcile(st, m, today).occ) if (o.forma !== "cartao" && o.status !== "lancado" && o.date >= today && o.date < ate) debitos.push(o);
  // faturas que vencem antes do próximo salário
  const fc = faturaCiclos(st, today), faturas = [];
  if (fc) for (const c of [fc.anterior, fc.atual]) if (!c.pago && c.venc >= today && c.venc < ate && c.total > 0) faturas.push(c);
  const totDeb = r2(sum(debitos, o => o.valor)), totFat = r2(sum(faturas, f => f.total));
  // compras do Apple Pay feitas depois do último extrato: ainda não estão no saldo nem numa fatura contada,
  // então saem do dinheiro livre na hora (quando o extrato ou a fatura confirmar, entram pelo caminho normal)
  const faturaContada = new Set(faturas.map(f => f.venc));
  const recentes = (st.tx || []).filter(t => t.provisorio && t.kind === "gasto" && t.amount < 0 && t.date <= today && (!p.saldoConta || t.date >= p.saldoConta.data)
    && !(t.source === "cartao" && fc && p.cartao && faturaContada.has(faturaDaData(t.date, +p.cartao.fechamento, +p.cartao.vencimento))));
  const totRecentes = r2(-sum(recentes, t => t.amount));
  const comprometidoAteSalario = r2(totDeb + totFat + totRecentes);
  const seguro = saldo == null ? null : r2(saldo + cx - comprometidoAteSalario - p.colchao);
  // necessidade diária planejada (essenciais variáveis + lazer) até o salário
  const diasAte = Math.max(daysBetween(today, ate), 0);
  const necessidade = r2((pl.media.ess + pl.lazer) / 30 * diasAte);
  const investivel = seguro == null ? null : r2(Math.max(0, seguro - necessidade));
  let paraReserva = 0, paraInvest = investivel || 0;
  if (investivel && pl.gapReserva !== 0) { paraReserva = r2(Math.min(investivel * p.reservaPctDoGuardar / 100, pl.gapReserva ?? Infinity)); paraInvest = r2(investivel - paraReserva); }
  const recebido = salarioRecebido(st, ymOf(today));
  const fimMes = dateIn(ymOf(today), daysInYM(ymOf(today)));
  const salarioAinda = p.salario && prox && prox <= fimMes ? (salarioInfo(st) || {}).valor || 0 : 0;
  return { saldo, caixinhas: cx, colchao: p.colchao, proxSalario: prox, ate, diasAte, debitos, faturas, totDeb, totFat, recentes, totRecentes, comprometidoAteSalario, seguro, necessidade, investivel, paraReserva, paraInvest, recebido, salarioAinda, falta, saldoData: p.saldoConta ? p.saldoConta.data : null, fc };
}

// ---------- projeção dos próximos meses ----------
function projecao(st, today, n = 6) {
  const ym0 = ymOf(today), media = mediaVariavel(st, ym0, today);
  const out = [];
  for (let i = 0; i < n; i++) {
    const m = addMonths(ym0, i);
    const occ = occurrences(st, m);
    const renda = rendaPlan(st, m);
    const fixas = r2(sum(occ.filter(o => o.tipo === "fixa"), o => o.valor));
    const assin = r2(sum(occ.filter(o => o.tipo === "assinatura"), o => o.valor));
    const parc = r2(sum(occ.filter(o => o.tipo === "parcela"), o => o.valor));
    const comp = r2(fixas + assin + parc);
    const terminam = (st.parcelas || []).filter(p => { if (parcelaCancelada(st, p)) return false; const k = parcelaNum(p, m); return k === +p.n; }).map(p => ({ desc: p.desc, libera: parcelaValor(p, +p.n - 1 > 0 ? +p.n - 1 : +p.n) }));
    out.push({ m, renda, fixas, assin, parc, comp, varEst: r2(media.ess + media.lazer), livre: r2(renda - comp - media.ess - media.lazer), pct: renda > 0 ? comp / renda * 100 : null, terminam });
  }
  return { meses: out, media };
}

// ---------- parcelas: resumo ----------
function parcelaResumo(st, p, today) {
  if (parcelaCancelada(st, p)) { const total = +p.total > 0 ? +p.total : r2(parcelaValor(p, 1) * +p.n); return { pagas: 0, restantes: 0, pago: 0, falta: 0, total, mensal: 0, fimYM: ymOf(p.proxima), kNow: 0, ativa: false, cancelada: true, estornada: !!(p.chave && estornoCobre(st, p.chave)), proxima: null, proxK: 0 }; }
  // pagas = as declaradas antes da próxima (atual - 1) + as que já venceram desde então
  const ym = ymOf(today), n = +p.n, pym = ymOf(p.proxima);
  const passou = monthsBetween(pym, ym) + (dateIn(ym, +p.proxima.slice(8)) <= today ? 1 : 0);
  const pagas = Math.min(Math.max(+p.atual - 1 + Math.max(passou, 0), 0), n);
  let pago = 0; for (let k = 1; k <= pagas; k++) pago += parcelaValor(p, k);
  const total = +p.total > 0 ? +p.total : r2(parcelaValor(p, 1) * n);
  const fimYM = addMonths(pym, n - +p.atual);
  const kNow = parcelaNum(p, ym);
  return { pagas, restantes: n - pagas, pago: r2(pago), falta: r2(Math.max(total - pago, 0)), total, mensal: kNow >= 1 && kNow <= n ? parcelaValor(p, kNow) : 0, fimYM, kNow, ativa: pagas < n, proxima: pagas < n ? dateIn(addMonths(pym, pagas - (+p.atual - 1)), +p.proxima.slice(8)) : null, proxK: pagas + 1 };
}

// ---------- sugestões tiradas do extrato (nada é inventado: o usuário confirma) ----------
function sugestoes(st) {
  const out = { salario: null, assinaturas: [], parcelas: [] };
  const p = perfilOf(st);
  if (!p.salario) {
    const ent = (st.tx || []).filter(t => t.kind === "entrada" && /\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/.test(t.memo || "")).sort((a, b) => b.amount - a.amount);
    if (ent[0]) out.salario = { valor: ent[0].amount, dia: +ent[0].date.slice(8), chave: ent[0].key, fonte: ent[0].merchant, de: ent[0].merchant, data: ent[0].date };
  }
  const has = (nome, key) => [...(st.assinaturas || []), ...(st.parcelas || []), ...(st.fixas || [])].some(x => {
    if (x.chave === key) return true;
    const a = norm(x.nome || x.desc || ""), m = norm(nome);
    return a.length >= 4 && (m.includes(a) || a.includes(m) || a.split(" ").filter(w => w.length >= 5).some(w => m.includes(w)));
  });
  const rec = new Set(((st.sugestoes || {}).rejeitadas) || []), recusada = id => rec.has(id);
  const byKey = {};
  for (const t of (st.tx || []).filter(t => t.kind === "gasto" && t.amount < 0)) (byKey[t.key] ||= []).push(t);
  for (const [k, list] of Object.entries(byKey)) {
    const parc = list.map(t => [t, /parcela\s*(\d+)\s*\/\s*(\d+)/i.exec(t.memo || "")]).filter(x => x[1]);
    if (parc.length) {
      const [t, m] = parc.sort((a, b) => b[0].date.localeCompare(a[0].date))[0];
      if (!has(t.merchant, k) && !recusada("parc:" + k) && +m[1] < +m[2] && !estornoCobre(st, k)) out.parcelas.push({ desc: t.merchant, chave: k, valorParcela: -t.amount, n: +m[2], atual: +m[1], proxima: t.date, total: r2(-t.amount * +m[2]), cat: t.cat, pagamento: t.source === "cartao" ? "cartao" : "conta" });
      continue;
    }
    const meses = new Set(list.map(t => t.date.slice(0, 7)));
    const vals = list.map(t => -t.amount), avg = sum(vals) / vals.length;
    const estavel = vals.every(v => Math.abs(v - avg) <= Math.max(2, avg * 0.1));
    // assinatura: SEMPRE no crédito, e só se for recorrente (2+ meses, mesmo valor) ou um serviço de assinatura conhecido
    const noCredito = list.every(t => t.source === "cartao" && !t.provisorio);
    const conhecido = SERVICOS_ASSINATURA.test(norm(list[0].merchant));
    if (noCredito && ((meses.size >= 2 && estavel && list.length === meses.size) || conhecido) && !has(list[0].merchant, k) && !recusada("sub:" + k)) {
      const last = list.slice().sort((a, b) => b.date.localeCompare(a.date))[0];
      out.assinaturas.push({ nome: last.merchant, chave: k, valor: -last.amount, freq: "mensal", proxima: dateIn(addMonths(ymOf(last.date), 1), +last.date.slice(8)), cat: last.cat, pagamento: last.source === "cartao" ? "cartao" : "conta", visto: meses.size });
    }
  }
  return out;
}

const SERVICOS_ASSINATURA = /netflix|spotify|deezer|disney|hbo|\bmax\b|prime video|amazon prime|youtube|google one|icloud|apple com bill|apple\.com|globoplay|paramount|crunchyroll|claude|anthropic|openai|chatgpt|canva|adobe|microsoft|office 365|xbox|playstation|psn|nintendo|smart ?fit|bluefit|academia|duolingo|notion|dropbox|kindle|audible|ifood club|uber one|tinder|linkedin/;

// O estorno devolveu tudo o que já foi cobrado dessa compra parcelada? Então ela foi cancelada.
function estornoCobre(st, chave) {
  const tx = (st.tx || []).filter(t => t.key === chave && t.source === "cartao" && t.kind === "gasto");
  const estornos = sum(tx.filter(t => t.amount > 0), t => t.amount);
  const cobrado = -sum(tx.filter(t => t.amount < 0), t => t.amount);
  return estornos > 0 && estornos >= cobrado - 0.01;
}
function parcelaCancelada(st, p) { return (p.status && p.status !== "ativa") || (p.chave && estornoCobre(st, p.chave)); }

// ---------- assinaturas: oportunidades ----------
function oportunidades(st, today) {
  const subs = ativos(st.assinaturas), renda = rendaPlan(st, ymOf(today));
  const out = [];
  for (const s of subs) if (s.uso === "baixo") out.push({ tipo: "pouco uso", subs: [s], economia: r2((+s.valor) / (FREQ[s.freq] || 1)), texto: `${s.nome}: você marcou como pouco usada.` });
  const byCat = {};
  for (const s of subs) (byCat[norm(s.tipoServico || s.cat || "")] ||= []).push(s);
  for (const [k, list] of Object.entries(byCat)) if (k && list.length >= 2 && (list[0].tipoServico)) { const menor = list.slice().sort((a, b) => a.valor / (FREQ[a.freq] || 1) - b.valor / (FREQ[b.freq] || 1)); out.push({ tipo: "parecidas", subs: list, economia: r2(sum(menor.slice(0, -1), s => s.valor / (FREQ[s.freq] || 1))), texto: `${list.map(s => s.nome).join(", ")} são do mesmo tipo (${list[0].tipoServico}). Manter só uma economizaria até ${fmtR(sum(menor.slice(0, -1), s => s.valor / (FREQ[s.freq] || 1)))} por mês.` }); }
  const names = {};
  for (const s of subs) { const k = norm(s.nome); if (names[k]) out.push({ tipo: "duplicada", subs: [names[k], s], economia: r2(s.valor / (FREQ[s.freq] || 1)), texto: `${s.nome} aparece cadastrada duas vezes. Confira se não está pagando em dobro.` }); names[k] = s; }
  // assinatura sem nenhuma cobrança encontrada nos últimos 2 meses com extrato (pode já ter sido cancelada)
  return out;
}

// ---------- recomendações ----------
function recomendacoes(st, today) {
  const ym = ymOf(today), p = perfilOf(st), pl = plano(st, ym, today), d = disponivel(st, today), pr = projecao(st, today, 4);
  const out = [], add = (nivel, titulo, porque, acao) => out.push({ nivel, titulo, porque, acao });
  if (!p.salario) { add("info", "Cadastre seu salário para o app calcular o seu plano.", "Sem a renda, não dá para saber quanto do seu dinheiro está comprometido nem sugerir limites.", "perfil"); return out; }
  const R = pl.renda;
  add(pl.comprometidoPct > 70 ? "alto" : pl.comprometidoPct > 50 ? "medio" : "ok",
    `Você recebe ${fmtR(R)} por mês e ${fmtR(pl.obrig)} (${pl.comprometidoPct.toFixed(0)}%) já estão comprometidos neste mês.`,
    `Soma de contas fixas, parcelas, assinaturas que cobram neste mês e do gasto essencial variável estimado (${pl.media.base}).${pl.comprometidoPct > 50 ? " Acima de metade da renda, sobra pouca margem para imprevistos." : ""}`);
  const sEq = assinaturasMensalEquiv(st);
  if (sEq > 0) add(sEq / R > 0.05 ? "medio" : "ok", `Suas assinaturas custam ${fmtR(sEq)} por mês, ${(sEq / R * 100).toFixed(1)}% da renda.`, "Valor mensal equivalente: cobranças anuais e semestrais foram divididas pelos meses. Não é o que sai todo mês do caixa.", "assinaturas");
  const lazerReal = pl.real.grupos.lazer;
  if (pl.lazer > 0 || lazerReal > 0) add(lazerReal > pl.lazer ? "alto" : lazerReal > pl.lazer * 0.8 ? "medio" : "ok",
    lazerReal > pl.lazer ? `Lazer e gastos pessoais passaram ${fmtR(lazerReal - pl.lazer)} do limite recomendado de ${fmtR(pl.lazer)}.` : `Seu limite para lazer e gastos pessoais neste mês é ${fmtR(pl.lazer)}. Já usou ${fmtR(lazerReal)}, restam ${fmtR(pl.lazer - lazerReal)}.`,
    pl.items.find(i => i.id === "lazer").why);
  for (const b of Object.entries(st.budgets || {})) {
    const [cat, lim] = b; if (!(lim > 0)) continue;
    const v = -sum((st.tx || []).filter(t => t.kind === "gasto" && t.cat === cat && t.date.startsWith(ym)), t => t.amount);
    if (v > lim) add("alto", `${cat} passou ${fmtR(v - lim)} do teto de ${fmtR(lim)}.`, "Comparação entre o limite que você definiu e os gastos lançados nesta categoria no mês.", "limites");
    else if (v > lim * 0.8) add("medio", `${cat} está perto do teto: ${(v / lim * 100).toFixed(0)}% usado.`, `Restam ${fmtR(lim - v)} até ${fmtR(lim)}.`, "limites");
  }
  const op = oportunidades(st, today);
  if (op.length) { const eco = r2(sum(op, o => o.economia)); add("medio", `Dá para economizar até ${fmtR(eco)} por mês revisando ${op.length === 1 ? "uma assinatura" : op.length + " pontos nas assinaturas"}.`, op.map(o => o.texto).join(" "), "assinaturas"); }
  const next = pr.meses[1];
  if (next && next.parc > 0) add(next.pct > 50 ? "medio" : "info", `No próximo mês, suas parcelas vão comprometer ${fmtR(next.parc)} da renda.`, `Soma das parcelas cadastradas que caem em ${mesNome(next.m)}.`, "parcelas");
  for (const m of pr.meses.slice(0, 4)) for (const t of m.terminam) add("ok", `Quando "${t.desc}" terminar, em ${mesNome(m.m)}, você terá mais ${fmtR(t.libera)} por mês.`, "É a última parcela dessa compra. A partir do mês seguinte esse valor fica livre.", "parcelas");
  if (pl.gapReserva == null) add("info", "Informe quanto você já tem guardado como reserva de emergência.", `Com isso o app sabe se deve priorizar a reserva (meta de ${p.metaReservaMeses} meses de custo essencial, hoje estimada em ${fmtR(pl.metaReserva)}) ou investimentos.`, "perfil");
  else if (pl.gapReserva > 0) add("medio", "Antes de aumentar seus investimentos, reforce a reserva de emergência.", `Você tem ${fmtR(pl.reservaAtual)} de uma meta de ${fmtR(pl.metaReserva)} (${p.metaReservaMeses} meses de custo essencial). No ritmo sugerido de ${fmtR(pl.reserva)} por mês, ${pl.reserva > 0 ? "completa em cerca de " + Math.ceil(pl.gapReserva / pl.reserva) + " meses" : "não completa: falta sobra no orçamento"}.`, "plano");
  if (d.seguro != null && d.seguro < 0) add("alto", `Atenção: faltam ${fmtR(-d.seguro)} para cobrir o que vence antes do próximo salário.`, `Saldo informado (${fmtR(d.saldo)}${d.caixinhas ? " + caixinhas livres " + fmtR(d.caixinhas) : ""}) menos contas e faturas até ${dataCurta(d.ate)} (${fmtR(d.comprometidoAteSalario)}).`, "perfil");
  if (d.falta.length) add("info", `Para calcular o dinheiro disponível, falta informar: ${d.falta.join(" e ")}.`, "O disponível usa só dinheiro que já está na conta. Limite do cartão não conta como dinheiro.", "perfil");
  if (pl.livre < 0) add("alto", `Os compromissos deste mês passam a renda em ${fmtR(-pl.livre)}.`, "Renda planejada menos contas fixas, parcelas, assinaturas e essenciais estimados ficou negativa. Vale rever o que dá para cortar ou adiar.", "plano");
  if (!pl.media.confiavel) add("info", "As estimativas de gasto variável ainda são aproximadas.", `Base atual: ${pl.media.base}. Com 2 ou 3 meses de extrato importados, os números ficam mais precisos.`, "importar");
  const rank = { alto: 0, medio: 1, info: 2, ok: 3 };
  return out.sort((a, b) => rank[a.nivel] - rank[b.nivel]);
}
function mesNome(ym) { const [y, m] = ym.split("-").map(Number); return new Date(y, m - 1, 1).toLocaleDateString("pt-BR", { month: "long" }); }
function dataCurta(d) { return new Date(d + "T12:00").toLocaleDateString("pt-BR", { day: "numeric", month: "short" }).replace(".", ""); }

// ---------- simulações ----------
function simInvestirMais(st, today, extra) {
  const pl = plano(st, ymOf(today), today), novoLazer = r2(pl.lazer - extra);
  return { novoInvest: r2(pl.invest + extra), novoLazer, cabe: novoLazer >= 0, anual: r2(extra * 12), texto: novoLazer >= 0 ? `Investindo mais ${fmtR(extra)} por mês, seu limite de lazer cai de ${fmtR(pl.lazer)} para ${fmtR(novoLazer)}. Em 12 meses são ${fmtR(extra * 12)} a mais aplicados (sem contar rendimento).` : `Não cabe: faltariam ${fmtR(-novoLazer)} por mês. Seria preciso cortar em outro grupo.` + (pl.gapReserva > 0 ? ` Lembre que a reserva ainda não está completa.` : "") };
}
function simCancelar(st, today, ids) {
  const subs = (st.assinaturas || []).filter(s => ids.includes(s.id));
  const mensal = r2(sum(subs, s => (+s.valor) / (FREQ[s.freq] || 1)));
  let caixa12 = 0; const ym = ymOf(today);
  for (let i = 0; i < 12; i++) for (const s of subs) { const o = subOcc(s, addMonths(ym, i)); if (o && o.date >= today) caixa12 += o.valor; }
  return { mensal, anual: r2(caixa12), n: subs.length };
}
function simNovaParcela(st, today, valor, n) {
  const pr = projecao(st, today, Math.max(n + 1, 3)), ym = ymOf(today);
  const meses = pr.meses.slice(1, n + 1).map(m => ({ ...m, comp2: r2(m.comp + valor), livre2: r2(m.livre - valor), pct2: m.renda > 0 ? (m.comp + valor) / m.renda * 100 : null }));
  const pior = meses.reduce((a, m) => (!a || m.livre2 < a.livre2) ? m : a, null);
  const pl = plano(st, ym, today);
  let veredito = "sem_renda";
  if (pl.renda > 0 && pior) veredito = pior.livre2 < 0 ? "nao" : (pior.pct2 > 60 || pior.livre2 < pl.guardar) ? "apertado" : "sim";
  return { meses, pior, veredito, total: r2(valor * n) };
}
function simGuardarAteFimAno(st, today) {
  const ym = ymOf(today), fim = ym.slice(0, 4) + "-12", n = monthsBetween(ym, fim) + 1;
  const pr = projecao(st, today, n);
  let plan = 0, realista = 0;
  for (const m of pr.meses) {
    const plM = plano(st, m.m, today);
    const frac = m.m === ym ? Math.max(0, 1 - (+today.slice(8) - 1) / daysInYM(ym)) : 1;
    plan += plM.guardar * (m.m === ym ? 0 : 1);
    realista += Math.max(0, m.livre) * (m.m === ym ? 0 : 1);
  }
  // mês atual: o que ainda dá para guardar = disponível investível estimado
  const d = disponivel(st, today);
  const atual = d.investivel ?? 0;
  return { meses: pr.meses.map(m => m.m), plan: r2(plan + atual), realista: r2(realista + atual), atual: r2(atual), base: pr.media.base };
}

if (typeof module !== "undefined") module.exports = { parcelaCancelada, estornoCobre, faturaDaData, caixinhasSaldo, isSalaryTx, salarioInfo, salarioRecebidoMes, sugestoes, BUCKETS, DEFAULT_GROUP, FREQ, perfilOf, groupOf, subOcc, parcOcc, fixaOcc, occurrences, reconcile, realizado, rendaPlan, rendaReal, compromissos, plano, faturaCiclos, disponivel, projecao, parcelaResumo, oportunidades, recomendacoes, simInvestirMais, simCancelar, simNovaParcela, simGuardarAteFimAno, assinaturasMensalEquiv, addMonths, monthsBetween, dateIn, mediaVariavel, proximoSalario, salarioRecebido, parcelaValor, parcelaNum };
