// Il bot vero, ma fatto girare da questo computer.
//
//   npm run locale        (Ctrl+C per fermarlo)
//
// Serve prima del deploy, per provarlo dal telefono, e dopo per
// sviluppare senza pubblicare a ogni modifica. È lo stesso codice
// della funzione su Vercel: cambia solo come arrivano i messaggi —
// qui li andiamo a chiedere noi (`getUpdates`) invece di aspettare
// che Telegram bussi.
//
// ATTENZIONE: il database è quello VERO. Quello che registri da qui
// finisce in collezione per davvero (e /annulla lo toglie per
// davvero). Le prove senza conseguenze sono `npm run simula`.

import { invia } from "../src/telegram.js";

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatConsentita = process.env.TELEGRAM_CHAT_ID;

if (!token || !chatConsentita || !process.env.DATABASE_URL) {
  console.error("Servono TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID e DATABASE_URL nel .env");
  process.exit(1);
}

// Il segreto che la funzione si aspetta nell'intestazione: qui non
// protegge niente (i messaggi li chiediamo noi), ma il codice è lo
// stesso e quel controllo va soddisfatto.
process.env.TELEGRAM_SECRET_TOKEN ||= "locale";

// Le risposte partono davvero, ma passandogli davanti le stampo qui:
// altrimenti il telefono è l'unico posto dove si vede cos'ha detto.
const inviaVera = globalThis.fetch;

globalThis.fetch = async (url, opzioni) => {
  const indirizzo = String(url);

  if (/api\.telegram\.org\/.*\/(sendMessage|editMessageText)$/.test(indirizzo)) {
    const corpo = JSON.parse(opzioni?.body || "{}");

    for (const riga of String(corpo.text).split("\n")) console.log(`   ${riga.replace(/<[^>]+>/g, "")}`);
    for (const fila of corpo.reply_markup?.inline_keyboard || []) {
      for (const b of fila) console.log(`   [ ${b.text} ]`);
    }
  }

  return inviaVera(url, opzioni);
};

const { default: handler } = await import("../api/telegram.js");

async function api(metodo, corpo) {
  const risposta = await fetch(`https://api.telegram.org/bot${token}/${metodo}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(corpo || {})
  });

  return risposta.json();
}

const info = await api("getWebhookInfo");

if (info?.result?.url) {
  console.error(
    `C'è un webhook collegato a ${info.result.url}.\n` +
      `Finché c'è, Telegram consegna i messaggi là e questo comando non vede niente.\n` +
      `Per lavorare da qui: npm run webhook -- --togli`
  );
  process.exit(1);
}

console.log("In ascolto. Scrivi al bot dal telefono — Ctrl+C per fermare.");
console.log("⚠️  Le registrazioni finiscono nella collezione vera.\n");

let daDove = 0;
let acceso = true;

process.on("SIGINT", () => {
  console.log("\nFermato.");
  acceso = false;
  process.exit(0);
});

function risposta() {
  return {
    status() { return this; },
    send() { return this; }
  };
}

while (acceso) {
  // Attesa lunga: la richiesta resta aperta fino a mezzo minuto in
  // attesa di un messaggio, invece di ripetersi a vuoto ogni secondo.
  const esito = await api("getUpdates", {
    offset: daDove,
    timeout: 30,
    allowed_updates: ["message", "callback_query"]
  });

  if (!esito.ok) {
    console.error("Telegram:", esito.description);
    await new Promise((r) => setTimeout(r, 3000));
    continue;
  }

  for (const aggiornamento of esito.result) {
    daDove = aggiornamento.update_id + 1;

    const testo = aggiornamento.message?.text ?? `[${aggiornamento.callback_query?.data}]`;
    console.log(`→ ${testo}`);

    try {
      await handler(
        {
          method: "POST",
          headers: { "x-telegram-bot-api-secret-token": process.env.TELEGRAM_SECRET_TOKEN },
          body: aggiornamento
        },
        risposta()
      );
    } catch (errore) {
      console.error("  errore:", errore.message);
      await invia(chatConsentita, "⚠️ Il bot gira in locale e si è inceppato.");
    }
  }
}
