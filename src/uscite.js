// Quello che serve al bot delle uscite per sapere chi gli sta
// parlando: l'elenco dei lettori, e il collegamento fra una chat di
// Telegram e una persona del sito.
//
// Il bot delle uscite è nato per MANDARE — quella metà sta nel
// backend, in `services/avvisi.js`, ed è giusto che stia lì: manda a
// orario, da un lavoro schedulato, e non ha bisogno di essere sveglia.
//
// Questa è l'altra metà, quella che ASCOLTA, e sta qui per la stessa
// ragione per cui ci sta il bot degli acquisti: Render (piano
// gratuito) si addormenta dopo un quarto d'ora, e il primo /start
// della giornata aspetterebbe il risveglio del servizio. Un bot che
// risponde dopo quaranta secondi è un bot rotto.

import pg from "pg";

// Una connessione sola per istanza, come in `collezione.js`: su
// serverless ogni invocazione che ne apre una nuova consuma uno slot
// del pooler, e Supabase ne concede pochi.
let pool;

function connessione() {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 1,
      idleTimeoutMillis: 10000
    });
  }

  return pool;
}

/** Sostituisce la connessione: serve alle prove, che girano in una transazione poi annullata. */
export function usaConnessione(sostituto) {
  pool = sostituto;
}

// --------------------------------------------------
// DOPPIONI
// --------------------------------------------------

/**
 * Telegram rimanda lo stesso aggiornamento finché non riceve un 200.
 * Senza questo controllo un risveglio lento basterebbe a far
 * comparire due volte l'elenco dei nomi, o a collegare due volte.
 */
export async function primaVolta(updateId) {
  const { rowCount } = await connessione().query(
    `INSERT INTO telegram_visti_uscite (update_id) VALUES ($1) ON CONFLICT DO NOTHING`,
    [updateId]
  );

  return rowCount === 1;
}

// --------------------------------------------------
// CHI C'È
// --------------------------------------------------

/**
 * I nomi che un estraneo può chiedere: persone ATTIVE, non il proprietario, ancora
 * senza una chat.
 *
 * ⚠️ Tre condizioni, tutte e tre necessarie:
 *  - `attivo`: chi ha chiesto di entrare e non è ancora stato accettato non è una
 *    persona del sito, e non deve comparire in un elenco che chiunque apra il bot vede;
 *  - NON il proprietario: il suo collegamento non si sceglie da un bottone, perché chi
 *    lo prende riceve gli avvisi e il riepilogo di tutta la casa (e può scollegare gli
 *    altri). Si fa solo col codice, vedi `collegaProprietario`;
 *  - senza chat: chi è già collegato non si può soffiare.
 */
export async function nomiLiberi() {
  const { rows } = await connessione().query(
    `SELECT id, nickname
       FROM utenti
      WHERE stato = 'attivo' AND NOT proprietario AND telegram_chat_id IS NULL
      ORDER BY id`
  );

  return rows;
}

/** Il nome di una persona che si può ancora chiedere, o `null` (stesse regole di `nomiLiberi`). */
export async function daCollegare(utenteId) {
  const { rows } = await connessione().query(
    `SELECT nickname FROM utenti
      WHERE id = $1 AND stato = 'attivo' AND NOT proprietario AND telegram_chat_id IS NULL`,
    [utenteId]
  );

  return rows[0]?.nickname || null;
}

/** Chi è questa chat, se è già di qualcuno. */
export async function chiE(chatId) {
  const { rows } = await connessione().query(
    `SELECT id, nickname, proprietario FROM utenti WHERE telegram_chat_id = $1`,
    [chatId]
  );

  return rows[0] || null;
}

/**
 * Collega una persona a questa chat. Si chiama SOLO dopo che il proprietario ha toccato
 * «Approva»: da qui non c'è nessun altro modo di arrivarci.
 *
 * ⚠️ Le condizioni nel `WHERE` non sono prudenza inutile. `telegram_chat_id IS NULL`:
 * fra il momento in cui un bottone è stato disegnato e quello in cui viene toccato
 * possono passare giorni, e in mezzo quel nome può essersi preso qualcun altro; chi
 * arriva secondo torna a mani vuote. `attivo` e `NOT proprietario`: un identificativo
 * qualunque, anche uno che il bot non ha mai offerto, non deve poter collegare chi non
 * è una persona accettata o chi è il padrone di casa.
 */
export async function collega(utenteId, chatId) {
  const { rows } = await connessione().query(
    `UPDATE utenti SET telegram_chat_id = $2
      WHERE id = $1 AND stato = 'attivo' AND NOT proprietario AND telegram_chat_id IS NULL
      RETURNING nickname`,
    [utenteId, chatId]
  );

  return rows[0]?.nickname || null;
}

/**
 * Il proprietario si ricollega a questa chat (telefono nuovo, o prima volta): si chiama
 * solo dopo aver verificato il codice. Restituisce il nome e la chat di prima, per poter
 * avvisare quella vecchia.
 */
export async function collegaProprietario(chatId) {
  const { rows } = await connessione().query(
    `WITH vecchio AS (
       SELECT id, telegram_chat_id AS prima FROM utenti
        WHERE proprietario AND stato = 'attivo' ORDER BY id LIMIT 1 FOR UPDATE
     )
     UPDATE utenti u SET telegram_chat_id = $1
       FROM vecchio WHERE u.id = vecchio.id
     RETURNING u.nickname, vecchio.prima`,
    [chatId]
  );

  return rows[0] || null;
}

/** Stacca questa chat da chiunque fosse. */
export async function scollega(chatId) {
  const { rows } = await connessione().query(
    `UPDATE utenti SET telegram_chat_id = NULL WHERE telegram_chat_id = $1 RETURNING nickname`,
    [chatId]
  );

  return rows[0]?.nickname || null;
}

/** Stacca una persona per nome: è il bottone di ripensamento del proprietario. */
export async function scollegaId(utenteId) {
  const { rows } = await connessione().query(
    `UPDATE utenti SET telegram_chat_id = NULL WHERE id = $1 RETURNING nickname`,
    [utenteId]
  );

  return rows[0]?.nickname || null;
}

/** La chat del padrone di casa, per avvertirlo di chi si collega. */
export async function chatDelProprietario() {
  const { rows } = await connessione().query(
    `SELECT id, telegram_chat_id FROM utenti WHERE proprietario AND telegram_chat_id IS NOT NULL`
  );

  return rows[0] || null;
}

/**
 * Quante serie segue: è la frase che rende concreto il collegamento.
 *
 * «Ti avviso per le tue 37 serie» dice due cose in una — che ha
 * funzionato, e che il bot ha guardato la videoteca GIUSTA. Le
 * droppate non si contano: su quelle non arriverà mai niente.
 */
export async function quanteSerie(utenteId) {
  const { rows } = await connessione().query(
    `SELECT COUNT(*)::int AS quante FROM visioni
      WHERE utente_id = $1 AND stato <> 'droppata'`,
    [utenteId]
  );

  return rows[0]?.quante ?? 0;
}
