#!/usr/bin/env node
// =============================================================================
// Cofrinho — automação (rodada pela tarefa agendada, de 8 em 8 horas)
//
//   node cofrinho.js preparar  --estado ESTADO --anexos PASTA [--agora ISO]
//   node cofrinho.js finalizar [--categorias categorias.json]
//
// "preparar" junta os anexos dos e-mails do Nubank com o estado atual (sem duplicar)
// e lista as lojas sem categoria. "finalizar" monta as sugestões, os lembretes,
// os resumos e os lotes SQL verificados (contagem + soma + assinatura) para gravar.
// Tudo fica em ./trabalho. Nada é gravado no banco por este script.
// =============================================================================
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const core = require("./lib/core.js");
Object.assign(global, core);               // norm, mkey, KINDS, CATS_GASTO… (o motor usa como globais)
const F = require("./lib/finance.js");

const DIR = path.join(process.cwd(), "trabalho");
const APP_URL = "https://rafaelbt04.github.io/Gastos-/";
const MAX_LOTE = 7000; // caracteres de JSON por lote (menor = cópia mais segura)

// ---------------------------------------------------------------- utilidades
const args = (() => { const a = process.argv.slice(3), o = {}; for (let i = 0; i < a.length; i++) if (a[i].startsWith("--")) o[a[i].slice(2)] = a[i + 1] && !a[i + 1].startsWith("--") ? a[++i] : true; return o; })();
const fmt = v => (v < -0.004 ? "−" : "") + "R$ " + Math.abs(v || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt0 = v => "R$ " + Math.round(Math.abs(v || 0)).toLocaleString("pt-BR");
const r2 = v => Math.round((v + Number.EPSILON) * 100) / 100;
const sum = (a, f = x => x) => a.reduce((s, x) => s + (f(x) || 0), 0);
const md5 = s => crypto.createHash("md5").update(s, "utf8").digest("hex");
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const dCurta = d => new Date(d + "T12:00").toLocaleDateString("pt-BR", { day: "numeric", month: "short" }).replace(".", "");
const mesNome = ym => new Date(+ym.slice(0, 4), +ym.slice(5, 7) - 1, 1).toLocaleDateString("pt-BR", { month: "long" });
const addDays = (d, n) => { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const diffDays = (a, b) => Math.round((new Date(b + "T12:00:00Z") - new Date(a + "T12:00:00Z")) / 864e5);
function agoraSP(iso) {
  const d = iso ? new Date(iso) : new Date();
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23", weekday: "short" }).formatToParts(d).map(x => [x.type, x.value]));
  const date = `${p.year}-${p.month}-${p.day}`;
  return { iso: d.toISOString(), date, hora: +p.hour, dow: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday), dia: +p.day };
}
function die(msg) { console.error("ERRO: " + msg); process.exit(1); }
function writeJSON(f, o) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o, null, 1)); }

// Lê o estado vindo do Supabase: aceita o JSON puro de cofrinho_estado(), a linha
// [{"cofrinho_estado": {...}}] ou a resposta inteira do execute_sql (com o texto em volta).
function lerEstado(file) {
  let t = fs.readFileSync(file, "utf8").trim();
  const tryParse = s => { try { return JSON.parse(s); } catch (e) { return undefined; } };
  let d = tryParse(t);
  const unwrap = x => {
    if (x == null) return x;
    if (typeof x === "string") { const m = /<untrusted-data-[0-9a-f-]+>\s*([\[{][\s\S]*[\]}])\s*<\/untrusted-data-/.exec(x); return unwrap(tryParse(m ? m[1] : x)); }
    if (Array.isArray(x)) return unwrap(x[0]);
    if (typeof x.text === "string" && !x.tx) return unwrap(x.text);
    if (x.result !== undefined && !x.tx) return unwrap(x.result);
    if (x.cofrinho_estado_arquivo) return unwrap(x.cofrinho_estado_arquivo);
    if (x.cofrinho_estado) return unwrap(x.cofrinho_estado);
    if (typeof x === "object" && Object.keys(x).length === 1 && !x.tx) return unwrap(Object.values(x)[0]);
    return x;
  };
  if (d === undefined) { const m = /<untrusted-data-[0-9a-f-]+>\s*([\[{][\s\S]*[\]}])\s*<\/untrusted-data-/.exec(t); d = m ? tryParse(m[1]) : undefined; }
  const e = unwrap(d);
  if (!e || !Array.isArray(e.tx) || !e.config || !e.user_id) die(`não consegui ler o estado em ${file}`);
  if (e.check) {
    const ids = e.tx.map(t => t.id).sort();
    if (ids.length !== e.check.n || md5(ids.join(",")) !== e.check.hash) die(`o estado lido não confere com o banco (${ids.length} de ${e.check.n} lançamentos). Leia o estado de novo, sem alterar o conteúdo.`);
  }
  return e;
}
function stateFrom(e) {
  const c = e.config || {};
  return { tx: e.tx.map(t => ({ ...t })), rules: c.rules || {}, budgets: c.budgets || {}, settings: c.settings || { ownNames: [] }, wallet: c.wallet || null, imports: c.imports || [],
    perfil: c.perfil || {}, assinaturas: c.assinaturas || [], parcelas: c.parcelas || [], fixas: c.fixas || [], sugestoes: c.sugestoes || { itens: [], rejeitadas: [] }, automacao: c.automacao || { enviados: {} }, faturas: c.faturas || {} };
}

// ---------------------------------------------------------------- PDF (pdf.js)
async function pdfPages(file) {
  const w = console.warn, l = console.log; console.warn = () => {}; console.log = (...a) => { if (!/polyfill|canvas|standard font/i.test(String(a[0]))) l(...a); };
  let pdfjs; try { pdfjs = require("./vendor/pdf.js"); } finally { console.warn = w; console.log = l; }
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(file)), verbosity: 0, isEvalSupported: false, useSystemFonts: false }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) { const tc = await (await doc.getPage(i)).getTextContent(); pages.push(tc.items.filter(it => it.str && it.str.trim()).map(it => ({ s: it.str, x: Math.round(it.transform[4]), y: Math.round(it.transform[5]) }))); }
  return pages;
}

// Lê os arquivos de um e-mail. O Nubank manda o extrato da conta em 3 formatos juntos
// (OFX, PDF e CSV): usamos só o OFX (ou o PDF se faltar), para não ler 3 vezes.
async function lerEmail(pasta) {
  const fs_ = fs.readdirSync(pasta).filter(f => !f.startsWith("_"));
  const out = { conta: null, cartao: [], fatura: [], ignorados: [], arquivos: fs_ };
  const pick = re => fs_.find(f => re.test(f));
  const ofx = pick(/^NU_.*\.ofx$/i) || fs_.find(f => /\.ofx$/i.test(f) && /<OFX>/i.test(fs.readFileSync(path.join(pasta, f), "latin1")) && !/<CCSTMTRS>/i.test(fs.readFileSync(path.join(pasta, f), "latin1")));
  const contaPdf = pick(/^NU_.*\.pdf$/i);
  const contaCsv = pick(/^NU_.*\.csv$/i);
  if (ofx) out.conta = { arquivo: ofx, rows: core.parseOFX(fs.readFileSync(path.join(pasta, ofx), "utf8")) };
  else if (contaPdf) out.conta = { arquivo: contaPdf, rows: core.parseNubankPDF(await pdfPages(path.join(pasta, contaPdf))) };
  else if (contaCsv) out.conta = { arquivo: contaCsv, rows: core.parseStatement(contaCsv, fs.readFileSync(path.join(pasta, contaCsv), "utf8")) };
  for (const f of fs_) {
    if (/^Nubank_.*\.csv$/i.test(f)) { const rows = core.parseStatement(f, fs.readFileSync(path.join(pasta, f), "utf8")); if (rows.length && rows[0].source === "cartao") out.cartao.push({ arquivo: f, rows }); else out.ignorados.push(f); }
    else if (/^Nubank_.*\.pdf$/i.test(f)) { const rows = core.parseNubankFaturaPDF(await pdfPages(path.join(pasta, f)), f); if (rows.meta) out.fatura.push({ arquivo: f, rows, meta: rows.meta }); else out.ignorados.push(f); }
    else if (![ofx, contaPdf, contaCsv].includes(f)) out.ignorados.push(f);
  }
  return out;
}

// ---------------------------------------------------------------- PREPARAR
async function preparar() {
  if (!args.estado || !args.anexos) die("uso: node cofrinho.js preparar --estado ESTADO --anexos PASTA");
  const est = lerEstado(args.estado), st = stateFrom(est), agora = agoraSP(args.agora);
  const changes = { add: new Map(), update: new Map(), remove: new Map() }, cfgSet = {}, cfgMerge = {}, mensagens = [];
  const pastas = fs.existsSync(args.anexos) ? fs.readdirSync(args.anexos).filter(d => fs.statSync(path.join(args.anexos, d)).isDirectory()).sort() : [];
  for (const id of pastas) {
    const m = await lerEmail(path.join(args.anexos, id));
    const info = { id, arquivos: [], novas: 0, repetidas: 0, substituidas: 0, avisos: [] };
    const grupos = [];
    if (m.conta) grupos.push({ tipo: "conta", ...m.conta });
    for (const c of m.cartao) grupos.push({ tipo: "cartao", ...c });
    for (const f of m.fatura) grupos.push({ tipo: "fatura", ...f });
    if (!grupos.length) info.avisos.push("nenhum extrato ou fatura reconhecido nos anexos: " + (m.arquivos.join(", ") || "sem anexos"));
    for (const g of grupos) {
      const r = core.mergeImport(st.tx, g.rows, st.rules, st.settings);
      for (const t of r.add) { st.tx.push(t); changes.add.set(t.id, t); }
      for (const t of r.update) if (!changes.add.has(t.id)) changes.update.set(t.id, t);
      for (const t of r.remove) { st.tx = st.tx.filter(x => x.id !== t.id); changes.add.delete(t.id); changes.update.delete(t.id); changes.remove.set(t.id, t); }
      info.novas += r.novas; info.repetidas += r.repetidas; info.substituidas += r.substituidas;
      info.arquivos.push(`${g.arquivo} (${r.novas} novas, ${r.repetidas} já estavam${r.substituidas ? `, ${r.substituidas} do Apple Pay confirmadas` : ""})`);
      st.imports.push({ arquivo: g.arquivo, tipo: g.tipo === "conta" ? "conta" : "cartao", em: agora.iso, novas: r.novas, repetidas: r.repetidas, auto: true });
      if (g.rows.saldo) { const cur = st.perfil.saldoConta; if (!cur || !(cur.data > g.rows.saldo.data)) { st.perfil.saldoConta = { ...g.rows.saldo, fonte: "extrato" }; cfgMerge.perfil = { ...(cfgMerge.perfil || {}), saldoConta: st.perfil.saldoConta }; } }
      if (g.meta) { st.faturas[g.meta.venc] = { ...g.meta, arquivo: g.arquivo, lidoEm: agora.date }; cfgMerge.faturas = { ...(cfgMerge.faturas || {}), [g.meta.venc]: st.faturas[g.meta.venc] }; }
    }
    mensagens.push(info);
  }
  // salário: entradas da fonte pagadora viram "Salário" (mesma regra do app)
  const p = F.perfilOf(st);
  if (p.salario) for (const t of st.tx) if (F.isSalaryTx(t, p) && (t.cat !== "Salário" || t.kind !== "entrada")) { t.kind = "entrada"; t.cat = "Salário"; if (!changes.add.has(t.id)) changes.update.set(t.id, t); }
  if (mensagens.some(m => m.arquivos.length)) cfgSet.imports = st.imports.slice(-30);

  // lojas sem categoria (para a sugestão de categorias)
  const pend = new Set([...(st.sugestoes.itens || []).map(s => s.id), ...(st.sugestoes.rejeitadas || [])]);
  const byKey = {};
  for (const t of st.tx) if (t.kind === "gasto" && t.cat === "Outros gastos" && !t.manual && !st.rules[t.key] && !pend.has("cat:" + t.key)) (byKey[t.key] ||= { key: t.key, loja: t.merchant, exemplo: t.memo, vezes: 0, total: 0, cartao: t.source === "cartao" }).vezes++, byKey[t.key].total = r2(byKey[t.key].total - t.amount);
  const semCategoria = Object.values(byKey).sort((a, b) => b.total - a.total).slice(0, 40);

  writeJSON(path.join(DIR, "preparado.json"), { user_id: est.user_id, agora, state: st, changes: { add: [...changes.add.values()], update: [...changes.update.values()], remove: [...changes.remove.values()] }, cfgSet, cfgMerge, mensagens });
  writeJSON(path.join(DIR, "sem_categoria.json"), { categorias_permitidas: CATS_GASTO.filter(c => c !== "Outros gastos"), lojas: semCategoria });
  console.log(`Agora: ${agora.date} ${agora.hora}h (São Paulo)`);
  for (const m of mensagens) { console.log(`E-mail ${m.id}: ${m.novas} novas, ${m.repetidas} repetidas${m.substituidas ? `, ${m.substituidas} Apple Pay confirmadas` : ""}`); for (const a of m.arquivos) console.log("  - " + a); for (const a of m.avisos) console.log("  ! " + a); }
  if (!mensagens.length) console.log("Nenhum e-mail novo para importar.");
  console.log(`Lojas sem categoria para sugerir: ${semCategoria.length} (veja trabalho/sem_categoria.json)`);
}

// ---------------------------------------------------------------- e-mails
function mailHTML(titulo, blocos) {
  const css = "font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#13201A";
  return `<div style="${css};max-width:560px;margin:0 auto"><div style="background:#0F3D2E;color:#F1F6F3;border-radius:14px;padding:18px 20px"><div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#A9C4B8">Cofrinho</div><div style="font-size:20px;font-weight:700;margin-top:4px">${esc(titulo)}</div></div>${blocos.join("")}<p style="font-size:13px;color:#5D6B64;margin-top:18px"><a href="${APP_URL}" style="color:#0E6B4F;font-weight:600">Abrir o Cofrinho</a> · e-mail automático da sua automação</p></div>`;
}
function bloco(titulo, linhas) {
  if (!linhas.length) return "";
  return `<div style="border:1px solid #DFE5E1;border-radius:12px;padding:14px 16px;margin-top:12px"><div style="font-weight:700;margin-bottom:8px">${esc(titulo)}</div>${linhas.map(l => Array.isArray(l) ? `<div style="display:flex;justify-content:space-between;gap:10px;padding:3px 0;font-size:14px"><span>${esc(l[0])}</span><b style="white-space:nowrap">${esc(l[1])}</b></div>` : `<div style="font-size:14px;padding:3px 0">${esc(l)}</div>`).join("")}</div>`;
}
function texto(titulo, secoes) { return [titulo.toUpperCase(), "", ...secoes.flatMap(([t, ls]) => ls.length ? [t, ...ls.map(l => Array.isArray(l) ? `  ${l[0]}: ${l[1]}` : `  ${l}`), ""] : []), "Abrir o Cofrinho: " + APP_URL].join("\n"); }
function email(assunto, titulo, secoes) { return { assunto, texto: texto(titulo, secoes), html: mailHTML(titulo, secoes.map(([t, ls]) => bloco(t, ls))) }; }

function vencimentos(st, hoje, dias) {
  const out = [], ate = addDays(hoje, dias);
  for (const m of [...new Set([hoje.slice(0, 7), ate.slice(0, 7)])]) for (const o of F.reconcile(st, m, hoje).occ) if (o.status !== "lancado" && o.date >= hoje && o.date <= ate && o.forma !== "cartao") out.push({ date: o.date, nome: o.nome + (o.tipo === "parcela" ? ` (${o.k}/${o.n})` : ""), valor: o.valor, tipo: o.tipo, ref: o.ref });
  const fc = F.faturaCiclos(st, hoje);
  if (fc) for (const f of [fc.anterior, fc.atual]) if (!f.pago && f.venc >= hoje && f.venc <= ate && f.total > 0) out.push({ date: f.venc, nome: "Fatura do cartão", valor: (st.faturas[f.venc] && st.faturas[f.venc].total) || f.total, tipo: "fatura" });
  return out.sort((a, b) => a.date.localeCompare(b.date));
}
function gastosEntre(st, a, b) { return st.tx.filter(t => t.kind === "gasto" && t.date >= a && t.date <= b); }
function porCategoria(list) { const o = {}; for (const t of list) o[t.cat] = (o[t.cat] || 0) - t.amount; return Object.entries(o).filter(([, v]) => v > 0.004).sort((a, b) => b[1] - a[1]); }
function ultimoExtrato(st) { return st.tx.filter(t => t.source === "conta").map(t => t.date).sort().pop() || null; }

function resumoSemanal(st, ag) {
  const fim = addDays(ag.date, -1), ini = addDays(ag.date, -7), iniAnt = addDays(ag.date, -14), fimAnt = addDays(ag.date, -8);
  const g = gastosEntre(st, ini, fim), gAnt = gastosEntre(st, iniAnt, fimAnt);
  const tot = -sum(g, t => t.amount), totAnt = -sum(gAnt, t => t.amount), cred = -sum(g.filter(t => t.source === "cartao"), t => t.amount);
  const ym = ag.date.slice(0, 7), pl = F.plano(st, ym, ag.date), d = F.disponivel(st, ag.date);
  const sec = [];
  sec.push([`Semana de ${dCurta(ini)} a ${dCurta(fim)}`, [["Gastos", fmt(tot)], ["No débito e Pix", fmt(tot - cred)], ["No crédito", fmt(cred)], ...(gAnt.length ? [["Semana anterior", fmt(totAnt) + (totAnt > 0 ? ` (${tot >= totAnt ? "+" : "−"}${Math.abs((tot - totAnt) / totAnt * 100).toFixed(0)}%)` : "")]] : []),
    ...porCategoria(g).slice(0, 5).map(([c, v]) => ["· " + c, fmt(v)])]]);
  const mesLin = [["Gasto no mês até agora", fmt(pl.real.total)]];
  if (pl.renda > 0) for (const it of pl.items.filter(i => ["essenciais", "lazer"].includes(i.id))) mesLin.push([it.nome, `${fmt0(it.real)} de ${fmt0(it.rec)}${it.real > it.rec ? " — passou" : ""}`]);
  for (const [cat, lim] of Object.entries(st.budgets || {})) { if (!(lim > 0)) continue; const v = -sum(st.tx.filter(t => t.kind === "gasto" && t.cat === cat && t.date.startsWith(ym)), t => t.amount); if (v > lim * 0.8) mesLin.push([`Teto ${cat}`, `${fmt0(v)} de ${fmt0(lim)}${v > lim ? " — passou" : ""}`]); }
  sec.push([`${mesNome(ym)[0].toUpperCase() + mesNome(ym).slice(1)} até agora`, mesLin]);
  if (d.seguro != null) sec.push(["Dinheiro", [["Livre para gastar até o salário", fmt(d.seguro)], ...(d.proxSalario ? [["Próximo salário", dCurta(d.proxSalario)]] : [])]]);
  const v = vencimentos(st, ag.date, 7);
  sec.push(["Próximos 7 dias", v.length ? v.map(x => [`${dCurta(x.date)} · ${x.nome}`, fmt(x.valor)]) : ["Nada vencendo."]]);
  const avisos = [];
  const ue = ultimoExtrato(st); if (ue && diffDays(ue, ag.date) > 7) avisos.push(`O último extrato da conta vai até ${dCurta(ue)}. Peça o extrato no app do Nubank para atualizar: a automação importa sozinha.`);
  const prov = st.tx.filter(t => t.provisorio); if (prov.length) avisos.push(`${prov.length} compra(s) do Apple Pay aguardando a fatura para confirmar.`);
  const ns = (st.sugestoes.itens || []).length; if (ns) avisos.push(`${ns} sugestão(ões) esperando sua aprovação no app (Mais → Automação).`);
  sec.push(["Avisos", avisos]);
  return email(`Cofrinho · sua semana: ${fmt(tot)} em gastos`, "Resumo da semana", sec);
}
function resumoMensal(st, ag) {
  const ym = F.addMonths(ag.date.slice(0, 7), -1), ant = F.addMonths(ym, -1);
  const pl = F.plano(st, ym, ag.date), real = pl.real;
  const entrada = r2(sum(st.tx.filter(t => t.kind === "entrada" && t.date.startsWith(ym)), t => t.amount));
  const temConta = m => st.tx.some(t => t.source === "conta" && t.date.startsWith(m));
  const gastoAnt = temConta(ant) ? -sum(st.tx.filter(t => t.kind === "gasto" && t.date.startsWith(ant)), t => t.amount) : 0;
  const sec = [];
  sec.push([`Fechamento de ${mesNome(ym)}`, [["Entrou", fmt(entrada)], ["Gastou", fmt(real.total) + (gastoAnt > 0 ? ` (${real.total >= gastoAnt ? "+" : "−"}${Math.abs((real.total - gastoAnt) / gastoAnt * 100).toFixed(0)}% vs ${mesNome(ant)})` : "")], ["Investiu", fmt(real.investido)], ["Sobrou", fmt(entrada - real.total - real.investido)]]]);
  if (pl.renda > 0 && pl.media.confiavel) sec.push(["Plano × realizado", pl.items.filter(i => i.real != null).map(i => [i.nome, `${fmt0(i.real)} de ${fmt0(i.rec)}`])]);
  else sec.push(["Por grupo", pl.items.filter(i => i.real != null && i.id !== "investimentos").map(i => [i.nome, fmt(i.real)]).concat(pl.renda > 0 ? ["O plano × realizado aparece quando houver 2 meses completos de extrato."] : [])]);
  if (!temConta(ym)) sec.unshift(["Atenção", [`Não há extrato da conta de ${mesNome(ym)} no app: os números abaixo mostram só o cartão. Peça o extrato no app do Nubank.`]]);
  sec.push(["Onde mais gastou", porCategoria(gastosEntre(st, ym + "-01", ym + "-31")).slice(0, 6).map(([c, v]) => [c, fmt(v)])]);
  const pr = F.projecao(st, ag.date, 2).meses[0];
  sec.push([`${mesNome(ag.date.slice(0, 7))[0].toUpperCase() + mesNome(ag.date.slice(0, 7)).slice(1)} já começa com`, [["Contas fixas", fmt(pr.fixas)], ["Assinaturas", fmt(pr.assin)], ["Parcelas", fmt(pr.parc)], ...(pr.renda > 0 ? [["Renda comprometida", (pr.comp / pr.renda * 100).toFixed(0) + "%"]] : [])]]);
  sec.push(["O que o app sugere", F.recomendacoes(st, ag.date).filter(r => r.nivel !== "ok").slice(0, 3).map(r => r.titulo)]);
  return email(`Cofrinho · ${mesNome(ym)} fechou em ${fmt(real.total)} de gastos`, `Resumo de ${mesNome(ym)}`, sec);
}
function lembretes(st, ag, enviados) {
  const itens = [], chaves = [];
  const add = (k, txt) => { if (enviados[k]) return; itens.push(txt); chaves.push(k); };
  const ym = ag.date.slice(0, 7);
  if (ag.dia === 1) add(`extrato:${ym}`, `Peça o extrato de ${mesNome(F.addMonths(ym, -1))} no app do Nubank (Conta → Extrato → período do mês passado). O e-mail chega com o arquivo e a automação importa sozinha em até 8 horas.`);
  if (ag.dia === 15) add(`extrato15:${ym}`, `Meio do mês: peça o extrato de 1º a ${ag.dia} de ${mesNome(ym)} no app do Nubank para o Cofrinho ficar em dia.`);
  for (const v of vencimentos(st, ag.date, 2)) add(`venc:${v.tipo}:${v.nome}:${v.date}`, `${v.date === ag.date ? "Vence hoje" : `Vence ${v.date === addDays(ag.date, 1) ? "amanhã" : "em " + dCurta(v.date)}`}: ${v.nome} — ${fmt(v.valor)}.`);
  for (const s of (st.assinaturas || []).filter(s => (s.status || "ativa") === "ativa" && s.freq && s.freq !== "mensal")) for (let i = 0; i < 2; i++) { const o = F.subOcc(s, F.addMonths(ym, i)); if (o && o.date >= ag.date && o.date <= addDays(ag.date, 3)) add(`anual:${s.id}:${o.date}`, `${s.nome} (${s.freq}) cobra ${fmt(o.valor)} em ${dCurta(o.date)}${s.pagamento === "cartao" ? " no cartão" : ""}.`); }
  if (!itens.length) return null;
  return { chaves, mail: email(`Cofrinho · ${itens.length === 1 ? "lembrete" : itens.length + " lembretes"} de hoje`, "Lembretes de hoje", [["Para hoje", itens]]) };
}
function avisoImportacao(prep, novasSug) {
  const ms = prep.mensagens.filter(m => m.arquivos.length);
  const novas = sum(ms, m => m.novas), subs = sum(ms, m => m.substituidas);
  if (!novas && !subs && !novasSug.length) return null;
  const st = prep.state, ag = prep.agora, d = F.disponivel(st, ag.date);
  const sec = [["Importado agora", ms.flatMap(m => m.arquivos)]];
  const fat = Object.values(prep.cfgMerge.faturas || {});
  if (fat.length) sec.push(["Fatura do cartão", fat.flatMap(f => [[`Fatura que vence ${dCurta(f.venc)}`, fmt(f.total)], ...(f.saldoAbertoTotal ? [["Saldo em aberto total (com parcelas futuras)", fmt(f.saldoAbertoTotal)]] : [])])]);
  if (d.seguro != null) sec.push(["Agora", [["Livre para gastar até o salário", fmt(d.seguro)], ["Saldo em conta", fmt(d.saldo) + (d.saldoData ? ` (${dCurta(d.saldoData)})` : "")]]]);
  if (novasSug.length) sec.push(["Para você aprovar no app (Mais → Automação)", novasSug.map(s => s.texto)]);
  const assunto = novas || subs ? `Cofrinho · ${novas} lançamento(s) importado(s)${subs ? `, ${subs} do Apple Pay confirmado(s)` : ""}${novasSug.length ? ` e ${novasSug.length} sugestão(ões)` : ""}` : `Cofrinho · ${novasSug.length} sugestão(ões) para aprovar`;
  return email(assunto, novas || subs ? "Extrato importado" : "Sugestões para aprovar", novas || subs ? sec : sec.slice(1));
}

// ---------------------------------------------------------------- lotes SQL
function lotes(userId, upserts, deletes) {
  const ops = [...upserts.map(u => ({ k: "u", v: u })), ...deletes.map(d => ({ k: "d", v: d }))];
  const out = []; let cur = { upserts: [], deletes: [] }, size = 0;
  const flush = () => { if (cur.upserts.length || cur.deletes.length) out.push(cur); cur = { upserts: [], deletes: [] }; size = 0; };
  for (const o of ops) { const s = JSON.stringify(o.v).length; if (size + s > MAX_LOTE && size > 0) flush(); (o.k === "u" ? cur.upserts : cur.deletes).push(o.v); size += s; }
  flush();
  return out.map(l => {
    const p = { user_id: userId, upserts: l.upserts, deletes: l.deletes };
    const n = l.upserts.length + l.deletes.length;
    const soma = r2(sum(l.upserts.filter(u => u.tipo === "tx"), u => +u.dados.amount || 0));
    const keys = [...l.upserts.map(u => u.tipo + ":" + u.id), ...l.deletes.map(d => "del:" + d.tipo + ":" + d.id)].sort();
    const hash = md5(keys.join(","));
    const j = JSON.stringify(p);
    if (j.includes("$cofrinho$")) die("conteúdo inesperado no lote");
    return { sql: `select public.cofrinho_aplicar($cofrinho$${j}$cofrinho$::jsonb, ${n}, ${soma.toFixed(2)}, '${hash}');`, n, soma, hash };
  });
}
const semId = t => { const { id, ...d } = t; return d; };

// ---------------------------------------------------------------- FINALIZAR
function finalizar() {
  const prep = JSON.parse(fs.readFileSync(path.join(DIR, "preparado.json"), "utf8"));
  const st = prep.state, ag = prep.agora;
  const upserts = [], deletes = [];
  for (const t of [...prep.changes.add, ...prep.changes.update]) upserts.push({ tipo: "tx", id: t.id, dados: semId(t) });
  for (const t of prep.changes.remove) deletes.push({ tipo: "tx", id: t.id });

  // sugestões (aprovadas pelo usuário no app)
  const sug = { itens: [...(st.sugestoes.itens || [])], rejeitadas: [...(st.sugestoes.rejeitadas || [])] };
  const has = id => sug.itens.some(s => s.id === id) || sug.rejeitadas.includes(id);
  const novasSug = [];
  const push = s => { if (has(s.id)) return; s.criada = ag.date; sug.itens.push(s); novasSug.push(s); };
  if (args.categorias && fs.existsSync(args.categorias)) {
    let cats = {}; try { cats = JSON.parse(fs.readFileSync(args.categorias, "utf8")); } catch (e) { die("categorias.json inválido: " + e.message); }
    const lojas = JSON.parse(fs.readFileSync(path.join(DIR, "sem_categoria.json"), "utf8")).lojas;
    for (const [key, cat] of Object.entries(cats)) {
      const l = lojas.find(x => x.key === key); if (!l || !CATS_GASTO.includes(cat) || cat === "Outros gastos") continue;
      push({ id: "cat:" + key, tipo: "categoria", key, loja: l.loja, cat, vezes: l.vezes, total: l.total, texto: `${l.loja} → ${cat} (${l.vezes}x, ${fmt(l.total)})` });
    }
  }
  const sg = F.sugestoes(st);
  for (const a of sg.assinaturas.filter(a => a.visto >= 2 || a.cat === "Apps e assinaturas")) push({ id: "sub:" + a.chave, tipo: "assinatura", dados: a, texto: `Assinatura: ${a.nome}, ${fmt(a.valor)} por mês` });
  for (const p of sg.parcelas.filter(p => +p.atual < +p.n)) push({ id: "parc:" + p.chave, tipo: "parcela", dados: p, texto: `Parcelamento: ${p.desc}, ${p.atual}/${p.n} de ${fmt(p.valorParcela)}` });
  // remove sugestões que já foram resolvidas por outro caminho
  sug.itens = sug.itens.filter(s => s.tipo !== "categoria" || !st.rules[s.key]);
  const sugMudou = JSON.stringify(sug) !== JSON.stringify(st.sugestoes || { itens: [], rejeitadas: [] });
  if (sugMudou) upserts.push({ tipo: "config", id: "sugestoes", dados: { valor: sug } });
  st.sugestoes = sug;

  for (const [k, v] of Object.entries(prep.cfgSet)) upserts.push({ tipo: "config", id: k, dados: { valor: v } });
  for (const [k, v] of Object.entries(prep.cfgMerge)) upserts.push({ tipo: "config", id: k, op: "merge", dados: { valor: v } });

  // e-mails do dia (a primeira verificação da manhã manda lembretes e resumos)
  const enviados = { ...((st.automacao || {}).enviados || {}) };
  const emails = [], novasChaves = [];
  const imp = avisoImportacao(prep, novasSug); if (imp) emails.push(imp);
  if (ag.hora < 12) {
    const lb = lembretes(st, ag, enviados); if (lb) { emails.push(lb.mail); novasChaves.push(...lb.chaves); }
    const semana = "semana:" + ag.date; if (ag.dow === 1 && !enviados[semana]) { emails.push(resumoSemanal(st, ag)); novasChaves.push(semana); }
    const mes = "mes:" + F.addMonths(ag.date.slice(0, 7), -1); if (ag.dia === 1 && !enviados[mes]) { emails.push(resumoMensal(st, ag)); novasChaves.push(mes); }
  }
  for (const k of novasChaves) enviados[k] = ag.date;
  for (const k of Object.keys(enviados)) if (diffDays(enviados[k], ag.date) > 120) delete enviados[k];

  // grava
  fs.rmSync(path.join(DIR, "lotes"), { recursive: true, force: true }); fs.rmSync(path.join(DIR, "emails"), { recursive: true, force: true });
  fs.mkdirSync(path.join(DIR, "lotes"), { recursive: true }); fs.mkdirSync(path.join(DIR, "emails"), { recursive: true });
  const ls = lotes(prep.user_id, upserts, deletes);
  ls.forEach((l, i) => fs.writeFileSync(path.join(DIR, "lotes", String(i + 1).padStart(2, "0") + ".sql"), l.sql));
  emails.forEach((e, i) => writeJSON(path.join(DIR, "emails", String(i + 1).padStart(2, "0") + ".json"), e));
  const novas = sum(prep.mensagens, m => m.novas);
  const status = { ultima: ag.iso, hoje: ag.date, hora: ag.hora, emails_lidos: prep.mensagens.length, novas, substituidas: sum(prep.mensagens, m => m.substituidas), emails_enviados: emails.map(e => e.assunto), sugestoes_pendentes: sug.itens.length, enviados, ok: true, detalhes: prep.mensagens.flatMap(m => [...m.arquivos, ...m.avisos]).slice(0, 12) };
  const [stLote] = lotes(prep.user_id, [{ tipo: "config", id: "automacao", dados: { valor: status } }], []);
  fs.writeFileSync(path.join(DIR, "status.sql"), stLote.sql);
  writeJSON(path.join(DIR, "rotulos.json"), prep.mensagens.map(m => m.id)); // todos: os sem anexo útil também, para não ler de novo
  const rel = [`# Cofrinho — execução de ${ag.date} ${ag.hora}h`, "", `E-mails lidos: ${prep.mensagens.length} · lançamentos novos: ${novas} · Apple Pay confirmadas: ${status.substituidas}`, ...prep.mensagens.flatMap(m => [`- ${m.id}: ${m.arquivos.join("; ") || "(nada)"}${m.avisos.length ? " ⚠ " + m.avisos.join("; ") : ""}`]), "",
    `Lotes para gravar: ${ls.length} (${ls.map((l, i) => `${i + 1}: ${l.n} itens, soma ${l.soma.toFixed(2)}`).join(" · ") || "nenhum"})`, `E-mails para enviar: ${emails.length}${emails.length ? " — " + emails.map(e => e.assunto).join(" | ") : ""}`, `Sugestões pendentes: ${sug.itens.length} (${novasSug.length} novas)`].join("\n");
  fs.writeFileSync(path.join(DIR, "relatorio.md"), rel);
  console.log(rel);
}

// ---------------------------------------------------------------- falha
function falha() {
  const motivo = String(args.motivo || "erro não informado").slice(0, 500), ag = agoraSP(args.agora);
  const userId = args.user;
  if (!userId) die("use --user USER_ID --motivo \"...\"");
  const [l] = lotes(userId, [{ tipo: "config", id: "automacao", op: "merge", dados: { valor: { ultima: ag.iso, hoje: ag.date, hora: ag.hora, ok: false, erro: motivo } } }], []);
  fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(path.join(DIR, "status_falha.sql"), l.sql);
  writeJSON(path.join(DIR, "email_falha.json"), email("Cofrinho · a automação não conseguiu terminar", "A automação parou", [["O que aconteceu", [motivo, "Nada foi gravado pela metade: os lotes só entram se estiverem completos. Na próxima verificação (em até 8 horas) ela tenta de novo."]]]));
  console.log("Gerado trabalho/status_falha.sql e trabalho/email_falha.json");
}

const cmd = process.argv[2];
if (cmd === "preparar") preparar().catch(e => die(e.stack || e.message));
else if (cmd === "finalizar") finalizar();
else if (cmd === "falha") falha();
else die("comando desconhecido. Use: preparar | finalizar | falha");
