// L'interprete del messaggio: da "one piece 105-107 19,80" a dei dati.
//
// La regola che tiene in piedi tutto: si legge DA DESTRA. Prima la
// data, poi il prezzo, poi i volumi, e quello che resta è il titolo.
// Al contrario non funzionerebbe, perché i titoli contengono numeri
// ("Zatch Bell! 2") e spazi, mentre le tre cose in coda hanno una
// forma riconoscibile.
//
// Il prezzo si distingue da un numero di volume per i decimali o per
// il simbolo dell'euro: "berserk 42 7" sono due volumi, "berserk 42
// 7€" è un volume pagato 7 euro. È una convenzione, ma è l'unica che
// non chiede di indovinare.

const MAX_VOLUMI_PER_RIGA = 60; // oltre, è un errore di battitura

/** "42 - 44" e "42-44" sono la stessa cosa: le unisco prima di dividere. */
function unisciIntervalli(testo) {
  return testo.replace(/(\d)\s*[-–—]\s*(\d)/g, "$1-$2");
}

function leggiData(pezzo, oggi = new Date()) {
  const t = pezzo.toLowerCase();

  if (t === "oggi") return new Date(oggi);

  if (t === "ieri") {
    const d = new Date(oggi);
    d.setDate(d.getDate() - 1);
    return d;
  }

  // Solo con le barre: "42-44" è un intervallo di volumi, non il
  // 42 del mese 44.
  const m = t.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (!m) return null;

  const giorno = Number(m[1]);
  const mese = Number(m[2]);
  let anno = m[3] ? Number(m[3]) : oggi.getFullYear();

  if (anno < 100) anno += 2000;
  if (giorno < 1 || giorno > 31 || mese < 1 || mese > 12) return null;

  const data = new Date(Date.UTC(anno, mese - 1, giorno));

  // Senza anno scritto, una data nel futuro è dell'anno scorso:
  // il 30/12 registrato il 2 gennaio è di dicembre.
  if (!m[3] && data > oggi) data.setUTCFullYear(anno - 1);

  return data;
}

function leggiPrezzo(pezzo) {
  const m = pezzo.match(/^€?\s*(\d{1,4})(?:[.,](\d{1,2}))?\s*€?$/);
  if (!m) return null;

  const haEuro = pezzo.includes("€");
  const haDecimali = m[2] !== undefined;

  // Un intero nudo è un volume, non un prezzo.
  if (!haEuro && !haDecimali) return null;

  const centesimi = Number(m[2] ? m[2].padEnd(2, "0") : 0);

  return Number(m[1]) + centesimi / 100;
}

function leggiVolumi(pezzo) {
  const m = pezzo.match(/^(?:vol\.?|v\.?)?(\d{1,4})(?:-(\d{1,4}))?$/i);
  if (!m) return null;

  const da = Number(m[1]);
  const a = m[2] === undefined ? da : Number(m[2]);

  if (da < 1 || a < da) return null;
  if (a - da + 1 > MAX_VOLUMI_PER_RIGA) return null;

  return Array.from({ length: a - da + 1 }, (_, i) => da + i);
}

/**
 * Una riga = un acquisto.
 *
 * Restituisce anche `titoloIntero`, cioè il titolo compresi i numeri
 * finali: serve a chi cerca in collezione, perché "Zatch Bell! 2" è
 * un titolo vero e non il volume 2 di "Zatch Bell!". Chi cerca prova
 * prima quello, e solo se non esiste usa la lettura con i volumi.
 */
export function interpretaRiga(riga, oggi = new Date()) {
  const testo = unisciIntervalli(String(riga).trim().replace(/\s+/g, " "));
  const pezzi = testo.split(" ");

  let data = null;
  let prezzo = null;
  const volumi = [];

  if (pezzi.length > 1) {
    const d = leggiData(pezzi[pezzi.length - 1], oggi);
    if (d) {
      data = d;
      pezzi.pop();
    }
  }

  if (pezzi.length > 1) {
    const p = leggiPrezzo(pezzi[pezzi.length - 1]);
    if (p !== null) {
      prezzo = p;
      pezzi.pop();
    }
  }

  while (pezzi.length > 1) {
    const v = leggiVolumi(pezzi[pezzi.length - 1]);
    if (!v) break;

    volumi.unshift(...v);
    pezzi.pop();
  }

  const titolo = pezzi.join(" ").trim();
  const senzaCoda = testo
    .replace(/\s*(oggi|ieri|\d{1,2}\/\d{1,2}(\/\d{2,4})?)$/i, "")
    .replace(/\s*€?\s*\d{1,4}[.,]\d{1,2}\s*€?$/, "")
    .replace(/\s*€?\s*\d{1,4}\s*€$/, "")
    .trim();

  // Un titolo è fatto di lettere: "42" da solo non è una serie, è
  // qualcuno che ha dimenticato di scrivere quale.
  if (!/[a-zà-öø-ÿ]/i.test(titolo)) {
    return { errore: "manca il titolo", testo };
  }

  const unici = [...new Set(volumi)].sort((a, b) => a - b);

  if (unici.length > MAX_VOLUMI_PER_RIGA) {
    return { errore: "troppi volumi in una riga", testo };
  }

  return {
    testo,
    titolo,
    titoloIntero: senzaCoda,
    volumi: unici.length ? unici : null,
    prezzo,
    data
  };
}

/**
 * Un messaggio può contenere più righe: è il modo naturale di
 * registrare la spesa del mese in un colpo solo, senza inventare una
 * sintassi con i punti e virgola.
 */
export function interpreta(messaggio, oggi = new Date()) {
  const testo = String(messaggio || "").trim();

  if (testo.startsWith("/")) {
    const [comando, ...resto] = testo.split(/\s+/);
    return {
      comando: comando.split("@")[0].slice(1).toLowerCase(),
      argomento: resto.join(" ").trim(),
      righe: []
    };
  }

  const righe = testo
    .split(/\r?\n/)
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => interpretaRiga(r, oggi));

  return { comando: null, argomento: "", righe };
}

/**
 * I volumi contigui vanno insieme in un acquisto solo: 42,43,44 è
 * "il blocco 42-44", mentre 42,44 sono due acquisti separati. La
 * tabella `acquisti` ragiona per intervalli e non saprebbe
 * rappresentare un buco in mezzo.
 */
export function blocchi(volumi) {
  const gruppi = [];

  // Ordinati e senza doppioni, qualunque cosa arrivi: «42 42» non deve
  // diventare due righe di acquisto per lo stesso volume. Oggi chi chiama
  // (`interpretaRiga`) lo fa già, ma una regola che dipende da chi la
  // chiama è una regola che qualcuno prima o poi rompe.
  //
  // ⚠️ gemella: `blocchi` in mangavault10x-backend/services/acquisti.js.
  // I casi condivisi stanno in fixtures/acquisti/casi.json.
  for (const v of [...new Set(volumi)].sort((a, b) => a - b)) {
    const ultimo = gruppi[gruppi.length - 1];

    if (ultimo && v === ultimo.a + 1) ultimo.a = v;
    else gruppi.push({ da: v, a: v });
  }

  return gruppi;
}

/**
 * Il prezzo scritto è il totale della riga, non il prezzo unitario:
 * è quello che si legge sullo scontrino. Va diviso fra i blocchi in
 * proporzione ai volumi, e i centesimi che avanzano dalla divisione
 * finiscono sull'ULTIMO blocco — così la somma dei pezzi torna sempre
 * uguale al totale battuto.
 *
 * ⚠️ gemella: `ripartisci` in mangavault10x-backend/services/acquisti.js.
 */
export function ripartisci(totale, gruppi) {
  const volumiTotali = gruppi.reduce((s, g) => s + (g.a - g.da + 1), 0);
  const centesimi = Math.round(totale * 100);

  let assegnati = 0;

  return gruppi.map((g, i) => {
    const quanti = g.a - g.da + 1;
    const quota =
      i === gruppi.length - 1
        ? centesimi - assegnati
        : Math.round((centesimi * quanti) / volumiTotali);

    assegnati += quota;

    return { ...g, prezzo: quota / 100 };
  });
}
