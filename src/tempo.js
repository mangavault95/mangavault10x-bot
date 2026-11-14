// Il tempo che resta a un messaggio.
//
// Vercel dà 60 secondi alla funzione (vercel.json) e poi la chiude, senza
// avvisare nessuno. Un messaggio che crea due serie nuove fa fino a una decina
// di richieste in fila a siti che a volte rispondono in secondi, e il conto del
// caso peggiore supera i 60: Telegram non riceveva più niente e il messaggio
// restava per sempre su «Sto compilando la scheda…».
//
// Qui si tiene un budget per ogni aggiornamento ricevuto (48 secondi: gli altri
// 12 servono a raccontare com'è andata). Ogni chiamata a un sito esterno prende
// il suo tempo solito o quello che resta, il minore; e chi sta per iniziare un
// lavoro lungo chiede prima se ce n'è abbastanza.
//
// `AsyncLocalStorage` e non una variabile di modulo: l'istanza di Vercel può
// servire due aggiornamenti insieme, e ognuno deve avere il suo orologio.
//
// Fuori da `conBudget` (le prove, gli script) non c'è nessun limite.

import { AsyncLocalStorage } from "node:async_hooks";

export const BUDGET_PREDEFINITO_MS = 48_000;

// Quanta parte del budget serve, almeno, per cominciare un lavoro. Frazioni e non
// secondi, così scalano anche nelle prove, dove il budget è di pochi secondi.
export const FRAZIONE = {
  riga: 0.25, // registrare una riga di una serie che c'è già (il prezzo può costare una richiesta)
  ricerca: 0.25, // cercare un titolo su AnimeClick
  creazione: 0.4 // costruire una scheda: AnimeClick, AniList e i prezzi
};

// Quanto prima della fine dire «ci sto mettendo troppo».
const ANTICIPO_AVVISO = 0.1;

const contesto = new AsyncLocalStorage();

/** Esegue `lavoro` con un budget di `budget` millisecondi. */
export function conBudget(lavoro, budget = BUDGET_PREDEFINITO_MS) {
  return contesto.run({ totale: budget, scade: Date.now() + budget }, lavoro);
}

/** Millisecondi che restano (Infinity fuori da un budget). */
export function rimasto() {
  const c = contesto.getStore();

  return c ? c.scade - Date.now() : Infinity;
}

/**
 * Il tempo massimo da dare a una richiesta: il suo solito (`base`) o quello
 * che resta, il minore. A budget finito lancia, invece di aspettare.
 */
export function attesa(base) {
  const resto = rimasto();

  if (resto <= 0) throw new Error("tempo esaurito");

  return Math.min(base, resto);
}

/** C'è abbastanza tempo per cominciare un lavoro che ne chiede `frazione` del totale? */
export function abbastanza(frazione) {
  const c = contesto.getStore();

  return c ? c.scade - Date.now() >= frazione * c.totale : true;
}

/** Fra quanti millisecondi dire «ci sto mettendo troppo»; null se non c'è un budget. */
export function avvisoTraMs() {
  const c = contesto.getStore();

  if (!c) return null;

  return Math.max(0, c.scade - Date.now() - ANTICIPO_AVVISO * c.totale);
}
