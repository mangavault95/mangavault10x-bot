// Il minimo indispensabile per parlare con Telegram: mandare un
// messaggio, correggerlo, spegnere il cerchietto dei bottoni.
//
// Niente librerie: le tre chiamate che servono sono tre POST con un
// JSON dentro, e una dipendenza in meno è un aggiornamento in meno da
// rincorrere su una funzione che deve solo rispondere in fretta.

const TIMEOUT = 12000;

// Di bot ce ne sono due: quello degli acquisti (questo, di suo) e
// quello delle uscite, che parla dalla stessa casa. Il gettone si
// passa solo quando non è quello di sempre, così tutte le chiamate
// scritte prima che il secondo bot esistesse restano com'erano.
function indirizzo(metodo, gettone) {
  return `https://api.telegram.org/bot${gettone || process.env.TELEGRAM_BOT_TOKEN}/${metodo}`;
}

async function chiama(metodo, corpo, gettone) {
  let risposta;

  try {
    risposta = await fetch(indirizzo(metodo, gettone), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(corpo),
      signal: AbortSignal.timeout(TIMEOUT)
    });
  } catch (errore) {
    // Vale anche per la rete, non solo per un rifiuto: una chiamata
    // scaduta dopo che l'acquisto è già scritto non deve diventare un
    // errore dell'intera richiesta (vedi sotto).
    console.error(`Telegram ${metodo}:`, errore.message);
    return null;
  }

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

// Telegram rifiuta un messaggio più lungo di 4096 caratteri, e lo
// rifiuta per intero: un /mese con settanta acquisti non arrivava
// affatto. Il margine è per non contare al carattere.
const LUNGHEZZA_MASSIMA = 3900;

/**
 * Un testo lungo in più pezzi, tagliato a fine riga.
 *
 * I messaggi del bot sono elenchi, una voce per riga, e ogni riga
 * chiude i tag che apre: tagliando fra una riga e l'altra nessun pezzo
 * resta con un `<b>` a metà.
 */
export function spezza(testo, massimo = LUNGHEZZA_MASSIMA) {
  const pezzi = [];
  let corrente = "";

  for (const riga of String(testo).split("\n")) {
    // Una riga sola più lunga del tetto non dovrebbe esistere; se
    // esiste si taglia dov'è, meglio storta che non recapitata.
    const fette = riga.length > massimo ? riga.match(new RegExp(`.{1,${massimo}}`, "gs")) : [riga];

    for (const fetta of fette) {
      if (corrente && corrente.length + 1 + fetta.length > massimo) {
        pezzi.push(corrente);
        corrente = fetta;
      } else {
        corrente = corrente ? `${corrente}\n${fetta}` : fetta;
      }
    }
  }

  if (corrente || pezzi.length === 0) pezzi.push(corrente);

  return pezzi;
}

/**
 * `callback_data` ha un tetto di 64 byte, e Telegram quando un bottone
 * lo supera rifiuta TUTTO il messaggio: la domanda non arrivava e chi
 * aveva scritto restava senza risposta. Meglio la domanda senza
 * bottoni e una riga che dice cosa fare.
 */
function bottoniCheEntrano(testo, bottoni) {
  if (!bottoni) return { testo, bottoni };

  const misura = (t) => new TextEncoder().encode(String(t ?? "")).length;
  const sfora = bottoni.some((riga) => riga.some((b) => misura(b.callback_data) > 64));

  if (!sfora) return { testo, bottoni };

  return {
    testo: `${testo}\n\n⚠️ Sono troppi volumi per chiedertelo coi bottoni: rimandali in due o più messaggi.`,
    bottoni: null
  };
}

/** Il testo va in HTML: quello che arriva da fuori va disinnescato. */
export function esc(testo) {
  return String(testo ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export async function invia(chatId, testoGrezzo, { bottoni: bottoniChiesti = null, anteprima = false, gettone = null } = {}) {
  const { testo, bottoni } = bottoniCheEntrano(testoGrezzo, bottoniChiesti);
  const pezzi = spezza(testo);
  let ultimo = null;

  // In ordine, uno alla volta: mandati insieme arriverebbero mescolati.
  // I bottoni vanno sotto l'ultimo pezzo, dove finisce chi legge.
  for (let i = 0; i < pezzi.length; i += 1) {
    const inFondo = i === pezzi.length - 1;

    ultimo = await chiama(
      "sendMessage",
      {
        chat_id: chatId,
        text: pezzi[i],
        parse_mode: "HTML",
        link_preview_options: { is_disabled: !anteprima },
        ...(bottoni && inFondo ? { reply_markup: { inline_keyboard: bottoni } } : {})
      },
      gettone
    );
  }

  return ultimo;
}

export function modifica(chatId, messaggioId, testoGrezzo, { bottoni: bottoniChiesti = null, gettone = null } = {}) {
  const { testo, bottoni } = bottoniCheEntrano(testoGrezzo, bottoniChiesti);

  return chiama(
    "editMessageText",
    {
      chat_id: chatId,
      message_id: messaggioId,
      text: testo,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: bottoni ? { inline_keyboard: bottoni } : { inline_keyboard: [] }
    },
    gettone
  );
}

/**
 * Va chiamata comunque, anche senza niente da dire: finché non arriva,
 * il bottone resta a girare e sembra che il bot sia morto.
 */
export function confermaBottone(idRichiesta, testo = "", gettone = null) {
  return chiama(
    "answerCallbackQuery",
    { callback_query_id: idRichiesta, text: testo },
    gettone
  );
}
