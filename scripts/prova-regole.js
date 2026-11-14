// Le regole di acquisto (come si dividono i volumi in blocchi, come si ripartisce il prezzo, quale
// numero è il primo che manca, cosa c'era già in casa, come si annulla) sono scritte DUE VOLTE: qui e in
// mangavault10x-backend/services/acquisti.js. Questa prova fa girare le due copie sugli stessi casi
// (fixtures/acquisti/casi.json, identico nei due repository) e controlla che il file non si sia separato.
//
//   node scripts/prova-regole.js
//
// Se una regola cambia, si cambia in tutti e due i posti e si aggiunge un caso.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { blocchi, ripartisci } from "../src/messaggio.js";
import { primoMancante, giaInCasa, TOGLI_NUMERI } from "../src/collezione.js";

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "acquisti", "casi.json");

// L'impronta del file dei casi: dev'essere la stessa nel backend.
const IMPRONTA = "c214211f163aa610";

const testo = fs.readFileSync(file, "utf8");
const casi = JSON.parse(testo);

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

console.log("\nI casi condivisi");
prova("il file è lo stesso del backend (impronta)", IMPRONTA, crypto.createHash("sha256").update(testo).digest("hex").slice(0, 16));

console.log("\nBlocchi di volumi");
for (const c of casi.blocchi) prova(`${JSON.stringify(c.in)}`, c.out, blocchi([...c.in]));

console.log("\nRipartire il prezzo");
for (const c of casi.ripartisci) {
  const r = ripartisci(c.totale, c.gruppi);

  prova(`${c.totale} su ${c.gruppi.map((g) => `${g.da}-${g.a}`).join(" + ")}`, c.out, r);
  prova("   e la somma torna al totale", Math.round(c.totale * 100), Math.round(r.reduce((s, p) => s + p.prezzo, 0) * 100));
}

console.log("\nIl primo che manca");
for (const c of casi.primoMancante) prova(`${JSON.stringify(c.in)}`, c.out, primoMancante(c.in));

console.log("\nCosa c'era già in casa");
for (const c of casi.giaInCasa) prova(`${c.gruppo.da}-${c.gruppo.a} avendo ${JSON.stringify(c.avevo)}`, c.out, giaInCasa(c.gruppo, new Set(c.avevo)));

console.log("\nLa query che toglie i numeri all'annullo");
prova("è la stessa del backend", casi.togliNumeri, TOGLI_NUMERI.replace(/\s+/g, " ").trim());

console.log(falliti ? `\n${falliti} prove fallite.\n` : "\nTutto a posto.\n");
process.exitCode = falliti ? 1 : 0;
