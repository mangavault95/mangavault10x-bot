// L'accesso al database: trovare una serie, registrare un acquisto,
// fare i conti del mese.
//
// Il bot parla direttamente a Supabase invece di passare dal backend
// su Render, e non per pigrizia: Render (piano gratuito) si addormenta
// dopo un quarto d'ora, e il primo messaggio dopo una pausa aspetterebbe
// il risveglio del servizio. Da qui una query va e torna in un decimo
// di secondo.
//
// La tabella `acquisti` esiste da sempre (sql/001_fondamenta.sql) e
// non l'ha mai scritta nessuno: è nata per questo — una riga per
// acquisto vero, con la data, che è ciò che rende possibile il conto
// del mese.

import pg from "pg";
import Fuse from "fuse.js";

// Una connessione sola per istanza: su serverless ogni invocazione
// che ne apre una nuova consuma uno slot del pooler, e Supabase ne
// concede pochi. Il modulo resta in memoria fra un messaggio e
// l'altro finché Vercel tiene viva l'istanza, quindi il pool si
// riusa da solo.
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

/**
 * Sostituisce la connessione dall'esterno.
 *
 * Serve a scripts/verifica.js, che fa girare tutte le scritture
 * dentro una transazione e poi la annulla: è l'unico modo di provare
 * per davvero contro il database vero senza lasciarci dentro un
 * acquisto finto.
 */
export function usaConnessione(sostituto) {
  pool = sostituto;
}

/**
 * Oggi in Italia, non oggi a Greenwich.
 *
 * Il server sta su UTC: un volume comprato alle 00:30 di sabato
 * finirebbe registrato al venerdì, e a fine mese la spesa scivolerebbe
 * di un giorno nel mese sbagliato. `sv-SE` perché è l'unica locale
 * che formatta già come "2026-08-06".
 */
export function oggiInItalia() {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Rome" }).format(new Date());
}

export function giornoISO(data) {
  if (!data) return oggiInItalia();
  if (typeof data === "string") return data.slice(0, 10);

  return new Intl.DateTimeFormat("sv-SE", { timeZone: "UTC" }).format(data);
}

// --------------------------------------------------
// DOPPIONI
// --------------------------------------------------

/**
 * Telegram rimanda lo stesso aggiornamento finché non riceve un 200,
 * e un risveglio lento basta a farne arrivare due copie. Senza questo
 * controllo lo stesso volume verrebbe registrato due volte — un bot
 * che scrive sul database non può permetterselo.
 */
export async function primaVolta(updateId) {
  const { rowCount } = await connessione().query(
    `INSERT INTO telegram_visti (update_id) VALUES ($1) ON CONFLICT DO NOTHING`,
    [updateId]
  );

  return rowCount === 1;
}

// --------------------------------------------------
// RICERCA DELLA SERIE
// --------------------------------------------------

// "NumeriPosseduti" c'è dalla migrazione 022 del backend (02/11/2026):
// QUALI volumi ci sono in casa, non solo quanti. Il conteggio resta e
// lo tiene allineato un trigger, quindi `posseduti` è sempre giusto.
const CAMPI = `"ID", "Titolo", "VolumiPosseduti", "NumeriPosseduti", "VolumiItalia", "VolumiTotali",
               "Costo", "PrezzoCopertina", "StatoSerie", "Edizione", "AnimeClickID"`;

function normalizzaRiga(r) {
  return {
    id: Number(r.ID),
    titolo: String(r.Titolo).trim(),
    posseduti: Number(r.VolumiPosseduti || 0),
    numeri: (r.NumeriPosseduti || []).map(Number),
    volumiItalia: r.VolumiItalia === null ? null : Number(r.VolumiItalia),
    volumiTotali: r.VolumiTotali === null ? null : Number(r.VolumiTotali),
    costo: r.Costo === null ? null : Number(r.Costo),
    prezzoCopertina: r.PrezzoCopertina === null ? null : Number(r.PrezzoCopertina),
    stato: r.StatoSerie,
    edizione: r.Edizione,
    animeClickId: r.AnimeClickID
  };
}

export async function elenco() {
  const { rows } = await connessione().query(`SELECT ${CAMPI} FROM "Manga"`);
  return rows.map(normalizzaRiga);
}

export async function perId(id) {
  const { rows } = await connessione().query(`SELECT ${CAMPI} FROM "Manga" WHERE "ID" = $1`, [id]);
  return rows.length ? normalizzaRiga(rows[0]) : null;
}

function normalizza(testo) {
  return String(testo || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Quale serie della collezione è quella scritta nel messaggio.
 *
 * Tre esiti possibili, e la differenza conta: `certa` si registra
 * subito, `alternative` si fa scegliere con dei bottoni, niente vuol
 * dire che la serie non c'è (e allora si va su AnimeClick).
 *
 * `titoloIntero` è il titolo compresi i numeri finali: va provato per
 * primo perché "Zatch Bell! 2" è un titolo vero, non il volume 2 di
 * "Zatch Bell!".
 */
export function cercaFra(serie, titolo, titoloIntero = null) {
  const esatta = (testo) => {
    const t = normalizza(testo);
    return t ? serie.find((s) => normalizza(s.titolo) === t) : null;
  };

  const conNumeri = titoloIntero && titoloIntero !== titolo ? esatta(titoloIntero) : null;
  if (conNumeri) return { certa: conNumeri, comeTitoloIntero: true };

  const precisa = esatta(titolo);
  if (precisa) return { certa: precisa };

  const fuse = new Fuse(serie, {
    keys: ["titolo"],
    includeScore: true,
    ignoreLocation: true,
    threshold: 0.45,
    minMatchCharLength: 3
  });

  const risultati = fuse.search(titolo).slice(0, 3);

  if (risultati.length === 0) return {};

  const [primo, secondo] = risultati;

  // Un solo candidato buono e nessuno che gli somigli: è quello. Con
  // due punteggi vicini invece si chiede, perché in collezione ci sono
  // serie che si assomigliano davvero (i vari "Sword Art Online") e
  // indovinare significa registrare il volume sulla serie sbagliata.
  //
  // I due numeri sono misurati, non scelti a occhio: "one pice" prende
  // 0,23 su "One Piece" (un refuso va perdonato), mentre "sword art
  // online p" prende 0,275 e 0,281 sulle due serie — praticamente
  // pari, ed è esattamente il caso in cui va chiesto.
  const netta = primo.score <= 0.28 && (!secondo || secondo.score - primo.score >= 0.1);

  if (netta) return { certa: primo.item };

  return { alternative: risultati.map((r) => r.item) };
}

export async function trova(titolo, titoloIntero) {
  return cercaFra(await elenco(), titolo, titoloIntero);
}

// --------------------------------------------------
// REGISTRAZIONE
// --------------------------------------------------

/** Il primo numero che non c'è: in [1,2,3,4,5,11] è il 6, non il 12. */
export function primoMancante(numeri) {
  const presenti = new Set(numeri);
  let n = 1;

  while (presenti.has(n)) n += 1;

  return n;
}

/** I numeri di una serie di blocchi: [{da:42,a:44}] → [42,43,44]. */
function numeriDi(gruppi) {
  return gruppi.flatMap((g) => Array.from({ length: g.a - g.da + 1 }, (_, i) => g.da + i));
}

/**
 * Scrive un acquisto e mette i volumi comprati fra i posseduti.
 *
 * Le due scritture stanno in una transazione perché sono la stessa
 * informazione detta due volte: un acquisto senza i posseduti
 * aggiornati è un volume che hai comprato e che il sito non ti conta.
 *
 * Dal 02/11/2026 entra il NUMERO del volume, non un +1: chi ha 1-41 e
 * compra il 45 ha 1-41 e 45, e il buco 42-44 resta scritto. Il
 * conteggio lo ricava il trigger della 022.
 */
export async function registra({ serie, gruppi, data, updateId, negozio = null, condizione = "nuovo" }) {
  const cliente = await connessione().connect();
  const giorno = giornoISO(data);

  try {
    await cliente.query("BEGIN");

    const scritti = [];

    for (const g of gruppi) {
      const { rows } = await cliente.query(
        `INSERT INTO acquisti
           (manga_id, volume_da, volume_a, prezzo, data_acquisto, condizione, negozio, telegram_update_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, volume_da, volume_a, prezzo, data_acquisto`,
        [serie.id, g.da, g.a, g.prezzo, giorno, condizione, negozio, updateId]
      );

      scritti.push(rows[0]);
    }

    const comprati = numeriDi(gruppi);
    const quanti = comprati.length;

    const { rows: aggiornata } = await cliente.query(
      `UPDATE "Manga"
          SET "NumeriPosseduti" = "NumeriPosseduti" || $1::int[]
        WHERE "ID" = $2
      RETURNING ${CAMPI}`,
      [comprati, serie.id]
    );

    await cliente.query("COMMIT");

    return { scritti, serie: normalizzaRiga(aggiornata[0]), quanti };
  } catch (errore) {
    await cliente.query("ROLLBACK");
    throw errore;
  } finally {
    cliente.release();
  }
}

/**
 * Disfa l'ultimo messaggio registrato, non l'ultima riga: se hai
 * mandato tre serie insieme e ti sei accorto di un errore, quello che
 * vuoi annullare è il messaggio intero.
 */
export async function annullaUltimo() {
  const cliente = await connessione().connect();

  try {
    await cliente.query("BEGIN");

    const { rows: ultimo } = await cliente.query(
      `SELECT telegram_update_id FROM acquisti
        WHERE telegram_update_id IS NOT NULL
        ORDER BY id DESC LIMIT 1`
    );

    if (ultimo.length === 0) {
      await cliente.query("ROLLBACK");
      return null;
    }

    const { rows: righe } = await cliente.query(
      `DELETE FROM acquisti a
        USING "Manga" m
        WHERE a.telegram_update_id = $1 AND m."ID" = a.manga_id
    RETURNING a.manga_id, a.volume_da, a.volume_a, a.prezzo, m."Titolo"`,
      [ultimo[0].telegram_update_id]
    );

    // Escono proprio i numeri che quell'acquisto aveva portato.
    for (const r of righe) {
      await cliente.query(
        `UPDATE "Manga"
            SET "NumeriPosseduti" = ARRAY(
              SELECT n FROM unnest("NumeriPosseduti") AS n WHERE n NOT BETWEEN $1 AND $2 ORDER BY n
            )
          WHERE "ID" = $3`,
        [r.volume_da, r.volume_a, r.manga_id]
      );
    }

    await cliente.query("COMMIT");

    return righe.map((r) => ({
      titolo: String(r.Titolo).trim(),
      da: r.volume_da,
      a: r.volume_a,
      prezzo: Number(r.prezzo)
    }));
  } catch (errore) {
    await cliente.query("ROLLBACK");
    throw errore;
  } finally {
    cliente.release();
  }
}

// --------------------------------------------------
// CONTI
// --------------------------------------------------

/** Gli acquisti di un mese, riga per riga, con il totale. */
export async function acquistiDelMese(giornoDelMese) {
  // La data torna già scritta, non come oggetto Date: una colonna
  // DATE diventerebbe la mezzanotte del fuso di chi legge, e da
  // Roma la mezzanotte del primo agosto è ancora luglio a Greenwich.
  const { rows } = await connessione().query(
    `SELECT m."Titolo", a.volume_da, a.volume_a, a.prezzo,
            to_char(a.data_acquisto, 'YYYY-MM-DD') AS giorno
       FROM acquisti a
       JOIN "Manga" m ON m."ID" = a.manga_id
      WHERE date_trunc('month', a.data_acquisto) = date_trunc('month', $1::date)
      ORDER BY a.data_acquisto, m."Titolo"`,
    [giornoDelMese]
  );

  return rows.map((r) => ({
    titolo: String(r.Titolo).trim(),
    da: r.volume_da,
    a: r.volume_a,
    quanti: (r.volume_a ?? r.volume_da) - (r.volume_da ?? 0) + 1,
    prezzo: Number(r.prezzo),
    giorno: r.giorno
  }));
}

/**
 * Le serie con dei volumi arretrati: quelle che sono uscite in Italia
 * più avanti di dove sei arrivato. È la risposta alla domanda che ci
 * si fa in fumetteria, "cosa mi manca".
 *
 * Il denominatore è "VolumiItalia" (quanti se ne trovano in negozio
 * oggi), non "VolumiTotali" (quanti ne esistono in Giappone): sono
 * due domande diverse e la seconda farebbe risultare arretrati dei
 * volumi che nessuno può ancora comprare.
 *
 * Ci sono anche le serie che hai mollato, segnate come tali: la
 * domanda è quali volumi mancano, non quali vale la pena comprare.
 */
export async function arretrati() {
  // Il ripiego su "VolumiTotali" è la stessa regola del sito
  // (`totaleDisponibile` in dati/serie.js): quando non si sa quanti
  // ne siano usciti in Italia si usa il totale, che per una serie
  // conclusa è quasi sempre lo stesso numero. Ma le due cose restano
  // distinte nella risposta, perché su una serie ancora in corso quel
  // totale è giapponese e comprende volumi che qui non esistono.
  // LE DROPPATE CI SONO, SEGNATE.
  //
  // Prima restavano fuori dall'elenco, in silenzio: sembrava sensato
  // — non si compra il seguito di una serie mollata — ma "mancanti"
  // vuol dire i volumi che mancano, e un elenco che ne toglie qualcuno
  // senza dirlo è un elenco di cui non ci si può fidare. Adesso
  // compaiono con l'etichetta, e sei tu a decidere se comprarle.
  //
  // Droppate da CHI: dalla migrazione 011 mollare è una decisione di
  // chi legge, non un fatto della serie. Qui conta la tua — questa è
  // la tua lista della spesa, e se l'altra lettrice ha mollato una
  // serie che tu segui i volumi ti mancano lo stesso.
  //
  // LE SMESSE INVECE NO (026, 13/11/2026). Droppare è «non la leggo»;
  // smettere è «in casa non la compriamo più», detto apposta perché
  // i suoi buchi smettano di comparire nella lista della spesa. Qui
  // non c'è niente da decidere: la decisione è già presa.
  const { rows } = await connessione().query(
    `SELECT m."Titolo", m."VolumiPosseduti", m."VolumiItalia",
            COALESCE(m."VolumiItalia", m."VolumiTotali") AS traguardo,
            EXISTS (
              SELECT 1
                FROM letture_droppate d
                JOIN utenti u ON u.id = d.utente_id
               WHERE d.manga_id = m."ID" AND u.proprietario
            ) AS droppata
       FROM "Manga" m
      WHERE COALESCE(m."VolumiItalia", m."VolumiTotali") > COALESCE(m."VolumiPosseduti", 0)
        AND m."SmessaIl" IS NULL
      ORDER BY (COALESCE(m."VolumiItalia", m."VolumiTotali") - COALESCE(m."VolumiPosseduti", 0)), m."Titolo"`
  );

  return rows.map((r) => ({
    titolo: String(r.Titolo).trim(),
    posseduti: Number(r.VolumiPosseduti || 0),
    usciti: Number(r.traguardo),
    droppata: Boolean(r.droppata),
    inItalia: r.VolumiItalia !== null
  }));
}

/**
 * I volumi già registrati per una serie, per accorgersi di un
 * doppione. Vale solo da quando il bot esiste: la collezione di prima
 * è un contatore, non un elenco di numeri.
 */
export async function volumiRegistrati(mangaId) {
  const { rows } = await connessione().query(
    `SELECT volume_da, volume_a FROM acquisti WHERE manga_id = $1`,
    [mangaId]
  );

  const numeri = new Set();

  for (const r of rows) {
    const da = r.volume_da ?? 0;
    const a = r.volume_a ?? da;

    for (let v = da; v <= a; v++) numeri.add(v);
  }

  return numeri;
}

// --------------------------------------------------
// SERIE NUOVA
// --------------------------------------------------

/**
 * Crea la scheda di una serie che non era in collezione.
 *
 * "ID" non ha una sequenza collegata in questa tabella: va calcolato
 * a mano, come già fanno le rotte del backend, o l'INSERT fallisce
 * con "null value in column ID".
 *
 * "AnimeClickID" e "StatoSerie" non sono decorativi: sono le due
 * condizioni che fanno entrare la serie nel controllo mensile dei
 * volumi usciti in Italia. Salvandoli qui, la scheda si tiene
 * aggiornata da sola senza che nessuno scriva più una riga di SQL.
 */
export async function creaSerie(dati) {
  const cliente = await connessione().connect();

  try {
    await cliente.query("BEGIN");

    const { rows: prossimo } = await cliente.query(
      `SELECT COALESCE(MAX("ID"), 0) + 1 AS id FROM "Manga"`
    );

    const { rows } = await cliente.query(
      `INSERT INTO "Manga"
         ("ID", "Titolo", "TitoloOriginale", "Autore", "Disegnatore", "Genere",
          "Categoria", "Trama", "CoverURL", "Editore", "VolumiTotali", "StatoSerie",
          "AnnoInizio", "AnimeClickID", "VolumiPosseduti", "Costo",
          "PrezzoCopertina", "DataAggiunta")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 0, $15, $16, $17)
       RETURNING ${CAMPI}`,
      [
        prossimo[0].id,
        dati.titolo,
        dati.titoloOriginale,
        dati.autore,
        dati.disegnatore,
        dati.genere,
        // Il pubblico dell'opera. È la colonna che alimenta i temi del
        // Kachinuki-sen ("Miglior seinen"): una serie creata qui senza
        // categoria sarebbe l'unica esclusa da quei tornei.
        dati.categoria ?? null,
        dati.trama,
        dati.cover,
        dati.editore,
        dati.volumiTotali,
        dati.stato,
        dati.anno,
        dati.animeClickId,
        dati.prezzo ?? null,
        dati.prezzo ?? null,
        oggiInItalia()
      ]
    );

    await cliente.query("COMMIT");

    return normalizzaRiga(rows[0]);
  } catch (errore) {
    await cliente.query("ROLLBACK");
    throw errore;
  } finally {
    cliente.release();
  }
}

/**
 * Il prezzo ufficiale di un volume, quando lo si scopre per caso.
 *
 * `COALESCE` nella condizione e non nel valore: si scrive solo se la
 * casella è vuota. Un prezzo messo a mano da te vale più di uno
 * trovato in giro, anche se il mio è più recente.
 */
export async function salvaPrezzoCopertina(id, prezzo) {
  await connessione().query(
    `UPDATE "Manga" SET "PrezzoCopertina" = $1
      WHERE "ID" = $2 AND "PrezzoCopertina" IS NULL`,
    [prezzo, id]
  );
}

export async function esisteAnimeClickId(id) {
  const { rows } = await connessione().query(
    `SELECT ${CAMPI} FROM "Manga" WHERE "AnimeClickID" = $1 LIMIT 1`,
    [id]
  );

  return rows.length ? normalizzaRiga(rows[0]) : null;
}
