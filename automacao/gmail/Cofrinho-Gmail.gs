/**
 * Cofrinho — leitura grátis do Gmail (Google Apps Script)
 *
 * Roda 3 vezes por dia (7h, 15h e 23h, horário de Brasília):
 *   1. procura e-mails novos do Nubank com extrato (OFX) ou fatura (CSV);
 *   2. manda os anexos para o Cofrinho, que junta sem duplicar e grava;
 *   3. coloca a etiqueta "Cofrinho/importado" nos e-mails lidos;
 *   4. manda para você (só para o seu próprio e-mail) os avisos, lembretes e resumos.
 *
 * Como instalar: cole este arquivo em script.google.com, salve, escolha a função
 * "instalar" no menu de cima e clique em Executar. Autorize o acesso quando o Google pedir.
 *
 * Nada aqui apaga e-mails, e nenhum e-mail é enviado para outra pessoa.
 */

var COFRINHO_URL = "https://sioknufcvpssadjbpwro.supabase.co/functions/v1/gmail-import";
var COFRINHO_TOKEN = "COLE_AQUI_O_CODIGO_DO_COFRINHO"; // o mesmo código do atalho do Apple Pay
var ETIQUETA = "Cofrinho/importado";
var BUSCA = 'from:todomundo@nubank.com.br has:attachment -label:cofrinho-importado after:2026/10/26 (subject:extrato OR subject:fatura)';
var HORAS = [7, 15, 23];

/** Rode uma vez: cria os horários automáticos e faz a primeira verificação. */
function instalar() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "verificar") ScriptApp.deleteTrigger(t);
  });
  HORAS.forEach(function (h) {
    ScriptApp.newTrigger("verificar").timeBased().everyDays(1).atHour(h).nearMinute(0).inTimezone("America/Sao_Paulo").create();
  });
  etiqueta_();
  Logger.log("Horários criados: " + HORAS.join("h, ") + "h (Brasília). Fazendo a primeira verificação…");
  verificar();
}

/** A verificação: pode rodar à mão a qualquer momento para testar. */
function verificar() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) { Logger.log("Outra verificação já está rodando."); return; }
  try {
    var threads = GmailApp.search(BUSCA, 0, 20);
    var emails = [], porId = {};
    threads.forEach(function (th) {
      th.getMessages().forEach(function (m) {
        if (!/todomundo@nubank\.com\.br/i.test(m.getFrom())) return;
        var arquivos = [];
        m.getAttachments({ includeInlineImages: false }).forEach(function (a) {
          var nome = a.getName() || "";
          if (/\.(ofx|csv)$/i.test(nome)) arquivos.push({ nome: nome, texto: a.getDataAsString("UTF-8") });
          else if (/\.pdf$/i.test(nome)) arquivos.push({ nome: nome, texto: "" }); // PDF: só o nome, para o aviso
        });
        if (!arquivos.length) return;
        emails.push({ id: m.getId(), arquivos: arquivos });
        porId[m.getId()] = th;
      });
    });
    Logger.log("E-mails do Nubank encontrados: " + emails.length);

    var resp = UrlFetchApp.fetch(COFRINHO_URL, {
      method: "post",
      contentType: "application/json",
      headers: { "x-cofrinho-token": COFRINHO_TOKEN },
      payload: JSON.stringify({ emails: emails }),
      muteHttpExceptions: true
    });
    var codigo = resp.getResponseCode(), r = {};
    try { r = JSON.parse(resp.getContentText()); } catch (e) { r = { ok: false, mensagem: "resposta inválida (" + codigo + ")" }; }
    if (codigo !== 200 || !r.ok) throw new Error(r.mensagem || ("erro " + codigo));

    // só etiqueta depois que o Cofrinho confirmou que gravou
    var lbl = etiqueta_();
    var feitos = {};
    (r.rotular || []).forEach(function (id) { var th = porId[id]; if (th && !feitos[th.getId()]) { th.addLabel(lbl); feitos[th.getId()] = true; } });

    var eu = Session.getEffectiveUser().getEmail();
    (r.emails || []).forEach(function (e) {
      GmailApp.sendEmail(eu, e.assunto, e.texto, { htmlBody: e.html, name: "Cofrinho" });
    });
    Logger.log("Pronto: " + (r.novas || 0) + " lançamento(s) novo(s). " + (r.detalhes || []).join(" | "));
    PropertiesService.getScriptProperties().deleteProperty("ultimaFalha");
  } catch (err) {
    Logger.log("Falhou: " + err.message);
    avisarFalha_(err.message);
  } finally {
    lock.releaseLock();
  }
}

/** Para desligar a leitura grátis (por exemplo, se voltar a usar a automação do Claude). */
function desligar() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "verificar") ScriptApp.deleteTrigger(t);
  });
  Logger.log("Horários automáticos removidos.");
}

function etiqueta_() {
  return GmailApp.getUserLabelByName(ETIQUETA) || GmailApp.createLabel(ETIQUETA);
}

// no máximo um aviso de falha por dia, para não lotar sua caixa
function avisarFalha_(motivo) {
  var props = PropertiesService.getScriptProperties();
  var hoje = Utilities.formatDate(new Date(), "America/Sao_Paulo", "yyyy-MM-dd");
  if (props.getProperty("ultimaFalha") === hoje) return;
  props.setProperty("ultimaFalha", hoje);
  var eu = Session.getEffectiveUser().getEmail();
  GmailApp.sendEmail(eu, "Cofrinho · a leitura do Gmail não conseguiu terminar",
    "A verificação automática do Cofrinho parou com este erro:\n\n" + motivo +
    "\n\nNada foi gravado pela metade e os e-mails não foram etiquetados, então a próxima verificação (em até 8 horas) tenta de novo.\n\nAbrir o Cofrinho: https://rafaelbt04.github.io/Gastos-/",
    { name: "Cofrinho" });
}
