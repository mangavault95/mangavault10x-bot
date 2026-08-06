// Il bot per intero, senza Telegram e senza toccare la collezione.
//
//   npm run simula
//
// Cosa fa davvero: le richieste a Telegram vengono intercettate e
// stampate qui invece di partire, il database gira dentro una
// transazione che alla fine viene annullata, e AnimeClick e AniList
// vengono interrogati per davvero — sono l'unica parte che non ha
// senso fingere.
//
// Serve a vedere come suonano le risposte prima di averle sul
// telefono, e a scoprire gli errori del percorso completo (che le
// prove sui singoli pezzi non prendono).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import * as db from "../src/collezione.js";

const QUI = path.dirname(fileURLToPath(import.meta.url));

process.env.TELEGRAM_BOT_TOKEN = "finto";
process.env.TELEGRAM_SECRET_TOKEN = "segreto-di-prova";
process.env.TELEGRAM_CHAT_ID = "1";

if (!process.env.DATABASE_URL) {
  console.error("Manca DATABASE_URL. Esegui con: node --env-file=.env scripts/simula.js");
  process.exit(1);
}

// --------------------------------------------------
// Telegram finto
// --------------------------------------------------

const vera = globalThis.fetch;
let contatore = 100;
let ultimiBottoni = [];

globalThis.fetch = async (url, opzioni) => {
  const indirizzo = String(url);

  if (!indirizzo.startsWith("https://api.telegram.org/")) return vera(url, opzioni);

  const metodo = indirizzo.split("/").pop();
  const corpo = JSON.parse(opzioni?.body || "{}");

  if (metodo === "sendMessage" || metodo === "editMessageText") {
    const bottoni = corpo.reply_markup?.inline_keyboard || [];

    console.log(`\n┌─ ${metodo === "editMessageText" ? "(corretto)" : "bot"}`);
    for (const riga of corpo.text.split("\n")) console.log(`│ ${riga.replace(/<[^>]+>/g, "")}`);
    for (const riga of bottoni) {
      for (const b of riga) console.log(`│ [ ${b.text} ]  → ${b.callback_data}`);
    }
    console.log("└─");

    if (bottoni.length) ultimiBottoni = bottoni.flat();
  }

  return new Response(JSON.stringify({ ok: true, result: { message_id: contatore++ } }), {
    headers: { "Content-Type": "application/json" }
  });
};

// --------------------------------------------------
// Database in prova
// --------------------------------------------------

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 1
});

const cliente = await pool.connect();
let profondita = 0;

async function query(testo, valori) {
  const comando = String(testo).trim().toUpperCase();

  if (comando === "BEGIN") return cliente.query(`SAVEPOINT prova_${++profondita}`);
  if (comando === "COMMIT") return cliente.query(`RELEASE SAVEPOINT prova_${profondita--}`);
  if (comando === "ROLLBACK") return cliente.query(`ROLLBACK TO SAVEPOINT prova_${profondita--}`);

  return cliente.query(testo, valori);
}

db.usaConnessione({ query, connect: async () => ({ query, release() {} }) });

await cliente.query("BEGIN");
await cliente.query(fs.readFileSync(path.join(QUI, "..", "sql", "001_telegram.sql"), "utf8"));

const { default: handler } = await import("../api/telegram.js");

// --------------------------------------------------
// Finti messaggi
// --------------------------------------------------

let aggiornamento = 900000;

function risposta() {
  return {
    codice: null,
    corpo: null,
    status(c) { this.codice = c; return this; },
    send(b) { this.corpo = b; return this; }
  };
}

async function scrive(testo) {
  console.log(`\n\n═══ tu: ${testo.replace(/\n/g, " ⏎ ")}`);

  const res = risposta();

  await handler(
    {
      method: "POST",
      headers: { "x-telegram-bot-api-secret-token": "segreto-di-prova" },
      body: {
        update_id: ++aggiornamento,
        message: { chat: { id: 1 }, text: testo }
      }
    },
    res
  );

  return res;
}

async function tocca(indice = 0) {
  const bottone = ultimiBottoni[indice];

  if (!bottone) {
    console.log("\n(nessun bottone da toccare)");
    return;
  }

  console.log(`\n\n═══ tocchi: [ ${bottone.text} ]`);

  await handler(
    {
      method: "POST",
      headers: { "x-telegram-bot-api-secret-token": "segreto-di-prova" },
      body: {
        update_id: ++aggiornamento,
        callback_query: {
          id: "1",
          data: bottone.callback_data,
          message: { chat: { id: 1 }, message_id: contatore }
        }
      }
    },
    risposta()
  );
}

// --------------------------------------------------
// Il giro
// --------------------------------------------------

try {
  const collezione = await db.elenco();

  // Serie scelte dalla collezione vera: una indietro con le uscite
  // (così il volume dopo non risulta un doppione) e una qualsiasi.
  const indietro = collezione
    .filter((s) => s.volumiItalia && s.volumiItalia > s.posseduti)
    .sort((a, b) => b.volumiItalia - b.posseduti - (a.volumiItalia - a.posseduti));

  const prima = indietro[0];
  const seconda = indietro[1];

  await scrive("/aiuto");
  await scrive(`${prima.titolo.toLowerCase()} ${prima.posseduti + 1} 6,90`);
  await scrive(
    `${prima.titolo.toLowerCase()} ${prima.posseduti + 2}\n` +
      `${seconda.titolo.toLowerCase()} ${seconda.posseduti + 1}-${seconda.posseduti + 2} 13,80`
  );

  // Un volume che risulta già suo: deve chiedere conferma.
  await scrive(`${prima.titolo.toLowerCase()} 1`);
  await tocca();

  // Un titolo che somiglia a serie che ha, ma che non è nessuna di
  // quelle: deve offrire la via d'uscita verso AnimeClick.
  await scrive("black butler 1");
  await tocca(ultimiBottoni.length - 1);
  await tocca();

  // Una serie che non ha: la cerca su AnimeClick e propone.
  const assente = ["solo leveling", "oshi no ko", "kingdom", "gantz"].find(
    (t) => !db.cercaFra(collezione, t).certa
  );

  await scrive(`${assente} 1 7,50`);
  await tocca();

  // Il link della scheda: la crea senza passare dalla ricerca.
  await scrive("https://www.animeclick.it/manga/50294/-/ 4 8,90");

  await scrive("/mese");
  await scrive("/mancanti");
  await scrive("/annulla");
  await scrive("berserkk");
} catch (errore) {
  console.error("\nERRORE:", errore);
} finally {
  await cliente.query("ROLLBACK");
  cliente.release();
  await pool.end();
  console.log("\n\nTutto annullato: la collezione è come prima.\n");
}
