// Collega il bot al suo indirizzo su Vercel — o dice a chi è
// collegato adesso.
//
//   npm run webhook           registra il webhook
//   npm run webhook -- --stato   com'è messo
//   npm run webhook -- --togli   lo scollega
//   npm run chatid            il tuo identificativo Telegram
//
// Si esegue a mano, una volta sola: l'indirizzo di un progetto Vercel
// non cambia a ogni deploy.

const token = process.env.TELEGRAM_BOT_TOKEN;
const segreto = process.env.TELEGRAM_SECRET_TOKEN;
const indirizzo = (process.env.BOT_URL || "").replace(/\/+$/, "");

if (!token) {
  console.error("Manca TELEGRAM_BOT_TOKEN nel .env");
  process.exit(1);
}

async function chiama(metodo, corpo) {
  const risposta = await fetch(`https://api.telegram.org/bot${token}/${metodo}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(corpo || {})
  });

  const json = await risposta.json();

  if (!json.ok) {
    console.error(`${metodo} è fallito:`, json.description);
    process.exit(1);
  }

  return json.result;
}

const azione = process.argv[2] || "";

if (azione === "--stato") {
  const info = await chiama("getWebhookInfo");
  console.log(JSON.stringify(info, null, 2));

  if (info.last_error_message) {
    console.log(`\nUltimo errore: ${info.last_error_message}`);
  }
} else if (azione === "--togli") {
  await chiama("deleteWebhook", { drop_pending_updates: true });
  console.log("Webhook rimosso.");
} else if (azione === "--chatid") {
  // getUpdates funziona solo senza webhook attivo: se l'hai già
  // collegato, Telegram tiene i messaggi per il webhook e questo
  // elenco resta vuoto.
  const aggiornamenti = await chiama("getUpdates", {});
  const mittenti = new Map();

  for (const a of aggiornamenti) {
    const da = a.message?.from || a.callback_query?.from;
    if (da) mittenti.set(da.id, da.username || da.first_name || "");
  }

  if (mittenti.size === 0) {
    console.log(
      "Nessun messaggio in coda.\n" +
        "Scrivi qualcosa al bot su Telegram e riprova.\n" +
        "Se il webhook è già collegato, prima: npm run webhook -- --togli"
    );
  } else {
    for (const [id, nome] of mittenti) console.log(`${id}  ${nome}`);
  }
} else {
  if (!segreto || !indirizzo) {
    console.error("Servono TELEGRAM_SECRET_TOKEN e BOT_URL nel .env");
    process.exit(1);
  }

  await chiama("setWebhook", {
    url: `${indirizzo}/api/telegram`,
    secret_token: segreto,
    // Solo quello che il bot sa gestire: ogni altro tipo di
    // aggiornamento sarebbe una funzione svegliata per niente.
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: true
  });

  await chiama("setMyCommands", {
    commands: [
      { command: "mese", description: "quanto hai speso questo mese" },
      { command: "mancanti", description: "cosa ti manca da comprare" },
      { command: "annulla", description: "disfa l'ultimo messaggio" },
      { command: "aiuto", description: "come si scrive un acquisto" }
    ]
  });

  console.log(`Webhook collegato a ${indirizzo}/api/telegram`);
}
