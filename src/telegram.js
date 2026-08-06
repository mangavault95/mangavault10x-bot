// Il minimo indispensabile per parlare con Telegram: mandare un
// messaggio, correggerlo, spegnere il cerchietto dei bottoni.
//
// Niente librerie: le tre chiamate che servono sono tre POST con un
// JSON dentro, e una dipendenza in meno è un aggiornamento in meno da
// rincorrere su una funzione che deve solo rispondere in fretta.

const TIMEOUT = 12000;

function indirizzo(metodo) {
  return `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${metodo}`;
}

async function chiama(metodo, corpo) {
  const risposta = await fetch(indirizzo(metodo), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(corpo),
    signal: AbortSignal.timeout(TIMEOUT)
  });

  const json = await risposta.json().catch(() => ({}));

  if (!json.ok) {
    // Non rilancio: se Telegram rifiuta un messaggio, l'acquisto è
    // già scritto sul database e far fallire tutta la richiesta
    // significherebbe farsi rimandare l'aggiornamento e registrarlo
    // due volte.
    console.error(`Telegram ${metodo}:`, json.description || risposta.status);
  }

  return json.result || null;
}

/** Il testo va in HTML: quello che arriva da fuori va disinnescato. */
export function esc(testo) {
  return String(testo ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function invia(chatId, testo, { bottoni = null, anteprima = false } = {}) {
  return chiama("sendMessage", {
    chat_id: chatId,
    text: testo,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: !anteprima },
    ...(bottoni ? { reply_markup: { inline_keyboard: bottoni } } : {})
  });
}

export function modifica(chatId, messaggioId, testo, { bottoni = null } = {}) {
  return chiama("editMessageText", {
    chat_id: chatId,
    message_id: messaggioId,
    text: testo,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    reply_markup: bottoni ? { inline_keyboard: bottoni } : { inline_keyboard: [] }
  });
}

/**
 * Va chiamata comunque, anche senza niente da dire: finché non arriva,
 * il bottone resta a girare e sembra che il bot sia morto.
 */
export function confermaBottone(idRichiesta, testo = "") {
  return chiama("answerCallbackQuery", { callback_query_id: idRichiesta, text: testo });
}
