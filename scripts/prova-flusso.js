// Il percorso intero di un messaggio, dalla riga scritta su Telegram alla risposta: il vero
// `api/telegram.js`, uno schema Postgres di prova, e i siti esterni SOSTITUITI da risposte finte
// (le pagine d'esempio di fixtures/animeclick, un AniList vuoto, un Telegram che ricorda cosa gli si dice).
// Serve a provare il tempo: quanto ci si mette, cosa si fa quando il sito è lento, cosa si dice
// quando il tempo finisce.
//
//   PROVA_DATABASE_URL=postgres://… node scripts/prova-flusso.js
//
// Senza PROVA_DATABASE_URL gira solo la parte su src/tempo.js.
//
// ⚠️ Le pagine di AnimeClick sono costruite a mano (vedi fixtures/animeclick/LEGGIMI.md): provano
// il NOSTRO codice, non dicono se il sito vero risponde come credo.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { creaSchemaProva } from "./schema-prova.js";
import { usaConnessione } from "../src/collezione.js";
import { conBudget, rimasto, attesa, abbastanza } from "../src/tempo.js";

const cartella = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "animeclick");
const pagina = (nome) => fs.readFileSync(path.join(cartella, nome), "utf8");

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

const dormi = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("\nIl tempo di un messaggio (src/tempo.js)");
{
  prova("fuori da un budget non c'è nessun limite", [Infinity, 5000, true], [rimasto(), attesa(5000), abbastanza(0.9)]);

  await conBudget(async () => {
    prova("dentro, una richiesta prende il minore fra il suo tempo e quello che resta", true, attesa(5000) <= 300);
    prova("e a inizio budget c'è abbastanza tempo per un lavoro lungo", true, abbastanza(0.5));
    await dormi(200);
    prova("dopo due terzi del budget, non più", false, abbastanza(0.5));
    await dormi(150);

    let errore = null;

    try {
      attesa(5000);
    } catch (e) {
      errore = e.message;
    }

    prova("a budget finito una richiesta non parte: lancia", "tempo esaurito", errore);
  }, 300);

  // Due messaggi insieme sulla stessa istanza: ognuno col suo orologio.
  const [breve, lungo] = await Promise.all([
    conBudget(async () => { await dormi(60); return rimasto(); }, 50),
    conBudget(async () => { await dormi(60); return rimasto(); }, 5000)
  ]);

  prova("due budget insieme non si pestano i piedi", [true, true], [breve < 0, lungo > 4000]);
}

const url = process.env.PROVA_DATABASE_URL;

if (!url) {
  console.log("\n(PROVA_DATABASE_URL non c'è: salto il percorso intero.)");
} else {
  const { pool, chiudi } = await creaSchemaProva(url);

  usaConnessione(pool);

  process.env.TELEGRAM_BOT_TOKEN = "token-finto";
  process.env.TELEGRAM_SECRET_TOKEN = "segreto-finto";
  process.env.TELEGRAM_CHAT_ID = "42";

  // ----- I siti finti -----
  const fetchVero = globalThis.fetch;
  const telegram = [];
  const eventi = [];
  let idMessaggio = 0;
  const siti = { ritardoAniList: 0, ritardoEdizioni: 0, ritardoScheda: 0, schedaBloccata: false };

  const risposta = (corpo, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => (typeof corpo === "string" ? corpo : JSON.stringify(corpo)),
    json: async () => (typeof corpo === "string" ? JSON.parse(corpo) : corpo)
  });

  // Un'attesa che si interrompe se la richiesta viene annullata, come un vero `fetch`.
  const attendi = (ms, signal) =>
    new Promise((risolvi, rifiuta) => {
      if (signal?.aborted) return rifiuta(Object.assign(new Error("annullata"), { name: "AbortError" }));

      const t = setTimeout(risolvi, ms);

      signal?.addEventListener("abort", () => {
        clearTimeout(t);
        rifiuta(Object.assign(new Error("annullata"), { name: "AbortError" }));
      });
    });

  globalThis.fetch = async (indirizzo, opz = {}) => {
    const u = String(indirizzo);

    if (u.includes("api.telegram.org")) {
      telegram.push({ metodo: u.split("/").pop(), corpo: JSON.parse(opz.body || "{}") });
      return risposta({ ok: true, result: { message_id: ++idMessaggio } });
    }

    if (u.includes("graphql.anilist.co")) {
      eventi.push("anilist:inizio");
      await attendi(siti.ritardoAniList, opz.signal);
      eventi.push("anilist:fine");
      return risposta({ data: { Page: { media: [] } } });
    }

    if (u.endsWith("/edizioni")) {
      eventi.push("edizioni:inizio");
      await attendi(siti.ritardoEdizioni, opz.signal);
      eventi.push("edizioni:fine");
      return risposta(pagina("edizioni-berserk.html"));
    }

    if (/\/manga\/9607\/-\/$/.test(u)) {
      eventi.push("scheda:inizio");
      await attendi(siti.schedaBloccata ? 60_000 : siti.ritardoScheda, opz.signal);
      eventi.push("scheda:fine");
      return risposta(pagina("scheda-berserk.html"));
    }

    return risposta("non trovato", 404);
  };

  const { default: handler } = await import("../api/telegram.js");

  let aggiornamento = 0;

  /** Manda un messaggio al bot come farebbe Telegram, con un budget di `budget` ms. */
  async function scrivi(testo, budget = 48_000) {
    process.env.BUDGET_TELEGRAM_MS = String(budget);
    aggiornamento += 1;

    const res = { codice: null, status(c) { this.codice = c; return this; }, send() { return this; } };

    await handler(
      {
        method: "POST",
        headers: { "x-telegram-bot-api-secret-token": "segreto-finto" },
        body: { update_id: 9000 + aggiornamento, message: { chat: { id: 42 }, text: testo } }
      },
      res
    );

    return res.codice;
  }

  const ripristina = async () => {
    await pool.query(`DELETE FROM "Manga"`);
    telegram.length = 0;
    eventi.length = 0;
    Object.assign(siti, { ritardoAniList: 0, ritardoEdizioni: 0, ritardoScheda: 0, schedaBloccata: false });
  };

  const modifiche = () => telegram.filter((m) => m.metodo === "editMessageText").map((m) => m.corpo.text);
  const messaggi = () => telegram.filter((m) => m.metodo === "sendMessage").map((m) => m.corpo.text);
  const acquisti = async () => (await pool.query("SELECT volume_da AS da, volume_a AS a, prezzo::float AS p FROM acquisti ORDER BY id")).rows;

  try {
    console.log("\nUna serie nuova, con il prezzo scritto");
    {
      await ripristina();

      const codice = await scrivi("animeclick.it/manga/9607/berserk 1 6,90");

      prova("risponde 200", 200, codice);
      prova("la scheda è stata creata da AnimeClick", ["Berserk"], (await pool.query(`SELECT "Titolo" FROM "Manga"`)).rows.map((r) => r.Titolo));
      prova("l'acquisto è scritto col prezzo battuto", [{ da: 1, a: 1, p: 6.9 }], await acquisti());
      prova("il messaggio «sto compilando» viene riscritto con la conferma", true, /scheda creata da AnimeClick/.test(modifiche().at(-1) || "") && /✅/.test(modifiche().at(-1) || ""));
      prova("con il prezzo scritto non si scarica la pagina dei prezzi", false, eventi.includes("edizioni:inizio"));
    }

    console.log("\nUna serie nuova, senza prezzo: i prezzi partono insieme ad AniList");
    {
      await ripristina();
      siti.ritardoAniList = 400;
      siti.ritardoEdizioni = 100;

      await scrivi("animeclick.it/manga/9607/berserk 1");

      prova("i prezzi sono quelli di copertina, da AnimeClick (5,16 €)", [{ da: 1, a: 1, p: 5.16 }], await acquisti());
      prova("la pagina dei prezzi si scarica UNA volta sola", 1, eventi.filter((e) => e === "edizioni:inizio").length);
      prova(
        "e comincia prima che AniList abbia risposto (in parallelo, non in fila)",
        true,
        eventi.indexOf("edizioni:inizio") < eventi.indexOf("anilist:fine")
      );
    }

    console.log("\nDue schede in un messaggio e il tempo che non basta");
    {
      await ripristina();
      siti.ritardoScheda = 1500;

      // Budget di 2,5 s: la prima scheda ne consuma ~1,5, e per cominciarne un'altra ne servono 1 (il 40%).
      await scrivi("animeclick.it/manga/9607/berserk 1 6,90\nanimeclick.it/manga/9607/berserk 2 6,90", 2500);

      prova("la prima è registrata", [{ da: 1, a: 1, p: 6.9 }], await acquisti());
      prova("la seconda non è persa in silenzio: il bot dice che non l'ha fatta e la riscrive", true, messaggi().some((t) => /Non ho fatto/.test(t) && t.includes("animeclick.it/manga/9607/berserk 2 6,90")));
    }

    console.log("\nUn sito che non risponde mai");
    {
      await ripristina();
      siti.schedaBloccata = true;

      const inizio = Date.now();

      await scrivi("animeclick.it/manga/9607/berserk 1 6,90", 2000);

      const durata = Date.now() - inizio;

      prova("la richiesta si arrende col budget, non dopo i 10 secondi di sempre", true, durata < 3500);
      prova("il messaggio non resta fermo su «Sto compilando»: prima avvisa che ci mette troppo", true, modifiche().some((t) => /Ci sta mettendo più del previsto/.test(t)));
      prova("poi dice com'è finita", true, /non sono riuscito a leggerla/.test(modifiche().at(-1) || ""));
      prova("non è stato scritto niente", [0, 0], [(await pool.query(`SELECT count(*)::int AS n FROM "Manga"`)).rows[0].n, (await acquisti()).length]);
    }
  } finally {
    globalThis.fetch = fetchVero;
    await chiudi();
  }
}

console.log(falliti ? `\n${falliti} prove fallite.\n` : "\nTutto a posto.\n");
process.exitCode = falliti ? 1 : 0;
