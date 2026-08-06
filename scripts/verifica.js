// La prova generale contro il database VERO, senza lasciarci niente.
//
//   npm run verifica
//
// Come fa a essere sicura: apre una transazione, ci applica dentro
// la migrazione e tutte le scritture del bot, e alla fine annulla
// tutto. Le BEGIN/COMMIT del codice normale vengono tradotte in
// SAVEPOINT, altrimenti il primo COMMIT confermerebbe per davvero
// quello che stiamo solo provando.
//
// Serve perché le query si possono sbagliare in un modo solo che i
// test senza database non vedono: il nome di una colonna.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import * as db from "../src/collezione.js";

const QUI = path.dirname(fileURLToPath(import.meta.url));

if (!process.env.DATABASE_URL) {
  console.error("Manca DATABASE_URL. Esegui con: node --env-file=.env scripts/verifica.js");
  process.exit(1);
}

let falliti = 0;

function prova(nome, condizione, dettaglio = "") {
  if (condizione) {
    console.log(`  ok   ${nome}${dettaglio ? ` — ${dettaglio}` : ""}`);
  } else {
    falliti++;
    console.log(`  NO   ${nome}${dettaglio ? ` — ${dettaglio}` : ""}`);
  }
}

const vero = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 1
});

const cliente = await vero.connect();
const acquistiPrima = (await cliente.query(`SELECT COUNT(*)::int AS n FROM acquisti`)).rows[0].n;
let profondita = 0;

/** Traduce le transazioni del bot in punti di ritorno annidati. */
async function query(testo, valori) {
  const comando = String(testo).trim().toUpperCase();

  if (comando === "BEGIN") return cliente.query(`SAVEPOINT prova_${++profondita}`);
  if (comando === "COMMIT") return cliente.query(`RELEASE SAVEPOINT prova_${profondita--}`);
  if (comando === "ROLLBACK") return cliente.query(`ROLLBACK TO SAVEPOINT prova_${profondita--}`);

  return cliente.query(testo, valori);
}

db.usaConnessione({
  query,
  connect: async () => ({ query, release() {} })
});

try {
  await cliente.query("BEGIN");

  console.log("\nMigrazione");
  const migrazione = fs.readFileSync(path.join(QUI, "..", "sql", "001_telegram.sql"), "utf8");
  await cliente.query(migrazione);
  prova("sql/001_telegram.sql si applica", true);

  console.log("\nLettura della collezione");
  const serie = await db.elenco();
  prova("la collezione si legge", serie.length > 0, `${serie.length} serie`);

  const campione = serie.find((s) => s.stato === "in_corso" && s.posseduti > 0) || serie[0];
  prova("i numeri arrivano come numeri", typeof campione.posseduti === "number",
    `${campione.titolo}: ${campione.posseduti} volumi`);

  const ritrovata = db.cercaFra(serie, campione.titolo.toLowerCase());
  prova("il titolo si ritrova scritto in minuscolo", ritrovata.certa?.id === campione.id);

  console.log("\nDoppioni");
  prova("un aggiornamento nuovo passa", await db.primaVolta(-1));
  prova("lo stesso aggiornamento non passa due volte", !(await db.primaVolta(-1)));

  console.log("\nRegistrazione di un acquisto");
  const volume = campione.posseduti + 1;

  const esito = await db.registra({
    serie: campione,
    gruppi: [{ da: volume, a: volume, prezzo: 7.5 }],
    data: null,
    updateId: -1
  });

  prova("il contatore sale di uno", esito.serie.posseduti === campione.posseduti + 1,
    `${campione.posseduti} → ${esito.serie.posseduti}`);

  const registrati = await db.volumiRegistrati(campione.id);
  prova("il volume risulta registrato", registrati.has(volume));

  const mese = await db.acquistiDelMese(db.oggiInItalia());
  prova("compare nel mese corrente", mese.some((a) => a.titolo === campione.titolo && a.prezzo === 7.5),
    `${mese.length} acquisti nel mese`);
  prova("la data non scivola di un giorno", mese.every((a) => /^\d{4}-\d{2}-\d{2}$/.test(a.giorno)));

  console.log("\nAnnullamento");
  const disfatti = await db.annullaUltimo();
  prova("l'acquisto viene disfatto", disfatti?.length === 1, disfatti?.[0]?.titolo);

  const dopo = await db.perId(campione.id);
  prova("il contatore torna com'era", dopo.posseduti === campione.posseduti,
    `${dopo.posseduti} volumi`);

  console.log("\nSerie nuova");
  const nuova = await db.creaSerie({
    titolo: "Prova Del Bot — da cancellare",
    titoloOriginale: "Prova",
    autore: "Nessuno",
    disegnatore: "Nessuno",
    genere: "Drama",
    trama: "Una serie che non esiste.",
    cover: "https://example.invalid/cover.jpg",
    editore: "Nessuno",
    volumiTotali: 3,
    stato: "in_corso",
    anno: 2026,
    animeClickId: -1,
    prezzo: 6.9
  });

  prova("la scheda si crea", nuova.id > 0, `ID ${nuova.id}`);
  prova("si ritrova dall'identificativo AnimeClick", (await db.esisteAnimeClickId(-1))?.id === nuova.id);

  const primoVolume = await db.registra({
    serie: nuova,
    gruppi: [{ da: 1, a: 1, prezzo: 6.9 }],
    data: "2026-08-01",
    updateId: -2
  });

  prova("ci si registra sopra il primo volume", primoVolume.serie.posseduti === 1);

  console.log("\nArretrati");
  const mancanti = await db.arretrati();
  prova("l'elenco di cosa manca si legge", Array.isArray(mancanti),
    `${mancanti.length} serie indietro`);

  if (mancanti.length > 0) {
    console.log(`       es. ${mancanti[0].titolo}: hai ${mancanti[0].posseduti}, usciti ${mancanti[0].usciti}`);
  }
} catch (errore) {
  falliti++;
  console.error("\nERRORE:", errore.message);
} finally {
  await cliente.query("ROLLBACK");

  // Il controllo che conta: fuori dalla transazione la collezione
  // deve essere identica a prima, senza la scheda finta e senza la
  // colonna aggiunta dalla migrazione.
  const { rows: finte } = await cliente.query(
    `SELECT COUNT(*)::int AS n FROM "Manga" WHERE "AnimeClickID" = -1`
  );

  const { rows: acquisti } = await cliente.query(`SELECT COUNT(*)::int AS n FROM acquisti`);

  console.log("\nDopo l'annullamento");
  prova("nessuna scheda di prova rimasta", finte[0].n === 0);
  prova("nessun acquisto di prova rimasto", acquisti[0].n === acquistiPrima, `${acquisti[0].n} righe`);

  cliente.release();
  await vero.end();

  console.log(falliti === 0 ? "\nTutto a posto.\n" : `\n${falliti} prove fallite.\n`);
  process.exit(falliti === 0 ? 0 : 1);
}
