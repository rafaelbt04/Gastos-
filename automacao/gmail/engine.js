// gerado por build_gmail.py — não editar à mão
// ===== Núcleo: leitura de extratos e classificação =====
const KINDS = {
  gasto: { label: "Gasto", short: "Gasto" },
  entrada: { label: "Entrada", short: "Entrada" },
  caixinha: { label: "Caixinha", short: "Caixinha" },
  investimento: { label: "Investimento", short: "Investimento" },
  interna: { label: "Entre contas", short: "Entre contas" }
};
// as 8 primeiras têm cor própria nos gráficos (ordem fixa); as demais aparecem juntas como "Outras"
const CATS_GASTO = ["Alimentação", "Pix para pessoas", "Compras online", "Conveniência e mercado", "Lazer", "Transporte", "Apps e assinaturas", "Casa e contas", "Saúde", "Educação", "Outros gastos"];
const CATS_ENTRADA = ["Salário", "Pix recebido", "Reembolso", "Outras entradas"];

// categorias antigas que foram juntadas (nome antigo -> nome novo)
const CAT_RENOMES = { "Bares e saídas": "Lazer", "Esporte e lazer": "Lazer" };
// troca nomes antigos por novos em qualquer valor ou chave (só igualdade exata); devolve a cópia e se mudou
function renomearCats(v) {
  let mudou = false;
  const go = x => {
    if (typeof x === "string") { if (CAT_RENOMES[x]) { mudou = true; return CAT_RENOMES[x]; } return x; }
    if (Array.isArray(x)) return x.map(go);
    if (x && typeof x === "object") {
      const o = {};
      for (const [k, val] of Object.entries(x)) { const nk = CAT_RENOMES[k] || k; if (nk !== k) mudou = true; const nv = go(val); if (!(nk in o)) o[nk] = nv; else if (typeof o[nk] === "number" && typeof nv === "number") o[nk] += nv; }
      return o;
    }
    return x;
  };
  const r = go(v); return { valor: r, mudou };
}
function norm(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ").trim();
}
function mkey(s) { return norm(s).replace(/ /g, "").slice(0, 60) || "x"; }
function titleCase(s) {
  return String(s).toLowerCase().replace(/(^|[\s\-\/(])([a-zà-ú])/g, (m, a, b) => a + b.toUpperCase());
}

function extractMerchant(memo) {
  const m = String(memo).trim();
  let r;
  if ((r = m.match(/^Estorno de compra \((.+)\)$/i))) return r[1].trim();
  if ((r = m.match(/^Compra no d[ée]bito(?: via NuPay)? - (.+)$/i))) return r[1].trim();
  if ((r = m.match(/^Transfer[êe]ncia (?:enviada|recebida)(?: pelo Pix)? - ([^-]+?) - /i))) return r[1].trim();
  if ((r = m.match(/^Transfer[êe]ncia (?:enviada|recebida)(?: pelo Pix)? - (.+)$/i))) return r[1].trim();
  if ((r = m.match(/^(?:Aplica[çc][ãa]o|Resgate) RDB/i))) return "Caixinha";
  if ((r = m.match(/^(?:Aplica[çc][ãa]o|Resgate) (.+)$/i))) return r[1].replace(/\s*-\s*/g, " ").trim();
  if ((r = m.match(/^Pagamento de boleto efetuado - (.+)$/i))) return r[1].trim();
  return m.split(" - ")[0].trim();
}

const KEYWORDS = [
  [/sushi|churrasc|restau|lanch|acai|granlu|ifood|pizza|burger|padaria|lanchonete|cafe|food|esfiha|pastel|aspen/, "Alimentação"],
  [/\bbar\b|poco loco|dinamite|chopp|pub\b|boteco|adega/, "Lazer"],
  [/conveniencia|oxxo|est comercial|\bmercado\b|minimercado|supermerc|carrefour|pao de acucar|atacad|assai|hortifruti/, "Conveniência e mercado"],
  [/\bvlt\b|uber|\b99\b|onibus|metro|posto|combust|estaciona|sem parar|veloe|emtu|renovias|pedagio|autoban|conectcar|ccr /, "Transporte"],
  [/sport|academia|smart ?fit|cinema|ingresso|teatro/, "Lazer"],
  [/netflix|spotify|apple|google|prime video|disney|hbo|youtube|icloud|chatgpt|openai|anthropic|claude/, "Apps e assinaturas"],
  [/bytedance|tiktok|appmax|jim com|mercadolivre|mercado livre|shopee|amazon|magalu|aliexpress|shein|kabum|pagseguro|paypal/, "Compras online"],
  [/farmacia|drogaria|droga|raia|pacheco|drogal|clinica|hospital|laborat/, "Saúde"],
  [/puc|faculdade|livraria|curso|udemy|alura/, "Educação"],
  [/cpfl|sanasa|vivo|claro|tim\b|net\b|aluguel|condominio|energia|agua/, "Casa e contas"]
];

// rules: { [merchantKey]: {kind, cat} }   settings: { ownNames: [..] }
function classify(row, rules, settings) {
  const memo = row.memo || "";
  const nm = norm(memo);
  const merchant = row.source === "cartao" ? String(row.memo).replace(/\s*-\s*parcela\s*\d+\/\d+\s*$/i, "").replace(/^Estorno de compra \((.+)\)$/i, "$1") : extractMerchant(memo);
  const key = mkey(merchant);
  const base = { merchant: titleCase(merchant), key };
  if (/^(aplicacao|resgate) rdb/.test(nm)) return { ...base, merchant: "Caixinha", key: "caixinha", kind: "caixinha", cat: "Caixinha" };
  if (/^(aplicacao|resgate) /.test(nm)) return { ...base, kind: "investimento", cat: "Carteira" };
  // regra por direção (o que entra e o que sai de uma mesma pessoa podem ser coisas diferentes); senão, a regra geral da loja
  const rule = rules && (rules[key + (row.amount > 0 ? "|+" : "|-")] || rules[key]);
  if (rule) return { ...base, kind: rule.kind, cat: rule.cat };
  if (row.amount > 0 && row.source !== "cartao" && ((settings && settings.salarioFontes) || []).some(f => f && norm(merchant + " " + memo).includes(f))) return { ...base, kind: "entrada", cat: "Salário" };
  if (/pagamento (de|da) fatura|pagamento recebido/.test(nm)) return { ...base, merchant: "Fatura do cartão", kind: "interna", cat: "Fatura do cartão" };
  const own = ((settings && settings.ownNames) || []).map(norm);
  if (own.includes(norm(merchant))) return { ...base, kind: "interna", cat: "Entre minhas contas" };
  const isPix = /pix/.test(nm);
  const isPerson = /•••|\*\*\*/.test(memo) && !/\/\d{4}-\d{2}/.test(memo);
  const mn = norm(merchant);
  if (row.amount > 0 && row.source !== "cartao") return { ...base, kind: "entrada", cat: isPix ? "Pix recebido" : "Outras entradas" };
  // no cartão, valor positivo é estorno/crédito: fica como gasto positivo e abate da categoria
  for (const [re, cat] of KEYWORDS) if (re.test(mn)) return { ...base, kind: "gasto", cat };
  if (row.source === "cartao") return { ...base, kind: "gasto", cat: "Outros gastos" };
  if (isPix && isPerson) return { ...base, kind: "gasto", cat: "Pix para pessoas" };
  return { ...base, kind: "gasto", cat: "Outros gastos" };
}

function parseOFX(text) {
  const out = [];
  const blocks = text.split(/<STMTTRN>/i).slice(1);
  const tag = (b, t) => { const r = b.match(new RegExp("<" + t + ">([^<\\r\\n]*)", "i")); return r ? r[1].trim() : ""; };
  const isCard = /<CCSTMTRS>/i.test(text);
  for (const b of blocks) {
    const d = tag(b, "DTPOSTED");
    const amt = parseFloat(tag(b, "TRNAMT").replace(",", "."));
    if (!d || isNaN(amt)) continue;
    out.push({
      id: tag(b, "FITID") || null,
      date: d.slice(0, 4) + "-" + d.slice(4, 6) + "-" + d.slice(6, 8),
      amount: amt,
      memo: tag(b, "MEMO") || tag(b, "NAME"),
      source: isCard ? "cartao" : "conta"
    });
  }
  const bal = text.match(/<LEDGERBAL>[\s\S]*?<BALAMT>([^<\r\n]+)[\s\S]*?<DTASOF>(\d{8})/i);
  if (bal && !isCard) out.saldo = { valor: parseFloat(bal[1].replace(",", ".")), data: bal[2].slice(0, 4) + "-" + bal[2].slice(4, 6) + "-" + bal[2].slice(6, 8) };
  return out;
}

function csvRows(text) {
  const rows = []; let row = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cur); rows.push(row); row = []; cur = ""; }
    else cur += c;
  }
  if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim() !== ""));
}

// "12,90" · "- 198,00" · "1.234,56" · "12.90" · "-5" → número
function parseMoneyBR(v) {
  let x = String(v ?? "").trim().replace(/\s+/g, "").replace(/^R\$/, "");
  if (!x) return null;
  const neg = /^-|^\(.*\)$/.test(x); x = x.replace(/[-()+]/g, "");
  if (x.includes(",")) x = x.replace(/\./g, "").replace(",", ".");
  const n = parseFloat(x); return isNaN(n) ? null : (neg ? -n : n);
}
function parseCSV(text, name) {
  const rows = csvRows(text.replace(/^﻿/, ""));
  if (!rows.length) return [];
  const h = rows[0].map(norm);
  const out = [];
  if (h.includes("identificador")) { // extrato da conta: Data,Valor,Identificador,Descrição
    const iD = h.indexOf("data"), iV = h.indexOf("valor"), iI = h.indexOf("identificador"), iM = h.findIndex(x => x.startsWith("descri"));
    for (const r of rows.slice(1)) {
      const [dd, mm, yy] = (r[iD] || "").split("/");
      const amt = parseFloat(String(r[iV]).replace(",", "."));
      if (!yy || isNaN(amt)) continue;
      out.push({ id: r[iI], date: `${yy}-${mm}-${dd}`, amount: amt, memo: r[iM], source: "conta" });
    }
  } else if (h.includes("title") && h.includes("amount")) { // fatura do cartão: date,title,amount
    const iD = h.indexOf("date"), iT = h.indexOf("title"), iA = h.indexOf("amount");
    const venc = (/(\d{4}-\d{2}-\d{2})/.exec(name || "") || [])[1] || null; // Nubank_AAAA-MM-DD.csv = vencimento
    const seen = {};
    for (const r of rows.slice(1)) {
      const amt = parseMoneyBR(r[iA]);
      if (!r[iD] || amt == null) continue;
      const base = "c-" + mkey(r[iD] + r[iT] + amt).slice(0, 80);
      seen[base] = (seen[base] || 0) + 1;
      const row = { id: base + "-" + seen[base], date: r[iD].slice(0, 10), amount: -amt, memo: r[iT], source: "cartao" };
      if (venc) row.fatura = venc;
      out.push(row);
    }
  }
  return out;
}

// ===== extrato da conta em PDF (Nubank) =====
// Recebe as páginas como listas de itens de texto {s, x, y} (coordenadas do PDF).
// Colunas: data | tipo (alinhado à esquerda) | descrição (pode quebrar em várias linhas) | valor.
const MESES_PT = { JAN: "01", FEV: "02", MAR: "03", ABR: "04", MAI: "05", JUN: "06", JUL: "07", AGO: "08", SET: "09", OUT: "10", NOV: "11", DEZ: "12" };
const MESES_LONGO = { JANEIRO: "01", FEVEREIRO: "02", "MARÇO": "03", MARCO: "03", ABRIL: "04", MAIO: "05", JUNHO: "06", JULHO: "07", AGOSTO: "08", SETEMBRO: "09", OUTUBRO: "10", NOVEMBRO: "11", DEZEMBRO: "12" };
function parseNubankPDF(pages) {
  const MONEY = /^[+-]?\s?\d{1,3}(\.\d{3})*,\d{2}$/, DATE = /^(\d{2}) ([A-Z]{3}) (\d{4})$/;
  const toNum = s => parseFloat(s.replace(/[+\s]/g, "").replace(/\./g, "").replace(",", "."));
  const out = []; let date = null, sign = -1, started = false, saldo = null, fim = null, cols = null, last = null, lastY = 0;
  const seen = {};
  for (const items of pages) {
    const lines = [];
    for (const it of items.slice().sort((a, b) => b.y - a.y || a.x - b.x)) {
      const l = lines.find(L => Math.abs(L.y - it.y) <= 2); l ? l.items.push(it) : lines.push({ y: it.y, items: [it] });
    }
    for (const L of lines) L.items.sort((a, b) => a.x - b.x);
    lines.sort((a, b) => b.y - a.y);
    last = null;
    for (const L of lines) {
      const txt = L.items.map(i => i.s.trim()).join(" ");
      const longs = L.items.map(i => i.s.trim().toUpperCase().match(/^(\d{1,2}) DE ([A-ZÇ]+) DE (\d{4})$/)).filter(Boolean);
      if (longs.length && !fim) { const m = longs[longs.length - 1]; if (MESES_LONGO[m[2]]) fim = `${m[3]}-${MESES_LONGO[m[2]]}-${m[1].padStart(2, "0")}`; }
      if (/^Saldo final do per[ií]odo/i.test(L.items[0].s.trim()) && L.items.length > 1 && MONEY.test(L.items[L.items.length - 1].s.trim()) && !saldo) saldo = toNum(L.items[L.items.length - 1].s.trim());
      if (/^Movimenta[cç][õo]es$/i.test(txt)) { started = true; continue; }
      if (!started) continue;
      const first = L.items[0], dm = DATE.exec(first.s.trim());
      let rest = L.items;
      if (dm && MESES_PT[dm[2]]) { date = `${dm[3]}-${MESES_PT[dm[2]]}-${dm[1]}`; rest = L.items.slice(1); if (!cols) cols = { date: first.x }; }
      if (!rest.length) continue;
      const head = rest[0].s.trim();
      if (/^Total de entradas/i.test(head)) { sign = 1; cols = { ...(cols || {}), type: rest[0].x }; last = null; continue; }
      if (/^Total de sa[ií]das/i.test(head)) { sign = -1; cols = { ...(cols || {}), type: rest[0].x }; last = null; continue; }
      if (!cols || cols.type == null || !date) continue;
      const amtItem = rest[rest.length - 1];
      const hasAmt = MONEY.test(amtItem.s.trim()) && amtItem.x > cols.type + 150;
      const body = hasAmt ? rest.slice(0, -1) : rest;
      const isType = body.length && Math.abs(body[0].x - cols.type) <= 6;
      if (hasAmt && isType) {
        const tipo = body[0].s.trim(), desc = body.slice(1).map(i => i.s.trim()).join(" ");
        if (desc && cols.desc == null) cols.desc = body[1].x;
        last = { tipo, desc, valor: toNum(amtItem.s.trim()) * sign, date };
        out.push(last); lastY = L.y; continue;
      }
      // continuação da descrição (linha só com texto na coluna da descrição, logo abaixo)
      if (!hasAmt && last && body.length && cols.desc != null && Math.abs(body[0].x - cols.desc) <= 8 && lastY - L.y < 30) {
        last.desc = (last.desc + " " + body.map(i => i.s.trim()).join(" ")).trim(); lastY = L.y; continue;
      }
      if (hasAmt && !isType) last = null;
    }
  }
  const rows = out.map(r => {
    const memo = r.desc ? `${r.tipo} - ${r.desc.replace(/\s+/g, " ").replace(/ S\. A\./g, " S.A.")}` : r.tipo;
    const base = "pdf-" + mkey(r.date + memo + r.valor).slice(0, 60);
    seen[base] = (seen[base] || 0) + 1;
    return { id: base + "-" + seen[base], date: r.date, amount: Math.round(r.valor * 100) / 100, memo, source: "conta" };
  });
  if (saldo != null && fim) rows.saldo = { valor: saldo, data: fim };
  return rows;
}
// ===== fatura do cartão em PDF (e-mail "A fatura do seu cartão Nubank está fechada") =====
function parseNubankFaturaPDF(pages, name) {
  const MONEY = /^([−-])?\s?R\$\s?(\d{1,3}(?:\.\d{3})*,\d{2})$/, DM = /^(\d{2}) ([A-Z]{3})$/;
  const num = s => parseFloat(s.replace(/\./g, "").replace(",", "."));
  const lines = [];
  for (const items of pages) {
    const ls = [];
    for (const it of items.slice().sort((a, b) => b.y - a.y || a.x - b.x)) { const l = ls.find(L => Math.abs(L.y - it.y) <= 2); l ? l.items.push(it) : ls.push({ y: it.y, items: [it] }); }
    for (const L of ls) { L.items.sort((a, b) => a.x - b.x); L.parts = L.items.map(i => i.s.trim()).filter(Boolean); L.txt = L.parts.join(" "); }
    ls.sort((a, b) => b.y - a.y); lines.push(...ls);
  }
  const all = lines.map(l => l.txt).join("\n");
  const mv = /Data de vencimento:\s*(\d{2}) ([A-Z]{3}) (\d{4})/.exec(all) || /FATURA (\d{2}) ([A-Z]{3}) (\d{4})/.exec(all);
  if (!mv || !MESES_PT[mv[2]]) return [];
  const vencPdf = `${mv[3]}-${MESES_PT[mv[2]]}-${mv[1]}`;
  const venc = (/(\d{4}-\d{2}-\d{2})/.exec(name || "") || [])[1] || vencPdf;
  const vy = +mv[3], vm = +MESES_PT[mv[2]];
  const yearFor = mon => (+mon > vm ? vy - 1 : vy);
  const moneyOf = s => { const m = MONEY.exec(s.replace(/\s+/g, " ").trim()); return m ? (m[1] ? -1 : 1) * num(m[2]) : null; };
  const meta = { venc, vencPdf };
  const grab = (re) => { const m = re.exec(all); return m ? num(m[1]) : null; };
  meta.total = grab(/no valor de\s*R\$\s?([\d.]+,\d{2})/) ?? grab(/Pagamento total da fatura\s*R\$\s?([\d.]+,\d{2})/);
  meta.saldoAbertoTotal = grab(/Saldo em aberto total\s*R\$\s?([\d.]+,\d{2})/);
  meta.saldoProxima = grab(/Saldo em aberto da próxima fatura\s*R\$\s?([\d.]+,\d{2})/);
  meta.limiteTotal = grab(/Limite total do cartão de crédito:\s*R\$\s?([\d.]+,\d{2})/);
  const out = []; let inTx = false, pag = false; const seen = {};
  for (const L of lines) {
    if (/^TRANSAÇÕES/.test(L.parts[0] || "")) { inTx = true; pag = false; continue; }
    if (!inTx) continue;
    if (/^Pagamentos$/i.test(L.parts[0] || "")) { pag = true; continue; }
    if (/^(Em cumprimento|Como assegurado|Nu Pagamentos)/.test(L.parts[0] || "")) { inTx = false; continue; }
    const d = DM.exec(L.parts[0] || ""); if (!d || !MESES_PT[d[2]]) continue;
    const valor = moneyOf(L.parts[L.parts.length - 1] || ""); if (valor == null) continue;
    let mid = L.parts.slice(1, -1).filter(p => !/^•+\s?\d{4}$/.test(p));
    let memo = mid.join(" ").trim();
    if (pag || /^Pagamento em /i.test(memo)) memo = "Pagamento recebido";
    const date = `${yearFor(MESES_PT[d[2]])}-${MESES_PT[d[2]]}-${d[1]}`;
    const amount = Math.round(-valor * 100) / 100; // compra (R$ +) vira gasto negativo; crédito/estorno (−R$) vira positivo
    const base = "fp-" + mkey(venc + date + memo + amount).slice(0, 70);
    seen[base] = (seen[base] || 0) + 1;
    out.push({ id: base + "-" + seen[base], date, amount, memo, source: "cartao", fatura: venc });
  }
  out.meta = meta;
  return out;
}

// chave da loja num lançamento de cartão, sem "Parcela k/n" nem "Estorno de compra (...)"
function cardKey(t) {
  const m = String(t.memo || "").replace(/\s*-\s*parcela\s*\d+\s*\/\s*\d+\s*$/i, "").replace(/^Estorno de compra \((.+)\)$/i, "$1");
  return norm(m).replace(/ /g, "").slice(0, 10);
}
function parcelaKN(t) { const m = /parcela\s*(\d+)\s*\/\s*(\d+)/i.exec(t.memo || ""); return m ? m[1] + "/" + m[2] : ""; }
const daysDiff = (a, b) => Math.round((new Date(b + "T12:00:00") - new Date(a + "T12:00:00")) / 864e5);

// ===== lançamentos que pedem confirmação do usuário =====
// Gasto sem categoria clara, Pix para/de pessoas (pode ser gasto, repasse ou reembolso) e entradas genéricas.
function precisaRevisao(t) {
  if (t.manual || t.revisado || t.provisorio) return false;
  if (t.kind === "gasto" && (t.cat === "Outros gastos" || t.cat === "Pix para pessoas")) return true;
  if (t.kind === "entrada" && (t.cat === "Pix recebido" || t.cat === "Outras entradas")) return true;
  return false;
}

// ===== junção de uma importação com o que já existe (usada pelo app e pela automação) =====
// Evita duplicar: mesmo id; mesmo lançamento da conta vindo em PDF/OFX/CSV (data+valor+descrição);
// mesma compra do cartão vinda em CSV e em PDF (fatura+loja+parcela+valor, com tolerância de 2 centavos).
// Compras provisórias do Apple Pay são substituídas pela compra real da fatura (valor igual, até 3 dias de diferença).
function mergeImport(existing, rows, rules, settings) {
  const res = { add: [], update: [], remove: [], novas: 0, repetidas: 0, substituidas: 0 };
  const byId = new Map(existing.map(t => [t.id, t]));
  const sigs = new Map();
  for (const t of existing) if (t.source === "conta") { const k = txSig(t); sigs.set(k, (sigs.get(k) || 0) + 1); }
  const cardPool = existing.filter(t => t.source === "cartao" && !t.provisorio);
  const usedCard = new Set();
  const prov = existing.filter(t => t.provisorio);
  const usedProv = new Set();
  for (const r of rows) {
    if (!r.id) r.id = "m-" + mkey(r.date + r.memo + r.amount);
    const ex = byId.get(r.id);
    if (ex) { if (r.fatura && ex.fatura !== r.fatura) { ex.fatura = r.fatura; res.update.push(ex); } res.repetidas++; continue; }
    if (r.source === "conta") { const k = txSig(r), n = sigs.get(k) || 0; if (n > 0) { sigs.set(k, n - 1); res.repetidas++; continue; } }
    if (r.source === "cartao") {
      const ck = cardKey(r), kn = parcelaKN(r), cents = Math.round(r.amount * 100);
      const hit = cardPool.find(t => !usedCard.has(t.id) && Math.abs(Math.round(t.amount * 100) - cents) <= 2 && cardKey(t) === ck && parcelaKN(t) === kn &&
        (t.fatura && r.fatura ? Math.abs(daysDiff(t.fatura, r.fatura)) <= 5 : Math.abs(daysDiff(t.date, r.date)) <= 3));
      if (hit) { usedCard.add(hit.id); if (r.fatura && hit.fatura !== r.fatura) { hit.fatura = r.fatura; res.update.push(hit); } res.repetidas++; continue; }
    }
    const nt = { ...r, ...classify(r, rules, settings), manual: false };
    // compra do Apple Pay pode ter sido no crédito (vem na fatura) ou no débito (vem no extrato como "Compra no débito")
    if (r.amount < 0 && (r.source === "cartao" || /^compra no d[ée]bito/i.test(r.memo || ""))) {
      const p = prov.find(t => !usedProv.has(t.id) && Math.abs(Math.round(t.amount * 100) - Math.round(r.amount * 100)) <= 1 && Math.abs(daysDiff(t.date, r.date)) <= 3);
      if (p) { usedProv.add(p.id); res.remove.push(p); res.substituidas++; if (p.manual) { nt.kind = p.kind; nt.cat = p.cat; nt.manual = true; } }
    }
    res.add.push(nt); res.novas++;
  }
  return res;
}

// assinatura para achar o mesmo lançamento vindo de formatos diferentes (OFX × PDF)
function txSig(t) { return t.date + "|" + Math.round(t.amount * 100) + "|" + norm(t.memo).replace(/ /g, "").slice(0, 20); }

function parseStatement(name, text) {
  if (/\.ofx$/i.test(name) || /<OFX>/i.test(text)) return parseOFX(text);
  return parseCSV(text, name);
}

if (typeof module !== "undefined") module.exports = { renomearCats, CAT_RENOMES, precisaRevisao, parseNubankFaturaPDF, cardKey, parcelaKN, mergeImport, parseMoneyBR, parseOFX, parseCSV, parseNubankPDF, txSig, classify, parseStatement, mkey, norm, KINDS, CATS_GASTO, CATS_ENTRADA };

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
  const comprometidoAteSalario = r2(totDeb + totFat);
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
  return { saldo, caixinhas: cx, colchao: p.colchao, proxSalario: prox, ate, diasAte, debitos, faturas, totDeb, totFat, comprometidoAteSalario, seguro, necessidade, investivel, paraReserva, paraInvest, recebido, salarioAinda, falta, saldoData: p.saldoConta ? p.saldoConta.data : null, fc };
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


// ===== motor da importação grátis (mesmo código da automação do Claude) =====
const APP_URL = "https://rafaelbt04.github.io/Gastos-/";
const __E = (() => {
const core = { precisaRevisao, mergeImport, parseOFX, parseStatement };
const F = { perfilOf, isSalaryTx, reconcile, faturaCiclos, plano, disponivel, addMonths, projecao, recomendacoes, subOcc, sugestoes };
const fmt = v => (v < -0.004 ? "−" : "") + "R$ " + Math.abs(v || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt0 = v => "R$ " + Math.round(Math.abs(v || 0)).toLocaleString("pt-BR");
const r2 = v => Math.round((v + Number.EPSILON) * 100) / 100;
const sum = (a, f = x => x) => a.reduce((s, x) => s + (f(x) || 0), 0);
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
function stateFrom(e) {
  const c = e.config || {};
  return { tx: e.tx.map(t => ({ ...t })), rules: c.rules || {}, budgets: c.budgets || {}, settings: c.settings || { ownNames: [] }, wallet: c.wallet || null, imports: c.imports || [],
    perfil: c.perfil || {}, assinaturas: c.assinaturas || [], parcelas: c.parcelas || [], fixas: c.fixas || [], sugestoes: c.sugestoes || { itens: [], rejeitadas: [] }, automacao: c.automacao || { enviados: {} }, faturas: c.faturas || {} };
}
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
  const nr = st.tx.filter(core.precisaRevisao).length; if (nr) avisos.push(`${nr} lançamento(s) esperando você dizer o que são (Gastos → Revisar).`);
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
  const novosRev = prep.changes.add.filter(core.precisaRevisao);
  if (novosRev.length) sec.push(["Para você revisar no app (Gastos → Revisar)", novosRev.slice(0, 8).map(t => `${t.merchant}: ${fmt(t.amount)} (${t.cat})`)]);
  const assunto = novas || subs ? `Cofrinho · ${novas} lançamento(s) importado(s)${subs ? `, ${subs} do Apple Pay confirmado(s)` : ""}${novasSug.length ? ` e ${novasSug.length} sugestão(ões)` : ""}` : `Cofrinho · ${novasSug.length} sugestão(ões) para aprovar`;
  return email(assunto, novas || subs ? "Extrato importado" : "Sugestões para aprovar", novas || subs ? sec : sec.slice(1));
}

// ---------------------------------------------------------------- leitura dos anexos de um e-mail
// O Nubank manda o extrato da conta em OFX + PDF + CSV juntos: usamos o OFX (ou o CSV se faltar).
// A fatura do cartão pedida no app vem em CSV (Nubank_AAAA-MM-DD.csv). PDFs não são lidos aqui.
function lerEmail(arquivos) {
  const out = { conta: null, cartao: [], ignorados: [], nomes: arquivos.map(a => a.nome) };
  const txt = a => String(a.texto || "");
  const ofx = arquivos.find(a => /^NU_.*\.ofx$/i.test(a.nome)) || arquivos.find(a => /\.ofx$/i.test(a.nome) && /<OFX>/i.test(txt(a)) && !/<CCSTMTRS>/i.test(txt(a)));
  const contaCsv = arquivos.find(a => /^NU_.*\.csv$/i.test(a.nome));
  if (ofx) out.conta = { arquivo: ofx.nome, rows: core.parseOFX(txt(ofx)) };
  else if (contaCsv) out.conta = { arquivo: contaCsv.nome, rows: core.parseStatement(contaCsv.nome, txt(contaCsv)) };
  for (const a of arquivos) {
    if (/^Nubank_.*\.csv$/i.test(a.nome)) { const rows = core.parseStatement(a.nome, txt(a)); if (rows.length && rows[0].source === "cartao") out.cartao.push({ arquivo: a.nome, rows }); else out.ignorados.push(a.nome); }
    else if (a !== ofx && a !== contaCsv) out.ignorados.push(a.nome);
  }
  return out;
}

// ---------------------------------------------------------------- uma verificação completa
// st: estado do usuário · emails: [{id, arquivos:[{nome, texto}]}] · agora: agoraSP()
// devolve o que gravar (upserts/deletes) e os e-mails para mandar ao próprio usuário
function processar(st, emails, ag) {
  const changes = { add: new Map(), update: new Map(), remove: new Map() }, cfgSet = {}, cfgMerge = {}, mensagens = [];
  for (const em of emails) {
    const m = lerEmail(em.arquivos || []);
    const info = { id: em.id, arquivos: [], novas: 0, repetidas: 0, substituidas: 0, avisos: [] };
    const grupos = [];
    if (m.conta) grupos.push({ tipo: "conta", ...m.conta });
    for (const c of m.cartao) grupos.push({ tipo: "cartao", ...c });
    if (!grupos.length) {
      const soPdf = m.nomes.length && m.nomes.every(n => /\.pdf$/i.test(n));
      info.avisos.push(soPdf ? `só PDF (${m.nomes.join(", ")}): no modo grátis a fatura é lida pelo CSV — peça a fatura em CSV no app do Nubank` : "nenhum extrato ou fatura reconhecido nos anexos: " + (m.nomes.join(", ") || "sem anexos"));
    }
    for (const g of grupos) {
      const r = core.mergeImport(st.tx, g.rows, st.rules, st.settings);
      for (const t of r.add) { st.tx.push(t); changes.add.set(t.id, t); }
      for (const t of r.update) if (!changes.add.has(t.id)) changes.update.set(t.id, t);
      for (const t of r.remove) { st.tx = st.tx.filter(x => x.id !== t.id); changes.add.delete(t.id); changes.update.delete(t.id); changes.remove.set(t.id, t); }
      info.novas += r.novas; info.repetidas += r.repetidas; info.substituidas += r.substituidas;
      info.arquivos.push(`${g.arquivo} (${r.novas} novas, ${r.repetidas} já estavam${r.substituidas ? `, ${r.substituidas} do Apple Pay confirmadas` : ""})`);
      st.imports.push({ arquivo: g.arquivo, tipo: g.tipo === "conta" ? "conta" : "cartao", em: ag.iso, novas: r.novas, repetidas: r.repetidas, auto: true, google: true });
      if (g.rows.saldo) { const cur = st.perfil.saldoConta; if (!cur || !(cur.data > g.rows.saldo.data)) { st.perfil.saldoConta = { ...g.rows.saldo, fonte: "extrato" }; cfgMerge.perfil = { ...(cfgMerge.perfil || {}), saldoConta: st.perfil.saldoConta }; } }
    }
    mensagens.push(info);
  }
  // salário: entradas da fonte pagadora viram "Salário" (mesma regra do app)
  const p = F.perfilOf(st);
  if (p.salario) for (const t of st.tx) if (F.isSalaryTx(t, p) && (t.cat !== "Salário" || t.kind !== "entrada")) { t.kind = "entrada"; t.cat = "Salário"; if (!changes.add.has(t.id)) changes.update.set(t.id, t); }
  if (mensagens.some(m => m.arquivos.length)) cfgSet.imports = st.imports.slice(-30);

  const upserts = [], deletes = [];
  const semId = t => { const { id, ...d } = t; return d; };
  for (const t of [...changes.add.values(), ...changes.update.values()]) upserts.push({ tipo: "tx", id: t.id, dados: semId(t) });
  for (const t of changes.remove.values()) deletes.push({ tipo: "tx", id: t.id });

  // sugestões de assinatura e parcelamento (você aprova no app)
  const sug = { itens: [...(st.sugestoes.itens || [])], rejeitadas: [...(st.sugestoes.rejeitadas || [])] };
  const has = id => sug.itens.some(s => s.id === id) || sug.rejeitadas.includes(id);
  const novasSug = [];
  const push = s => { if (has(s.id)) return; s.criada = ag.date; sug.itens.push(s); novasSug.push(s); };
  const sg = F.sugestoes(st);
  for (const a of sg.assinaturas.filter(a => a.visto >= 2 || a.cat === "Apps e assinaturas")) push({ id: "sub:" + a.chave, tipo: "assinatura", dados: a, texto: `Assinatura: ${a.nome}, ${fmt(a.valor)} por mês` });
  for (const pp of sg.parcelas.filter(pp => +pp.atual < +pp.n)) push({ id: "parc:" + pp.chave, tipo: "parcela", dados: pp, texto: `Parcelamento: ${pp.desc}, ${pp.atual}/${pp.n} de ${fmt(pp.valorParcela)}` });
  sug.itens = sug.itens.filter(s => s.tipo !== "categoria" || !st.rules[s.key]);
  if (JSON.stringify(sug) !== JSON.stringify(st.sugestoes || { itens: [], rejeitadas: [] })) cfgSet.sugestoes = sug;
  st.sugestoes = sug;

  // e-mails: aviso de importação sempre que houver novidade; lembretes e resumos na verificação da manhã
  const prep = { mensagens, state: st, agora: ag, cfgMerge, changes: { add: [...changes.add.values()] } };
  const enviados = { ...((st.automacao || {}).enviados || {}) };
  const saida = [], novasChaves = [];
  const imp = avisoImportacao(prep, novasSug); if (imp) saida.push(imp);
  if (ag.hora < 12) {
    const lb = lembretes(st, ag, enviados); if (lb) { saida.push(lb.mail); novasChaves.push(...lb.chaves); }
    const semana = "semana:" + ag.date; if (ag.dow === 1 && !enviados[semana]) { saida.push(resumoSemanal(st, ag)); novasChaves.push(semana); }
    const mes = "mes:" + F.addMonths(ag.date.slice(0, 7), -1); if (ag.dia === 1 && !enviados[mes]) { saida.push(resumoMensal(st, ag)); novasChaves.push(mes); }
  }
  for (const k of novasChaves) enviados[k] = ag.date;
  for (const k of Object.keys(enviados)) if (diffDays(enviados[k], ag.date) > 120) delete enviados[k];

  const novas = sum(mensagens, m => m.novas);
  const status = { ultima: ag.iso, hoje: ag.date, hora: ag.hora, modo: "google", emails_lidos: mensagens.length, novas, substituidas: sum(mensagens, m => m.substituidas), emails_enviados: saida.map(e => e.assunto), sugestoes_pendentes: sug.itens.length, enviados, ok: true, detalhes: mensagens.flatMap(m => [...m.arquivos, ...m.avisos]).slice(0, 12) };
  return { upserts, deletes, cfgSet, cfgMerge, status, emails: saida, mensagens, novas };
}

return { processar, agoraSP, stateFrom };
})();
export const processar = __E.processar, agoraSP = __E.agoraSP, stateFrom = __E.stateFrom;
