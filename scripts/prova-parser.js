// Prova dei parser di AnimeClick sulle pagine d'esempio di
// `fixtures/animeclick/`. Niente rete e niente database: `fetch` è
// sostituito da uno che risponde con quei file.
//
//   npm run prova-parser     (e parte da sola con `npm test`)
//
// ⚠️ Le pagine sono costruite a mano (vedi fixtures/animeclick/LEGGIMI.md),
// quindi questa prova protegge il NOSTRO codice e la concordanza col
// backend, non dice se AnimeClick ha cambiato l'HTML. Quella si scopre
// salvando la pagina vera e aggiungendo un caso.
//
// La stessa cartella e lo stesso controllo stanno in
// `mangavault10x-backend/scripts/prova-parser.js`: due copie dello stesso
// scraper, e questa è la cosa che le tiene d'accordo.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { cerca, prezziVolumi, scheda } from "../src/animeclick.js";

const CARTELLA = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "animeclick");

// L'impronta delle pagine d'esempio. Dev'essere identica a quella del
// backend: se cambia qui, cambia là (e le pagine vanno ricopiate).
const IMPRONTA = "4e52444db8d84dec";

const leggi = (nome) => fs.readFileSync(path.join(CARTELLA, nome), "utf8");

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

function risposta(corpo, { status = 200, cookie = null } = {}) {
  const testo = typeof corpo === "string" ? corpo : JSON.stringify(corpo);

  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n) => (n.toLowerCase() === "set-cookie" ? cookie : null) },
    text: async () => testo,
    json: async () => (typeof corpo === "string" ? JSON.parse(corpo) : corpo)
  };
}

const fetchVero = globalThis.fetch;
let richieste = [];

/** Da qui in poi `fetch` risponde dalle rotte date e si ricorda le richieste. */
function sito(rotte) {
  richieste = [];

  globalThis.fetch = async (url, opzioni = {}) => {
    richieste.push({ url: String(url), metodo: opzioni.method || "GET", intestazioni: opzioni.headers || {}, corpo: opzioni.body });

    for (const [forma, dai] of rotte) {
      if (forma.test(String(url)) && (!dai.metodo || dai.metodo === (opzioni.method || "GET"))) return dai.risposta();
    }

    return risposta("non trovato", { status: 404 });
  };
}

const sceltaDi = (id) => [[new RegExp(`/manga/${id}/-/$`), { risposta: () => risposta(leggi("scheda-berserk.html")) }]];

try {
  console.log("\nLe pagine d'esempio");
  {
    const hash = crypto.createHash("sha256");

    for (const f of fs.readdirSync(CARTELLA).filter((x) => x !== "LEGGIMI.md").sort()) hash.update(f).update(leggi(f));

    prova("sono le stesse del backend (impronta)", IMPRONTA, hash.digest("hex").slice(0, 16));
  }

  console.log("\nPrezzi (pagina delle edizioni)");
  {
    sito([[/\/edizioni$/, { risposta: () => risposta(leggi("edizioni-berserk.html")) }]]);

    const p = await prezziVolumi(9607);
    const prezzo = (n) => p.get(n)?.prezzo;

    prova("i volumi della serie normale, e l'annunciato col suo prezzo", [1, 2, 3, 4], [...p.keys()].sort((a, b) => a - b));
    prova("per ogni volume vince la riga più recente (la ristampa del 3)", [5.16, 4.9, 5.9], [prezzo(1), prezzo(3), prezzo(4)]);
    prova("Deluxe e Gazzetta non sono la serie in fumetteria", true, !p.has(5) && p.size === 4);

    const d = await prezziVolumi(9607, { edizione: "Deluxe" });

    prova("con un'etichetta tiene solo quella edizione", [[1], 18.9], [[...d.keys()], d.get(1)?.prezzo]);

    sito([[/\/edizioni$/, { risposta: () => risposta(leggi("edizioni-takopi.html")) }]]);

    const t = await prezziVolumi(1);

    // «Blue Box» è un titolo vero: la parola `box` da sola non deve far scartare la riga.
    prova("«Blue Box» non è un cofanetto", [[1, 2, 7], 5.9], [[...t.keys()].sort((a, b) => a - b), t.get(7)?.prezzo]);

    sito([[/\/edizioni$/, { risposta: () => risposta("<html>niente tabella</html>") }]]);

    prova("senza tabella: nessun prezzo, nessun errore", 0, (await prezziVolumi(1)).size);
  }

  console.log("\nScheda");
  {
    sito(sceltaDi(9607));

    const s = await scheda(9607);

    prova("titolo, copertina e titolo originale", ["Berserk", "https://www.animeclick.it/immagini/manga/Berserk/cover.jpg", "ベルセルク (Berserk)"], [s.titolo, s.cover, s.titoloOriginale]);
    prova("due sceneggiatori, un disegnatore", ["Kentaro Miura, Kouji Mori", "Kentaro Miura"], [s.autore, s.disegnatore]);
    prova("generi, categoria (il pubblico, non l'avvertimento), anno, volumi", [["Azione", "Dark Fantasy", "Avventura"], "seinen", 1989, 43], [s.generi, s.categoria, s.anno, s.volumi]);
    prova("lo stato in Italia non è quello in patria", ["in_corso", "conclusa"], [s.statoItalia, s.statoPatria]);
    prova("l'editore è la casa editrice, non il negozio", "Panini Comics", s.editore);
    prova("la trama senza «Trama:» e senza le note", "Guts è un mercenario che porta una spada enorme.", s.trama);
    prova("la scheda non legge il <dl> del piè di pagina", false, /Non Questo/.test(s.autore || ""));

    const conStato = async (valore) => {
      sito([[/./, { risposta: () => risposta(`<dl class="dl-horizontal"><dt>Stato in Italia</dt><dd>${valore}</dd></dl>`) }]]);
      return (await scheda(1)).statoItalia;
    };

    prova("«Concluso»", "conclusa", await conStato("Concluso"));
    prova("«Completo»", "conclusa", await conStato("Completo"));
    prova("«Non concluso» è in corso, come dice il backend", "in_corso", await conStato("Non concluso"));
    prova("«In corso»", "in_corso", await conStato("In corso"));
    prova("«Sospeso»", "interrotta", await conStato("Sospeso"));
    prova("«Annunciato»", "inedita", await conStato("Annunciato"));

    sito([[/./, { risposta: () => risposta('<meta property="og:title" content="Takopi&#x27;s Original Sin" /><meta property="og:image" content="x"/>') }]]);

    prova("apostrofo esadecimale nel titolo", "Takopi's Original Sin", (await scheda(1)).titolo);

    sito([[/./, { risposta: () => risposta('<meta property="og:title" content="Takopi&#039;s Original Sin" />') }]]);

    prova("apostrofo decimale nel titolo", "Takopi's Original Sin", (await scheda(1)).titolo);
  }

  console.log("\nRicerca");
  {
    const modulo = leggi("ricerca-modulo.html");
    const json = JSON.parse(leggi("ricerca-risposta.json"));

    sito([
      [/\/ricerca\/manga$/, { metodo: "GET", risposta: () => risposta(modulo, { cookie: "PHPSESSID=abc; path=/; HttpOnly" }) }],
      [/\/ricerca\/manga$/, { metodo: "POST", risposta: () => risposta(json) }]
    ]);

    const trovate = await cerca("Berserk");

    prova("ordina per somiglianza e scarta chi non c'entra", [9607, 12345, 777], trovate.map((s) => s.id));
    prova("l'anno viene dal riquadro o dal calendario", [1989, 2019, 2005], trovate.map((s) => s.anno));
    prova("il punteggio del titolo identico è 100", 100, trovate[0].punteggio);

    const post = richieste.find((r) => r.metodo === "POST");
    const corpo = new URLSearchParams(post.corpo);

    prova("rimanda token e cookie del modulo", ["tok3n-di-prova_123", "PHPSESSID=abc"], [corpo.get("search_manga[_token]"), post.intestazioni.Cookie]);
    prova("chiede «contiene» e «anno qualunque»", ["0", "-1", "Berserk"], [corpo.get("search_manga[titleOption]"), corpo.get("search_manga[anno]"), corpo.get("search_manga[title]")]);
    prova("si presenta con uno User-Agent", true, richieste.every((r) => /MangaVault/.test(r.intestazioni["User-Agent"] || "")));

    sito([[/\/ricerca\/manga$/, { risposta: () => risposta("<html>modulo cambiato</html>") }]]);

    let errore = null;

    try {
      await cerca("x");
    } catch (e) {
      errore = e.message;
    }

    prova("se il token sparisce dice che non lo trova", true, /token della ricerca non trovato/.test(errore || ""));
  }

  console.log("\nQuando il sito sbaglia");
  {
    sito([[/./, { risposta: () => risposta("no", { status: 404 }) }]]);

    let errore = null;

    try {
      await scheda(1);
    } catch (e) {
      errore = e.message;
    }

    prova("un 404 lo dice con l'indirizzo", true, /HTTP 404 su .*\/manga\/1\/-\//.test(errore || ""));
  }
} finally {
  globalThis.fetch = fetchVero;
}

console.log(falliti ? `\n${falliti} prove fallite.\n` : "\nTutto a posto.\n");
process.exitCode = falliti ? 1 : 0;
