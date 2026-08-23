// Il bot delle uscite quando ASCOLTA: /start, e la scelta del nome.
//
// A cosa serve: prima, per ricevere gli avvisi, bisognava premere
// Start e poi farsi collegare a mano da riga di comando. Adesso il bot
// mostra i nomi del sito e ognuno tocca il suo — da lì in poi riceve
// soltanto le puntate delle serie che ha nella SUA videoteca, perché
// la chat è attaccata alla sua riga in `utenti` e gli avvisi partono
// dalle sue `visioni`.
//
// ⚠️ QUESTO BOT LO TROVA CHIUNQUE. Un nome su Telegram è pubblico, e
// un elenco di nomi da toccare è un invito. Le difese sono tre, e
// nessuna delle tre da sola basterebbe:
//
//   1. Si possono scegliere solo i nomi ANCORA LIBERI. Chi è già
//      collegato non compare: nessuno può soffiare gli avvisi a chi
//      li sta già ricevendo.
//   2. Ogni collegamento viene DETTO al proprietario, con il nome
//      Telegram di chi l'ha fatto e un bottone per disfarlo. Niente
//      succede in silenzio.
//   3. Da qui non si legge e non si scrive niente della videoteca: si
//      scrive un identificativo di chat su una riga, e basta. Il
//      peggio che può fare un estraneo è ricevere l'elenco delle
//      puntate di qualcun altro — e il proprietario lo vede subito.
//
// Serviva una difesa più forte (un codice da copiare dal sito) se da
// qui si potesse leggere o cambiare qualcosa. Non si può.

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

<b>Chi sei?</b> Tocca il tuo nome.`;

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
// I DUE GESTI
// --------------------------------------------------

async function gestisciMessaggio(chatId, testo, da) {
  const comando = testo.trim().toLowerCase().split(/\s+/)[0];

  const gia = await db.chiE(chatId);

  if (comando === "/scollega") {
    if (!gia) return scrivi(chatId, "Non eri collegato a nessuno.");

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

  const tutti = await db.lettori();
  const liberi = tutti.filter((u) => !u.collegato);

  if (liberi.length === 0) {
    return scrivi(
      chatId,
      `Sono tutti già collegati.\n\n` +
        `Se uno di quei nomi è tuo e hai cambiato telefono, fattelo scollegare da chi tiene il sito: da qui non posso togliere un nome a qualcun altro.`
    );
  }

  return scrivi(chatId, BENVENUTO, { bottoni: bottoniDei(liberi) });
}

async function gestisciBottone(chatId, richiesta) {
  const dato = richiesta.data || "";
  const messaggioId = richiesta.message?.message_id;

  // Il ripensamento del proprietario: «non è lei».
  if (dato.startsWith("via:")) {
    const proprietario = await db.chatDelProprietario();

    if (!proprietario || String(proprietario.telegram_chat_id) !== String(chatId)) {
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
  const nome = await db.collega(utenteId, chatId);

  // Nessun nome tornato indietro = quel posto se l'è preso qualcun
  // altro fra il momento in cui i bottoni sono comparsi e adesso.
  if (!nome) {
    await confermaBottone(richiesta.id, "Quel nome è già preso", gettone());

    const liberi = (await db.lettori()).filter((u) => !u.collegato);

    return correggi(
      chatId,
      messaggioId,
      liberi.length > 0
        ? `Quel nome nel frattempo se l'è preso qualcun altro.\n\n<b>Chi sei?</b>`
        : `Quel nome nel frattempo se l'è preso qualcun altro, e non ne restano di liberi.`,
      { bottoni: liberi.length > 0 ? bottoniDei(liberi) : null }
    );
  }

  const quante = await db.quanteSerie(utenteId);

  await confermaBottone(richiesta.id, `Ciao ${nome}`, gettone());

  await correggi(
    chatId,
    messaggioId,
    `✅ Ciao <b>${esc(nome)}</b>.\n\n` +
      (quante > 0
        ? `Ti scrivo quando esce una puntata delle <b>${quante}</b> serie che segui, e la mattina ti dico cosa esce in giornata.`
        : `Nella tua videoteca non c'è ancora niente: aggiungi qualche serie su ${SITO} e comincio ad avvisarti.`) +
      `\n\n/scollega se cambi idea.`
  );

  // Il proprietario deve saperlo. Non è un controllo: è che un
  // collegamento fatto da un estraneo, se nessuno lo dice, non lo
  // scopre nessuno.
  const proprietario = await db.chatDelProprietario();

  if (proprietario && String(proprietario.telegram_chat_id) !== String(chatId)) {
    await scrivi(
      proprietario.telegram_chat_id,
      `🔔 <b>${esc(nome)}</b> si è collegata agli avvisi.\n` +
        `Su Telegram è ${comeTiChiami(richiesta.from)}.`,
      { bottoni: [[{ text: `Non è ${nome} — scollega`, callback_data: `via:${utenteId}` }]] }
    );
  }

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

  // A differenza del bot degli acquisti, qui NON si filtra per chat:
  // il punto di questo bot è che ci scrivano persone che non
  // conosciamo ancora. Quello che possono fare è nel commento in
  // cima al file.
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
