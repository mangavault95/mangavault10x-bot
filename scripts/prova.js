// Le prove dell'interprete e della ricerca del titolo: niente rete,
// niente database, gira in mezzo secondo.
//
//   npm run prova
//
// Serve perché queste due sono le parti che decidono cosa finisce
// scritto in collezione, e sono anche le uniche che si possono
// mettere alla prova senza avere un fumetto in mano.

import { interpretaRiga, interpreta, blocchi, ripartisci } from "../src/messaggio.js";
import { cercaFra } from "../src/collezione.js";

const OGGI = new Date("2026-08-06T12:00:00Z");

let falliti = 0;

function prova(nome, atteso, ottenuto) {
  const a = JSON.stringify(atteso);
  const o = JSON.stringify(ottenuto);

  if (a === o) {
    console.log(`  ok   ${nome}`);
  } else {
    falliti++;
    console.log(`  NO   ${nome}\n       atteso   ${a}\n       ottenuto ${o}`);
  }
}

function letta(testo) {
  const r = interpretaRiga(testo, OGGI);
  return {
    titolo: r.titolo,
    volumi: r.volumi,
    prezzo: r.prezzo,
    data: r.data ? r.data.toISOString().slice(0, 10) : null
  };
}

console.log("\nInterpretazione della riga");
prova("titolo e volume", { titolo: "berserk", volumi: [42], prezzo: null, data: null }, letta("berserk 42"));
prova(
  "intervallo e prezzo",
  { titolo: "one piece", volumi: [105, 106, 107], prezzo: 19.8, data: null },
  letta("one piece 105-107 19,80")
);
prova(
  "intervallo scritto largo",
  { titolo: "one piece", volumi: [105, 106, 107], prezzo: null, data: null },
  letta("one piece 105 - 107")
);
prova("solo titolo", { titolo: "berserk", volumi: null, prezzo: null, data: null }, letta("berserk"));
prova(
  "volumi sparsi",
  { titolo: "gachiakuta", volumi: [14, 15, 16], prezzo: null, data: null },
  letta("gachiakuta 14 15 16")
);
prova(
  "un intero non è un prezzo",
  { titolo: "berserk", volumi: [7, 42], prezzo: null, data: null },
  letta("berserk 42 7")
);
prova(
  "con l'euro invece sì",
  { titolo: "berserk", volumi: [42], prezzo: 7, data: null },
  letta("berserk 42 7€")
);
prova(
  "data di ieri",
  { titolo: "vagabond", volumi: [12], prezzo: 8.9, data: "2026-08-05" },
  letta("vagabond 12 8,90 ieri")
);
prova(
  "data scritta a mano",
  { titolo: "monster", volumi: [3], prezzo: null, data: "2026-07-30" },
  letta("monster 3 30/7")
);
prova(
  "data senza anno, ma nel futuro: è dell'anno scorso",
  { titolo: "monster", volumi: [3], prezzo: null, data: "2025-12-30" },
  letta("monster 3 30/12")
);
prova("prefisso vol.", { titolo: "nana", volumi: [21], prezzo: null, data: null }, letta("nana vol.21"));
prova(
  "il titolo si tiene i suoi numeri",
  "zatch bell! 2",
  interpretaRiga("zatch bell! 2", OGGI).titoloIntero
);
prova("senza titolo", "manca il titolo", interpretaRiga("42", OGGI).errore ?? null);

console.log("\nMessaggio intero");
prova(
  "tre righe",
  ["berserk", "one piece", "monster"],
  interpreta("berserk 42\none piece 105-107 19,80\nmonster 3", OGGI).righe.map((r) => r.titolo)
);
prova("comando", ["mese", "7"], [interpreta("/mese 7").comando, interpreta("/mese 7").argomento]);

console.log("\nBlocchi e prezzi");
prova("contigui", [{ da: 14, a: 16 }], blocchi([14, 15, 16]));
prova("con un buco", [{ da: 14, a: 15 }, { da: 18, a: 18 }], blocchi([14, 15, 18]));
prova(
  "il totale si spartisce senza perdere centesimi",
  10,
  ripartisci(10, blocchi([1, 5, 6])).reduce((s, g) => s + g.prezzo, 0)
);

console.log("\nRicerca del titolo in collezione");
const collezione = [
  { id: 1, titolo: "Berserk", posseduti: 41 },
  { id: 2, titolo: "One Piece", posseduti: 109 },
  { id: 3, titolo: "Sword Art Online", posseduti: 2 },
  { id: 4, titolo: "Sword Art Online - Progressive", posseduti: 5 },
  { id: 5, titolo: "Zatch Bell! 2", posseduti: 1 },
  { id: 6, titolo: "HUNTER x HUNTER", posseduti: 38 }
];

prova("esatto", 1, cercaFra(collezione, "berserk").certa?.id);
prova("maiuscole e spazi", 6, cercaFra(collezione, "hunter x hunter").certa?.id);
prova("con un errore di battitura", 2, cercaFra(collezione, "one pice").certa?.id);
prova(
  "due serie che si somigliano: chiede",
  [4, 3],
  cercaFra(collezione, "sword art online p")?.alternative?.map((s) => s.id)
);
prova("titolo con un numero dentro", 5, cercaFra(collezione, "zatch bell!", "zatch bell! 2").certa?.id);
prova("serie che non c'è", undefined, cercaFra(collezione, "chainsaw man").certa?.id);

console.log(falliti === 0 ? "\nTutto a posto.\n" : `\n${falliti} prove fallite.\n`);
process.exit(falliti === 0 ? 0 : 1);
