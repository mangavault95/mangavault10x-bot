// Il bot delle uscite quando ASCOLTA: /start, e la scelta del nome.
//
// A cosa serve: prima, per ricevere gli avvisi, bisognava premere
// Start e poi farsi collegare a mano da riga di comando. Adesso il bot
// mostra i nomi del sito e ognuno tocca il suo — da lì in poi riceve
// soltanto le puntate delle serie che ha nella SUA videoteca, perché
// la chat è attaccata alla sua riga in `utenti` e gli avvisi partono
// dalle sue `visioni`.
//
// ⚠️ QUESTO BOT LO TROVA CHIUNQUE. Un nome su Telegram è pubblico, e il nome di questo
// bot sta in un repository pubblico. Un elenco di nomi da toccare è un invito, e per
// questo (cambiato il 14/11/2026, dopo che una prova lo ha dimostrato) NIENTE si
// scrive finché il proprietario non dice di sì:
//
//   1. Il proprietario NON compare fra i nomi e non si può scegliere. Il suo
//      collegamento vale gli avvisi e il riepilogo di tutta la casa, e poter scollegare
//      gli altri: prima bastava che fosse libero perché uno sconosciuto lo prendesse,
//      senza che nessuno ne sapesse niente.
//   2. Chi tocca un nome libero NON si collega: chiede. Al proprietario arriva un
//      messaggio con il nome Telegram di chi chiede e due bottoni, «Approva» e
//      «Rifiuta». Solo il tocco del proprietario scrive qualcosa, e solo se il tocco
//      arriva dalla SUA chat. Se il proprietario non ha la chat collegata nessuno può
//      approvare, quindi nessuno si collega.
//   3. Si chiedono solo persone ATTIVE e ancora libere: un identificativo qualunque,
//      anche uno che il bot non ha mai offerto, non basta.
//   4. Si parla solo in chat private: in un gruppo non si risponde.
//   5. Da qui non si legge e non si scrive niente della videoteca. Il peggio che si
//      può fare a vuoto è far arrivare al proprietario una richiesta in più.
//
// Il proprietario si collega (o cambia telefono) con `/start CODICE`, dove il codice è
// la variabile d'ambiente TELEGRAM_USCITE_CODICE_PROPRIETARIO (almeno 16 caratteri).
// Se non è impostata la strada non esiste e resta lo script del backend
// (`scripts/uscite-chatid.js --collega`).
//
// Residuo noto, non difeso: chi ha un bottone «tocca il tuo nome» può premerlo più volte
// e far arrivare più richieste al proprietario. Non scrive niente; è fastidio, non danno.

import crypto from "node:crypto";

import { confermaBottone, esc, invia, modifica } from "../src/telegram.js";
import * as db from "../src/uscite.js";

const gettone = () => process.env.TELEGRAM_USCITE_TOKEN;

const scrivi = (chat, testo, opzioni = {}) =>
  invia(chat, testo, { ...opzioni, gettone: gettone() });

const correggi = (chat, messaggio, testo, opzioni = {}) =>
  modifica(chat, messaggio, testo, { ...opzioni, gettone: gettone() });

const SITO = (process.env.SITO_URL || "https://mangavault10x-frontend.vercel.app").replace(
  /\/$/,
  ""
);

// --------------------------------------------------
// COSA DICE
// --------------------------------------------------

const BENVENUTO = `📺 <b>Videoteca</b> — gli avvisi delle uscite.

Ti scrivo quando esce una puntata delle serie che segui, con l'ora e la piattaforma, e la mattina ti dico cosa esce in giornata.

<b>Chi sei?</b> Tocca il tuo nome: il proprietario del sito deve confermare che sei tu.`;

/** I nomi liberi, due per riga: su un telefono tre non ci stanno. */
function bottoniDei(liberi) {
  const righe = [];

  for (let i = 0; i < liberi.length; i += 2) {
    righe.push(
      liberi.slice(i, i + 2).map((u) => ({ text: u.nickname, callback_data: `io:${u.id}` }))
    );
  }

  return righe;
}

function comeTiChiami(da) {
  const nome = [da?.first_name, da?.last_name].filter(Boolean).join(" ");
  const utente = da?.username ? ` (@${da.username})` : "";

  return esc(nome + utente) || "qualcuno";
}

// --------------------------------------------------
// IL CODICE DEL PROPRIETARIO
// --------------------------------------------------

const CODICE_MINIMO = 16;

/** Il codice è giusto? Confronto a tempo costante; senza variabile o troppo corto, mai. */
function codiceGiusto(candidato) {
  const atteso = process.env.TELEGRAM_USCITE_CODICE_PROPRIETARIO || "";

  if (atteso.length < CODICE_MINIMO || !candidato) return false;

  const hash = (t) => crypto.createHash("sha256").update(String(t)).digest();

  return crypto.timingSafeEqual(hash(atteso), hash(candidato));
}

// --------------------------------------------------
// I DUE GESTI
// --------------------------------------------------

async function gestisciMessaggio(chatId, testo, da) {
  const [primo, ...resto] = testo.trim().split(/\s+/);
  const comando = primo.toLowerCase();

  const gia = await db.chiE(chatId);

  // `/start CODICE`: il proprietario si collega, o cambia telefono. Un codice sbagliato
  // (o non impostato) non lo dice a nessuno: va avanti come un /start qualunque.
  if (comando === "/start" && resto.length > 0 && codiceGiusto(resto.join(" "))) {
    if (gia && !gia.proprietario) {
      return scrivi(chatId, `Questa chat è già collegata come <b>${esc(gia.nickname)}</b>: prima /scollega.`);
    }

    const esito = await db.collegaProprietario(chatId);

    if (!esito) return scrivi(chatId, "Non trovo il proprietario fra le persone attive del sito.");

    if (esito.prima && String(esito.prima) !== String(chatId)) {
      await scrivi(esito.prima, "🔔 Il proprietario si è ricollegato da un altro telefono: questa chat non riceve più avvisi.");
    }

    return scrivi(
      chatId,
      `✅ Ciao <b>${esc(esito.nickname)}</b>, sei collegato.\n\nCancella il messaggio con il codice.`
    );
  }

  if (comando === "/scollega") {
    if (!gia) return scrivi(chatId, "Non eri collegato a nessuno.");

    // Il proprietario non si scollega da qui: chi riuscisse a farlo per lui (un telefono
    // lasciato in giro) libererebbe il suo posto. Per cambiare telefono c'è il codice.
    if (gia.proprietario) {
      return scrivi(
        chatId,
        "Il tuo collegamento non si toglie da qui, perché nessuno possa prenderselo.\n\nPer cambiare telefono manda dal telefono nuovo: /start e il tuo codice."
      );
    }

    await db.scollega(chatId);

    return scrivi(
      chatId,
      `Fatto: non ti scrivo più.\nQuando vuoi tornare, /start.`
    );
  }

  if (gia) {
    const quante = await db.quanteSerie(gia.id);

    return scrivi(
      chatId,
      `Sei collegato come <b>${esc(gia.nickname)}</b>.\n` +
        `Ti avviso per le ${quante} serie che segui.\n\n` +
        `/scollega per smettere.`
    );
  }

  const liberi = await db.nomiLiberi();

  if (liberi.length === 0) {
    return scrivi(
      chatId,
      `Non c'è nessun nome da collegare.\n\n` +
        `Se uno di quei nomi è tuo e hai cambiato telefono, fattelo scollegare da chi tiene il sito: da qui non posso togliere un nome a qualcun altro.`
    );
  }

  return scrivi(chatId, BENVENUTO, { bottoni: bottoniDei(liberi) });
}

async function eIlProprietario(chatId) {
  const proprietario = await db.chatDelProprietario();

  return Boolean(proprietario) && String(proprietario.telegram_chat_id) === String(chatId);
}

async function gestisciBottone(chatId, richiesta) {
  const dato = richiesta.data || "";
  const messaggioId = richiesta.message?.message_id;

  // Il ripensamento del proprietario: «non è lei».
  if (dato.startsWith("via:")) {
    if (!(await eIlProprietario(chatId))) {
      return confermaBottone(richiesta.id, "Non è una cosa tua.", gettone());
    }

    const nome = await db.scollegaId(Number(dato.slice(4)));

    await confermaBottone(richiesta.id, nome ? `${nome} scollegata` : "Era già scollegata", gettone());

    return correggi(
      chatId,
      messaggioId,
      nome
        ? `🔕 <b>${esc(nome)}</b> non riceve più avvisi.`
        : `Quel collegamento non c'è più.`
    );
  }

  // La risposta del proprietario a una richiesta: `ok:<persona>:<chat>` o `no:<persona>:<chat>`.
  // ⚠️ Il controllo di chi tocca viene PRIMA di tutto: la chat di destinazione sta nei dati
  // del bottone, e solo il proprietario può far scrivere qualcosa partendo da lì.
  const risposta = /^(ok|no):(\d+):(-?\d+)$/.exec(dato);

  if (risposta) {
    if (!(await eIlProprietario(chatId))) {
      return confermaBottone(richiesta.id, "Non è una cosa tua.", gettone());
    }

    const [, esito, personaTesto, destinazione] = risposta;
    const personaId = Number(personaTesto);

    if (esito === "no") {
      await confermaBottone(richiesta.id, "Rifiutata", gettone());
      await correggi(chatId, messaggioId, "❌ Richiesta rifiutata. Non è stato collegato niente.");
      await scrivi(destinazione, "Il proprietario non ha approvato il collegamento. Se è un errore, chiediglielo di persona.");

      return null;
    }

    if (await db.chiE(destinazione)) {
      await confermaBottone(richiesta.id, "Quella chat è già collegata", gettone());

      return correggi(chatId, messaggioId, "Quella chat è già collegata a qualcuno: non ho cambiato niente.");
    }

    const nome = await db.collega(personaId, destinazione);

    if (!nome) {
      await confermaBottone(richiesta.id, "Non più disponibile", gettone());

      return correggi(chatId, messaggioId, "Quel nome nel frattempo non è più libero: non ho cambiato niente.");
    }

    await confermaBottone(richiesta.id, `${nome} collegata`, gettone());

    await correggi(chatId, messaggioId, `✅ <b>${esc(nome)}</b> collegata agli avvisi.`, {
      bottoni: [[{ text: `Non è ${nome} — scollega`, callback_data: `via:${personaId}` }]]
    });

    const quante = await db.quanteSerie(personaId);

    await scrivi(
      destinazione,
      `✅ Ciao <b>${esc(nome)}</b>.\n\n` +
        (quante > 0
          ? `Ti scrivo quando esce una puntata delle <b>${quante}</b> serie che segui, e la mattina ti dico cosa esce in giornata.`
          : `Nella tua videoteca non c'è ancora niente: aggiungi qualche serie su ${SITO} e comincio ad avvisarti.`) +
        `\n\n/scollega se cambi idea.`
    );

    return null;
  }

  if (!dato.startsWith("io:")) return confermaBottone(richiesta.id, "", gettone());

  const gia = await db.chiE(chatId);

  if (gia) {
    await confermaBottone(richiesta.id, `Sei già ${gia.nickname}`, gettone());

    return correggi(
      chatId,
      messaggioId,
      `Sei già collegato come <b>${esc(gia.nickname)}</b>.\n\n/scollega, se quel nome non è il tuo.`
    );
  }

  const utenteId = Number(dato.slice(3));
  const nome = await db.daCollegare(utenteId);

  // Nessun nome = non c'è, non è una persona attiva, è il proprietario, o quel posto se
  // l'è preso qualcun altro fra il momento in cui i bottoni sono comparsi e adesso.
  if (!nome) {
    await confermaBottone(richiesta.id, "Quel nome non è disponibile", gettone());

    const liberi = await db.nomiLiberi();

    return correggi(
      chatId,
      messaggioId,
      liberi.length > 0
        ? `Quel nome non è disponibile.\n\n<b>Chi sei?</b>`
        : `Quel nome non è disponibile, e non ne restano di liberi.`,
      { bottoni: liberi.length > 0 ? bottoniDei(liberi) : null }
    );
  }

  const proprietario = await db.chatDelProprietario();

  // Senza la chat del proprietario nessuno può approvare: meglio dirlo che collegare.
  if (!proprietario) {
    await confermaBottone(richiesta.id, "Riprova più tardi", gettone());

    return correggi(
      chatId,
      messaggioId,
      "Per collegarti serve che il proprietario del sito approvi, e ora non posso avvertirlo. Riprova fra un po'."
    );
  }

  await confermaBottone(richiesta.id, "Richiesta inviata", gettone());

  await correggi(
    chatId,
    messaggioId,
    `⏳ Ho chiesto al proprietario di confermare che sei <b>${esc(nome)}</b>. Appena risponde ti scrivo qui.`
  );

  await scrivi(
    proprietario.telegram_chat_id,
    `🔔 Qualcuno chiede di collegarsi come <b>${esc(nome)}</b>.\n` +
      `Su Telegram è ${comeTiChiami(richiesta.from)}.\n\n` +
      `È davvero ${esc(nome)}? Se non lo sai, rifiuta.`,
    {
      bottoni: [
        [
          { text: "Approva", callback_data: `ok:${utenteId}:${chatId}` },
          { text: "Rifiuta", callback_data: `no:${utenteId}:${chatId}` }
        ]
      ]
    }
  );

  return null;
}

// --------------------------------------------------
// WEBHOOK
// --------------------------------------------------

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("solo POST");

  // Il segreto lo manda Telegram in un'intestazione, e l'ha ricevuto
  // da noi quando abbiamo registrato il webhook: senza, chiunque
  // conoscesse l'indirizzo potrebbe fingersi Telegram.
  //
  // ⚠️ Il primo `if` non è ridondante ed è la riga più importante del
  // file. Senza, una variabile d'ambiente dimenticata aprirebbe la
  // porta invece di chiuderla: `undefined !== undefined` è FALSO,
  // quindi una richiesta senza intestazione passerebbe il controllo
  // proprio nel momento in cui il segreto non c'è. Un dimenticanza di
  // configurazione deve rendere il bot muto, mai spalancato.
  const atteso = process.env.TELEGRAM_USCITE_SECRET;

  if (!atteso || req.headers["x-telegram-bot-api-secret-token"] !== atteso) {
    return res.status(401).send("no");
  }

  const aggiornamento = req.body || {};
  const messaggio = aggiornamento.message;
  const bottone = aggiornamento.callback_query;
  const chatId = messaggio?.chat?.id ?? bottone?.message?.chat?.id;

  if (!chatId) return res.status(200).send("niente da fare");

  // Solo chat private: un bot aggiunto a un gruppo non risponde e non scrive niente.
  const tipoChat = messaggio?.chat?.type ?? bottone?.message?.chat?.type;

  if (tipoChat && tipoChat !== "private") return res.status(200).send("solo chat private");

  // A differenza del bot degli acquisti, qui NON si filtra per chat:
  // il punto di questo bot è che ci scrivano persone che non
  // conosciamo ancora. Quello che possono fare è nel commento in
  // cima al file: chiedere, e basta.
  try {
    if (!(await db.primaVolta(aggiornamento.update_id))) {
      return res.status(200).send("già visto");
    }

    if (bottone) await gestisciBottone(chatId, bottone);
    else if (messaggio?.text) await gestisciMessaggio(chatId, messaggio.text, messaggio.from);
    else await scrivi(chatId, "Scrivi /start.");
  } catch (errore) {
    console.error("uscite:", errore);
    await scrivi(chatId, "⚠️ Qualcosa è andato storto. Riprova fra un attimo.");
  }

  // Sempre 200, anche dopo un errore: un codice diverso fa rimandare
  // l'aggiornamento, e ritentare significherebbe rifare quello che è
  // già stato fatto.
  return res.status(200).send("ok");
}

// Esportate per le prove: `scripts/prova-uscite.js` le chiama senza
// passare da una richiesta HTTP finta.
export const _interni = { gestisciMessaggio, gestisciBottone, bottoniDei };
