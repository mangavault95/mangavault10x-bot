// Il bot delle uscite davanti a uno sconosciuto.
//
//   PROVA_DATABASE_URL=postgres://… node scripts/prova-uscite-estranei.js
//
// Rifà l'attacco che il 14/11/2026 ha dimostrato il buco: uno sconosciuto scrive al bot,
// sceglie un nome e riceve gli avvisi di qualcun altro. Ogni riga qui sotto è una cosa
// che NON deve più succedere, ed è provata col codice vero del bot e la rete di Telegram
// finta (si segna cosa sarebbe partito, non manda niente a nessuno).
//
// Gira in uno schema Postgres buttato via alla fine, quindi in CI e sul computer; senza
// PROVA_DATABASE_URL salta. (`prova-uscite.js` è l'altra prova: quella gira sul database
// vero dentro una transazione annullata, e non è parte di `npm test`.)

import pg from "pg";

const url = process.env.PROVA_DATABASE_URL;

if (!url) {
  console.log("\n(PROVA_DATABASE_URL non c'è: salto le prove del bot delle uscite.)\n");
  process.exit(0);
}

process.env.TELEGRAM_USCITE_TOKEN = "token-finto";
process.env.TELEGRAM_USCITE_SECRET = "segreto-finto";
process.env.SITO_URL = "https://sito.esempio";
delete process.env.TELEGRAM_USCITE_CODICE_PROPRIETARIO;

let falliti = 0;

function prova(nome, atteso, ottenuto) {
  const a = JSON.stringify(atteso);
  const o = JSON.stringify(ottenuto);

  if (a === o) console.log(`  ok   ${nome}`);
  else {
    falliti += 1;
    console.log(`  NO   ${nome}\n       atteso   ${a}\n       ottenuto ${o}`);
  }
}

// ---- il finto Telegram
const mandati = [];
const veroFetch = globalThis.fetch;

globalThis.fetch = async (indirizzo, opzioni = {}) => {
  if (!String(indirizzo).includes("api.telegram.org")) return veroFetch(indirizzo, opzioni);

  mandati.push({ metodo: String(indirizzo).split("/").pop(), ...JSON.parse(opzioni.body || "{}") });

  return { ok: true, json: async () => ({ ok: true, result: { message_id: mandati.length } }) };
};

const reset = () => (mandati.length = 0);
const a = (chat) => mandati.filter((m) => m.metodo === "sendMessage" && String(m.chat_id) === String(chat));
const bottoniDi = (m) => (m?.reply_markup?.inline_keyboard || []).flat();

// ---- lo schema
const schema = `prova_uscite_${Math.random().toString(36).slice(2, 10)}`;
const locale = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
const ssl = locale ? false : { rejectUnauthorized: false };
const admin = new pg.Pool({ connectionString: url, ssl, max: 1 });

await admin.query(`CREATE SCHEMA ${schema}`);

const pool = new pg.Pool({ connectionString: url, ssl, max: 2, options: `-c search_path=${schema}` });

await pool.query(`
  CREATE TABLE utenti (id bigint PRIMARY KEY, nickname text, proprietario boolean NOT NULL DEFAULT false,
                       stato text NOT NULL DEFAULT 'attivo', telegram_chat_id bigint);
  CREATE TABLE visioni (utente_id bigint, stato text);
  CREATE TABLE telegram_visti_uscite (update_id bigint PRIMARY KEY, visto_il timestamptz NOT NULL DEFAULT now());
  INSERT INTO visioni VALUES (2, 'in_visione'), (2, 'completa');`);

const db = await import("../src/uscite.js");
const { default: handler, _interni } = await import("../api/uscite.js");

db.usaConnessione(pool);

const CAPO = 111;
const ESTRANEO = 666;
const LEI = 222;

async function ripristina({ capo = CAPO } = {}) {
  await pool.query(`DELETE FROM utenti`);
  await pool.query(
    `INSERT INTO utenti (id, nickname, proprietario, stato, telegram_chat_id) VALUES
       (1, 'Capo',    true,  'attivo',    $1),
       (2, 'Moglie',  false, 'attivo',    NULL),
       (3, 'InAttesa', false, 'in_attesa', NULL),
       (4, 'Terzo',   false, 'attivo',    NULL)`,
    [capo]
  );
  reset();
}

const chatDi = async (id) => (await pool.query(`SELECT telegram_chat_id AS c FROM utenti WHERE id = $1`, [id])).rows[0].c;
const bottone = (chat, dato, id = "cb") => _interni.gestisciBottone(chat, { id, data: dato, message: { message_id: 7 }, from: { first_name: "Mallory", username: "mal" } });
const messaggio = (chat, testo) => _interni.gestisciMessaggio(chat, testo, { first_name: "Mallory", username: "mal" });

try {
  console.log("\nUno sconosciuto scrive /start");
  await ripristina();
  await messaggio(ESTRANEO, "/start");

  const nomi = bottoniDi(a(ESTRANEO)[0]).map((b) => b.text);

  prova("vede solo le persone attive e libere, non il proprietario né chi è in attesa", ["Moglie", "Terzo"], nomi);

  console.log("\nUno sconosciuto sceglie un nome libero");
  reset();
  await bottone(ESTRANEO, "io:2");
  prova("non si collega: la riga non cambia", null, await chatDi(2));

  const richiesta = a(CAPO)[0];

  prova("al proprietario arriva una richiesta con Approva e Rifiuta", ["Approva", "Rifiuta"], bottoniDi(richiesta).map((b) => b.text));
  prova("e dice chi è su Telegram", true, /Mallory/.test(richiesta?.text) && /@mal/.test(richiesta?.text));
  prova("lo sconosciuto non riceve avvisi né conferme di collegamento", false, a(ESTRANEO).some((m) => /Ti scrivo quando/.test(m.text)));

  console.log("\nChe cosa NON si può fare");
  for (const [cosa, dato, id] of [
    ["scegliere il nome del proprietario (io:1)", "io:1", 1],
    ["scegliere una persona in attesa mai offerta (io:3)", "io:3", 3]
  ]) {
    await ripristina();
    await bottone(ESTRANEO, dato);
    // Per il proprietario «niente» vuol dire che la chat resta quella di prima.
    const dopo = String(await chatDi(id));
    prova(`${cosa}: non scrive niente`, id === 1 ? String(CAPO) : "null", dopo);
    prova(`${cosa}: e il proprietario non viene nemmeno disturbato`, 0, a(CAPO).length);
  }

  await ripristina();
  await bottone(ESTRANEO, `ok:2:${ESTRANEO}`);
  prova("approvare da sé (ok:…) dalla propria chat non fa niente", null, await chatDi(2));
  await bottone(ESTRANEO, `via:1`);
  prova("scollegare il proprietario (via:1) non è permesso a un estraneo", String(CAPO), String(await chatDi(1)));

  await messaggio(ESTRANEO, "/scollega");
  prova("/scollega di un estraneo non tocca nessuno", String(CAPO), String(await chatDi(1)));

  console.log("\nIl proprietario approva o rifiuta");
  await ripristina();
  await bottone(ESTRANEO, "io:2");
  reset();
  await bottone(CAPO, `ok:2:${ESTRANEO}`);
  prova("Approva: la chat finisce sulla riga giusta", String(ESTRANEO), String(await chatDi(2)));
  prova("chi è stata approvata riceve la conferma, con le sue 2 serie (le droppate non contano)", true, /<b>2<\/b> serie/.test(a(ESTRANEO)[0]?.text || ""));
  prova("il proprietario ha il bottone per ripensarci", "via:2", bottoniDi(mandati.find((m) => m.metodo === "editMessageText"))[0]?.callback_data);

  await bottone(CAPO, `ok:2:${LEI}`);
  prova("un secondo Approva non ruba il posto a chi c'è già", String(ESTRANEO), String(await chatDi(2)));

  await ripristina();
  await bottone(ESTRANEO, "io:2");
  reset();
  await bottone(CAPO, `no:2:${ESTRANEO}`);
  prova("Rifiuta: non si collega niente", null, await chatDi(2));
  prova("e lo sconosciuto lo sa, senza dettagli", true, /non ha approvato/.test(a(ESTRANEO)[0]?.text || ""));

  console.log("\nSe il proprietario non ha la chat collegata");
  await ripristina({ capo: null });
  await messaggio(ESTRANEO, "/start");
  prova("si vedono comunque solo i nomi non del proprietario", ["Moglie", "Terzo"], bottoniDi(a(ESTRANEO)[0]).map((b) => b.text));
  reset();
  await bottone(ESTRANEO, "io:2");
  prova("nessuno può approvare, quindi nessuno si collega", null, await chatDi(2));
  prova("e lo sconosciuto riceve la spiegazione", true, /Riprova|avvertirlo/.test(mandati.find((m) => m.metodo === "editMessageText")?.text || ""));
  await bottone(ESTRANEO, "io:1");
  prova("e il posto del proprietario non si prende da un bottone", null, await chatDi(1));

  console.log("\nIl proprietario si ricollega col codice");
  await ripristina({ capo: null });
  await messaggio(ESTRANEO, "/start qualunque-codice-lungo-abbastanza");
  prova("senza il codice impostato, nessuna parola magica funziona", null, await chatDi(1));

  process.env.TELEGRAM_USCITE_CODICE_PROPRIETARIO = "corto";
  await messaggio(ESTRANEO, "/start corto");
  prova("un codice troppo corto è come non averlo", null, await chatDi(1));

  process.env.TELEGRAM_USCITE_CODICE_PROPRIETARIO = "un-codice-lungo-e-segreto-1234";
  await messaggio(ESTRANEO, "/start un-codice-sbagliato-ma-lungo");
  prova("un codice sbagliato non collega", null, await chatDi(1));
  prova("e non dice che il codice esisteva (risponde come a un /start)", true, /Chi sei/.test(a(ESTRANEO).at(-1)?.text || ""));

  reset();
  await messaggio(CAPO, "/start un-codice-lungo-e-segreto-1234");
  prova("il codice giusto lo collega", String(CAPO), String(await chatDi(1)));

  reset();
  await messaggio(777, "/start un-codice-lungo-e-segreto-1234");
  prova("dal telefono nuovo si sposta, senza lasciare il vecchio attivo", "777", String(await chatDi(1)));
  prova("e la chat vecchia viene avvisata", true, /ricollegato da un altro telefono/.test(a(CAPO)[0]?.text || ""));

  await ripristina();
  await bottone(ESTRANEO, "io:2");
  await bottone(CAPO, `ok:2:${LEI}`);
  reset();
  await messaggio(LEI, "/start un-codice-lungo-e-segreto-1234");
  prova("chi è già collegato come un'altra persona non diventa il proprietario col codice", String(CAPO), String(await chatDi(1)));

  console.log("\nIl proprietario non si scollega da sé");
  await ripristina();
  reset();
  await messaggio(CAPO, "/scollega");
  prova("/scollega del proprietario è rifiutato", String(CAPO), String(await chatDi(1)));

  console.log("\nIl webhook");
  const manda = async (corpo, intestazioni = { "x-telegram-bot-api-secret-token": "segreto-finto" }) => {
    const r = { codice: null, testo: null, status(c) { this.codice = c; return this; }, send(t) { this.testo = t; return this; } };
    await handler({ method: "POST", headers: intestazioni, body: corpo }, r);
    return r;
  };

  await ripristina();
  const gruppo = await manda({ update_id: 1, message: { chat: { id: -100, type: "group" }, text: "/start", from: { first_name: "x" } } });
  prova("in un gruppo non risponde e non scrive", [200, 0], [gruppo.codice, mandati.length]);

  const senza = await manda({ update_id: 2, message: { chat: { id: 5, type: "private" }, text: "/start" } }, {});
  prova("senza il segreto di Telegram risponde 401 e non fa niente", [401, 0], [senza.codice, mandati.length]);

  delete process.env.TELEGRAM_USCITE_SECRET;
  const spento = await manda({ update_id: 3, message: { chat: { id: 5, type: "private" }, text: "/start" } }, {});
  prova("se manca la variabile del segreto il bot è muto, non aperto", 401, spento.codice);
  process.env.TELEGRAM_USCITE_SECRET = "segreto-finto";

  const privata = await manda({ update_id: 4, message: { chat: { id: ESTRANEO, type: "private" }, text: "/start", from: { first_name: "x" } } });
  prova("in una chat privata risponde", [200, true], [privata.codice, a(ESTRANEO).length > 0]);
} catch (errore) {
  falliti += 1;
  console.error("ERRORE NELLA PROVA:", errore);
} finally {
  globalThis.fetch = veroFetch;
  await pool.end().catch(() => {});
  await admin.query(`DROP SCHEMA ${schema} CASCADE`).catch(() => {});
  await admin.end().catch(() => {});
}

console.log(falliti ? `\n${falliti} prove NON passano.\n` : "\nTutto a posto.\n");
process.exit(falliti ? 1 : 0);
