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
