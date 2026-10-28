// Cofrinho — importação grátis pelo Google.
// Um Apps Script na conta Google do usuário lê os e-mails do Nubank e manda os anexos (texto)
// para cá. Esta função lê os arquivos, junta sem duplicar, grava e devolve os e-mails de aviso.
// Ela nunca manda e-mail: quem envia é o script, sempre para a própria conta do usuário.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { processar, agoraSP, stateFrom } from "https://cdn.jsdelivr.net/gh/rafaelbt04/Gastos-@3caaa21f855bb7b961d673559c66aeae6a14d45f/automacao/gmail/engine.js";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
const MAX_ARQ = 2_000_000; // caracteres por arquivo

async function carregar(user: string) {
  const all: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("registros").select("tipo,id,dados").eq("user_id", user).range(from, from + 999);
    if (error) throw new Error("leitura: " + error.message);
    all.push(...data);
    if (data.length < 1000) break;
  }
  const tx: any[] = [], config: Record<string, unknown> = {};
  for (const r of all) r.tipo === "tx" ? tx.push({ id: r.id, ...r.dados }) : (config[r.id] = r.dados?.valor);
  return { tx, config };
}

Deno.serve(async (req) => {
  if (req.method === "GET") return json({ ok: true, mensagem: "Cofrinho: importação pelo Google ativa." });
  if (req.method !== "POST") return json({ ok: false, mensagem: "Use POST." }, 405);
  const token = String(req.headers.get("x-cofrinho-token") || "").trim();
  if (!/^[0-9a-f]{20,64}$/i.test(token)) return json({ ok: false, mensagem: "Código do Cofrinho ausente ou inválido." }, 401);
  const { data: tk } = await sb.from("atalho_tokens").select("user_id").eq("token", token).maybeSingle();
  if (!tk) return json({ ok: false, mensagem: "Código do Cofrinho não reconhecido." }, 401);
  const user = tk.user_id as string;

  let body: any = {};
  try { body = await req.json(); } catch { return json({ ok: false, mensagem: "Pedido inválido." }, 400); }
  const emails = (Array.isArray(body.emails) ? body.emails : []).slice(0, 30).map((e: any) => ({
    id: String(e.id || "").slice(0, 64),
    arquivos: (Array.isArray(e.arquivos) ? e.arquivos : []).slice(0, 10).map((a: any) => ({ nome: String(a.nome || "").slice(0, 200), texto: String(a.texto || "").slice(0, MAX_ARQ) })),
  }));
  const ag = agoraSP();
  try {
    const est = await carregar(user);
    const st = stateFrom(est);
    const r = processar(st, emails, ag);

    // grava: lançamentos, configurações e o status da automação
    const rows: any[] = r.upserts.map((u: any) => ({ user_id: user, tipo: u.tipo, id: u.id, dados: u.dados, atualizado_em: new Date().toISOString() }));
    for (const [k, v] of Object.entries(r.cfgSet)) rows.push({ user_id: user, tipo: "config", id: k, dados: { valor: v }, atualizado_em: new Date().toISOString() });
    for (const [k, v] of Object.entries(r.cfgMerge)) {
      if (k in r.cfgSet) continue;
      const cur = (est.config[k] && typeof est.config[k] === "object") ? est.config[k] as Record<string, unknown> : {};
      rows.push({ user_id: user, tipo: "config", id: k, dados: { valor: { ...cur, ...(v as Record<string, unknown>) } }, atualizado_em: new Date().toISOString() });
    }
    rows.push({ user_id: user, tipo: "config", id: "automacao", dados: { valor: r.status }, atualizado_em: new Date().toISOString() });
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await sb.from("registros").upsert(rows.slice(i, i + 500), { onConflict: "user_id,tipo,id" });
      if (error) throw new Error("gravação: " + error.message);
    }
    if (r.deletes.length) {
      const { error } = await sb.from("registros").delete().eq("user_id", user).eq("tipo", "tx").in("id", r.deletes.map((d: any) => d.id));
      if (error) throw new Error("remoção: " + error.message);
    }
    return json({ ok: true, novas: r.novas, rotular: emails.map((e: any) => e.id), emails: r.emails, detalhes: r.status.detalhes });
  } catch (e) {
    const motivo = String((e as Error)?.message || e).slice(0, 300);
    const { data: cur } = await sb.from("registros").select("dados").eq("user_id", user).eq("tipo", "config").eq("id", "automacao").maybeSingle();
    const prev = (cur?.dados?.valor && typeof cur.dados.valor === "object") ? cur.dados.valor : {};
    await sb.from("registros").upsert({ user_id: user, tipo: "config", id: "automacao", dados: { valor: { ...prev, ultima: ag.iso, hoje: ag.date, hora: ag.hora, modo: "google", ok: false, erro: motivo } } }, { onConflict: "user_id,tipo,id" });
    return json({ ok: false, mensagem: "Não consegui processar agora: " + motivo }, 500);
  }
});
