// Prova il bot delle uscite senza mandare niente a nessuno.
//
//   npm run prova-uscite
//
// Applica la 002 dentro una transazione, ci dirotta dentro il modulo
// che parla al database, mette al posto di `fetch` un finto che si
// segna cosa sarebbe partito per Telegram, e alla fine fa ROLLBACK.
// Non resta niente: né nel database, né su Telegram.
//
// ⚠️ Perché si sostituisce `fetch` e non le funzioni di
// `src/telegram.js`: in ESM quello che si importa è un legame di sola
// lettura, e riassegnarlo dall'esterno solleva un TypeError. Il punto
// più in basso in cui si può intercettare è la rete, ed è anche il
// più onesto — così la prova attraversa il codice vero fino all'ultima
// riga, compreso come vengono impacchettati i bottoni.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

import * as db from "../src/uscite.js";
import { _interni } from "../api/uscite.js";

const qui = path.dirname(fileURLToPath(import.meta.url));

let passate = 0;
let fallite = 0;

function esito(cosa, andata, nota = "") {
  console.log(`  ${andata ? "✅" : "❌"} ${cosa}${nota ? ` — ${nota}` : ""}`);
  if (andata) passate++;
  else fallite++;
}

// --------------------------------------------------
// Il finto Telegram
// --------------------------------------------------

const mandati = [];
const veroFetch = globalThis.fetch;

globalThis.fetch = async (url, opzioni = {}) => {
  if (!String(url).includes("api.telegram.org")) return veroFetch(url, opzioni);

  const metodo = String(url).split("/").pop();
  const corpo = JSON.parse(opzioni.body || "{}");

  mandati.push({ metodo, ...corpo });

  return {
    ok: true,
    json: async () => ({ ok: true, result: { message_id: mandati.length } })
  };
};

const ultimo = (metodo) => [...mandati].reverse().find((m) => m.metodo === metodo);

// --------------------------------------------------

const CHAT_A = 900000001;
const CHAT_B = 900000002;

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 1
});

const cliente = await pool.connect();

try {
  await cliente.query("SET lock_timeout = '5s'");
  await cliente.query("SET statement_timeout = '60s'");
  await cliente.query("BEGIN");

  db.usaConnessione(cliente);

  console.log("\n══ La migrazione\n");

  await cliente.query(fs.readFileSync(path.join(qui, "..", "sql", "002_uscite.sql"), "utf8"));

  esito("la 002 gira", true);

  // Le persone vere collegate si mettono da parte: la prova deve dare
  // gli stessi numeri oggi e fra un mese, e «i nomi liberi» cambiano
  // ogni volta che qualcuno si collega davvero.
  const { rowCount: veri } = await cliente.query(
    `UPDATE utenti SET telegram_chat_id = NULL WHERE telegram_chat_id IS NOT NULL`
  );

  console.log(`     (${veri} collegamenti veri messi da parte)`);

  // Il proprietario ha una chat: è quello che deve ricevere l'avviso
  // quando qualcuno si collega.
  const { rows: [capo] } = await cliente.query(
    `UPDATE utenti SET telegram_chat_id = 900000999 WHERE proprietario RETURNING id, nickname`
  );

  // ---- /start da uno che non si è mai fatto vedere ----

  console.log("\n══ /start\n");

  await _interni.gestisciMessaggio(CHAT_A, "/start", { first_name: "Sara", username: "sara" });

  const benvenuto = ultimo("sendMessage");
  const bottoni = (benvenuto?.reply_markup?.inline_keyboard || []).flat();

  esito("risponde con i nomi", bottoni.length > 0, `${bottoni.length} bottoni`);

  const { rows: attivi } = await cliente.query(
    `SELECT nickname FROM utenti WHERE stato = 'attivo' AND NOT proprietario`
  );

  esito(
    "ci sono tutti tranne chi è già collegato",
    bottoni.length === attivi.length &&
      attivi.every((u) => bottoni.some((b) => b.text === u.nickname)),
    `attesi ${attivi.length} (il proprietario è già collegato)`
  );

  esito(
    "il proprietario, che è già collegato, non compare",
    !bottoni.some((b) => b.text === capo.nickname)
  );

  esito("i bottoni stanno a due per riga", (benvenuto.reply_markup.inline_keyboard[0] || []).length <= 2);

  // ---- la scelta ----

  console.log("\n══ La scelta del nome\n");

  const scelto = bottoni[0];
  const idScelto = Number(scelto.callback_data.slice(3));

  mandati.length = 0;

  await _interni.gestisciBottone(CHAT_A, {
    id: "cb1",
    data: scelto.callback_data,
    message: { message_id: 10 },
    from: { first_name: "Sara", username: "sara" }
  });

  const { rows: [prima] } = await cliente.query(
    `SELECT telegram_chat_id FROM utenti WHERE id = $1`,
    [idScelto]
  );

  esito("toccare il nome NON collega: chiede", prima.telegram_chat_id === null);

  const alCapo = mandati.find(
    (m) => m.metodo === "sendMessage" && String(m.chat_id) === "900000999"
  );

  esito("il proprietario riceve la richiesta", Boolean(alCapo), alCapo?.text?.split("\n")[0]);

  esito(
    "con Approva e Rifiuta",
    alCapo?.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data === `ok:${idScelto}:${CHAT_A}` &&
      alCapo?.reply_markup?.inline_keyboard?.[0]?.[1]?.callback_data === `no:${idScelto}:${CHAT_A}`
  );

  esito("la richiesta dice chi è su Telegram", alCapo?.text?.includes("@sara"));

  mandati.length = 0;

  await _interni.gestisciBottone(900000999, {
    id: "cb1b",
    data: `ok:${idScelto}:${CHAT_A}`,
    message: { message_id: 11 },
    from: { first_name: "Capo" }
  });

  const { rows: [collegata] } = await cliente.query(
    `SELECT nickname, telegram_chat_id FROM utenti WHERE id = $1`,
    [idScelto]
  );

  esito(
    "dopo Approva la chat finisce sulla riga giusta",
    String(collegata.telegram_chat_id) === String(CHAT_A),
    `${collegata.nickname} → ${collegata.telegram_chat_id}`
  );

  const conferma = mandati.find(
    (m) => m.metodo === "sendMessage" && String(m.chat_id) === String(CHAT_A)
  );

  esito("la conferma alla persona dice il nome", conferma?.text?.includes(collegata.nickname));

  esito(
    "e quante serie",
    /\d+<\/b> serie|videoteca non c'è ancora niente/.test(conferma?.text || ""),
    "è quello che prova che ha guardato la videoteca giusta"
  );

  esito(
    "il proprietario ha il bottone per ripensarci",
    mandati.find((m) => m.metodo === "editMessageText" && String(m.chat_id) === "900000999")
      ?.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data === `via:${idScelto}`
  );

  // ---- nessuno può soffiare un nome già preso ----

  console.log("\n══ Un nome già preso\n");

  mandati.length = 0;

  await _interni.gestisciBottone(CHAT_B, {
    id: "cb2",
    data: scelto.callback_data,
    message: { message_id: 20 },
    from: { first_name: "Estraneo" }
  });

  const { rows: [ancora] } = await cliente.query(
    `SELECT telegram_chat_id FROM utenti WHERE id = $1`,
    [idScelto]
  );

  esito(
    "la riga non cambia padrone",
    String(ancora.telegram_chat_id) === String(CHAT_A),
    "è la difesa che impedisce di rubare gli avvisi a qualcuno"
  );

  esito(
    "e glielo dice",
    /disponibile/i.test(mandati.find((m) => m.metodo === "editMessageText")?.text || "")
  );

  mandati.length = 0;

  await _interni.gestisciMessaggio(CHAT_B, "/start", { first_name: "Estraneo" });

  const secondiBottoni = (ultimo("sendMessage")?.reply_markup?.inline_keyboard || []).flat();

  esito(
    "il nome preso sparisce dall'elenco",
    !secondiBottoni.some((b) => b.callback_data === scelto.callback_data),
    `restano ${secondiBottoni.length} nomi`
  );

  // ---- chi è già collegato ----

  console.log("\n══ Chi è già collegato\n");

  mandati.length = 0;

  await _interni.gestisciMessaggio(CHAT_A, "/start", { first_name: "Sara" });

  esito(
    "/start non ripropone i nomi",
    !ultimo("sendMessage")?.reply_markup &&
      ultimo("sendMessage")?.text?.includes(collegata.nickname)
  );

  // ---- il ripensamento del proprietario ----

  console.log("\n══ «Non è lei»\n");

  mandati.length = 0;

  await _interni.gestisciBottone(CHAT_B, {
    id: "cb3",
    data: `via:${idScelto}`,
    message: { message_id: 30 },
    from: { first_name: "Estraneo" }
  });

  const { rows: [intatta] } = await cliente.query(
    `SELECT telegram_chat_id FROM utenti WHERE id = $1`,
    [idScelto]
  );

  esito(
    "un estraneo non può scollegare nessuno",
    String(intatta.telegram_chat_id) === String(CHAT_A)
  );

  mandati.length = 0;

  await _interni.gestisciBottone(900000999, {
    id: "cb4",
    data: `via:${idScelto}`,
    message: { message_id: 31 },
    from: { first_name: "Capo" }
  });

  const { rows: [sciolta] } = await cliente.query(
    `SELECT telegram_chat_id FROM utenti WHERE id = $1`,
    [idScelto]
  );

  esito("il proprietario sì", sciolta.telegram_chat_id === null);

  // ---- /scollega ----

  console.log("\n══ /scollega\n");

  await _interni.gestisciBottone(CHAT_A, {
    id: "cb5",
    data: scelto.callback_data,
    message: { message_id: 40 },
    from: { first_name: "Sara" }
  });

  await _interni.gestisciBottone(900000999, {
    id: "cb5b",
    data: `ok:${idScelto}:${CHAT_A}`,
    message: { message_id: 41 },
    from: { first_name: "Capo" }
  });

  mandati.length = 0;

  await _interni.gestisciMessaggio(CHAT_A, "/scollega", { first_name: "Sara" });

  const { rows: [via] } = await cliente.query(
    `SELECT telegram_chat_id FROM utenti WHERE id = $1`,
    [idScelto]
  );

  esito("si stacca da sé", via.telegram_chat_id === null);

  // ---- i doppioni ----

  console.log("\n══ Lo stesso aggiornamento due volte\n");

  const primo = await db.primaVolta(555000111);
  const secondo = await db.primaVolta(555000111);

  esito("il secondo non passa", primo === true && secondo === false);
} catch (errore) {
  console.error("\n❌ ERRORE:", errore.message);
  console.error(errore.stack?.split("\n").slice(1, 4).join("\n"));
  fallite++;
} finally {
  await cliente.query("ROLLBACK").catch(() => {});
  cliente.release();
  await pool.end();
  globalThis.fetch = veroFetch;
}

console.log(`\n${fallite === 0 ? "✅" : "❌"} ${passate} passate, ${fallite} fallite.`);
console.log("   (tutto annullato: il database è come prima)\n");

process.exitCode = fallite === 0 ? 0 : 1;
