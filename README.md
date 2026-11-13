# MangaVault — bot Telegram

Registra i volumi che compri scrivendoli su Telegram, mese per mese.

```
berserk 42
one piece 105-107 19,80
vagabond 12 8,90 ieri
```

Ogni riga diventa una riga nella tabella `acquisti` (quella di
`mangavault10x-backend/sql/001_fondamenta.sql`, che esisteva già e non
aveva mai scritto nessuno) e mette il numero del volume fra i
`"NumeriPosseduti"` della serie (il conteggio `"VolumiPosseduti"` lo
ricava un trigger del database). Da lì `/mese` sa dire quanto hai speso
davvero, invece della stima `Costo × volumi` che fa il sito, e
`/mancanti` quali numeri ti mancano.

## Com'è fatto

Due funzioni su Vercel, una per bot, che parlano direttamente a
Supabase: `api/telegram.js` è il bot degli acquisti, `api/uscite.js`
quello delle uscite (riceve `/start` e fa scegliere il proprio nome; i
messaggi sulle uscite li manda il backend). Non passa dal backend su Render di proposito: quello
(piano gratuito) si addormenta dopo un quarto d'ora, e il primo
messaggio della giornata aspetterebbe il risveglio. Qui la risposta
arriva subito.

| file | cosa fa |
|---|---|
| `api/telegram.js` | riceve il messaggio, risponde, smista |
| `src/messaggio.js` | da `"one piece 105-107 19,80"` ai dati |
| `src/collezione.js` | le query: trova, registra, conta il mese |
| `src/animeclick.js` | ricerca e scheda, per le serie nuove |
| `src/anilist.js` | solo copertina e generi |
| `src/telegram.js` | le tre chiamate all'API di Telegram |
| `api/uscite.js`, `src/uscite.js` | il secondo bot: chi sei, per gli avvisi delle uscite |

## Come si mette in piedi

**1. Il bot su Telegram.** Su Telegram scrivi a
[@BotFather](https://t.me/BotFather), `/newbot`, scegli nome e
username. Ti risponde con un token: è la chiave di tutto, non va
committata da nessuna parte.

**2. Il database.** Supabase → SQL Editor → incolla
[`sql/001_telegram.sql`](sql/001_telegram.sql) → Run. Aggiunge una
tabellina contro i doppioni e una colonna su `acquisti`. Non tocca
niente di quello che c'è.

**3. Il progetto su Vercel.** Si pubblica **a mano**, dalla cartella:
`vercel --prod`. Un push su GitHub non pubblica niente (vedi
`.vercelignore` per il perché e per cosa resta fuori dal caricamento).
Non c'è niente da compilare: Vercel riconosce `api/` da solo.

**4. Le variabili d'ambiente** (Vercel → Settings → Environment Variables):

| nome | dove si prende |
|---|---|
| `TELEGRAM_BOT_TOKEN` | @BotFather, punto 1 |
| `TELEGRAM_SECRET_TOKEN` | `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"` |
| `TELEGRAM_CHAT_ID` | punto 5 qui sotto |
| `DATABASE_URL` | la stessa del backend — quella del **pooler** (porta 6543) |
| `TELEGRAM_USCITE_TOKEN`, `TELEGRAM_USCITE_SECRET` | il secondo bot: token da @BotFather e un segreto generato come sopra |
| `SITO_URL` | l'indirizzo del sito, per i link nei messaggi |

Se `TELEGRAM_SECRET_TOKEN` o `TELEGRAM_CHAT_ID` mancano il bot degli
acquisti risponde 401 a tutti: una variabile dimenticata lo rende muto,
non aperto.

**5. Il tuo identificativo.** Copia `.env.example` in `.env`, riempi
`TELEGRAM_BOT_TOKEN`, scrivi un messaggio qualsiasi al bot e poi:

```bash
npm install && npm run chatid
```

Il numero che stampa va in `TELEGRAM_CHAT_ID`, sia nel `.env` sia su
Vercel. Il bot ignora chiunque altro.

**6. Collega il webhook.** Con `BOT_URL` e `TELEGRAM_SECRET_TOKEN` nel
`.env` (gli stessi valori che hai messo su Vercel):

```bash
npm run webhook
```

Da qui in poi funziona. `npm run webhook -- --stato` dice a chi è
collegato e se Telegram ha incontrato errori.

## Le prove

```bash
npm run prova       # l'interprete e la ricerca del titolo, senza rete
npm run verifica    # tutte le query contro il database vero
npm run simula      # il bot intero, con le risposte stampate qui
```

`verifica` e `simula` aprono una transazione, ci fanno dentro tutte le
scritture e alla fine la annullano: girano sul database di produzione
senza lasciarci niente. Vogliono `DATABASE_URL` nel `.env`.

## Farlo girare da qui

```bash
npm run locale
```

Stesso codice della funzione su Vercel: cambia solo che i messaggi
andiamo a chiederli noi invece di aspettare che Telegram bussi. Serve
per provarlo dal telefono prima del deploy, e dopo per sviluppare
senza pubblicare a ogni modifica.

Due avvertenze: **il database è quello vero** (quello che registri da
qui va in collezione davvero), e finché c'è un webhook collegato
Telegram consegna i messaggi là e questo comando non vede niente —
`npm run webhook -- --togli` prima, `npm run webhook` per rimetterlo.

## Cose da sapere

- **Il prezzo è il totale della riga**, non quello di un volume:
  `one piece 105-107 19,80` sono tre volumi per 19,80 € in tutto. Se
  non lo scrivi si usa il prezzo di copertina, o in mancanza il
  `Costo` della serie — e il messaggio dice quale dei due.
- **Un numero intero è un volume, non un prezzo.** Per scrivere un
  prezzo tondo serve l'euro: `berserk 42 7€`.
- **Entra il numero del volume, non un +1.** Chi ha 1-41 e compra il
  45 ha 1-41 e 45: il bot lo scrive così e avvisa che in mezzo manca
  qualcosa.
- **Le serie nuove** vengono da AnimeClick (trama in italiano,
  editore, stato) più AniList (copertina grande e generi in inglese,
  come tutti gli altri in collezione). Viene salvato anche
  l'`AnimeClickID`, che è quello che fa entrare la serie nel controllo
  mensile dei volumi usciti in Italia — prima andava scritto a mano.
- **Se la ricerca non la trova**, mandagli il link della scheda:
  `animeclick.it/manga/9607/berserk 1 6,90`. Capita con le serie che
  AnimeClick elenca sotto il titolo giapponese.
- **`/annulla` disfa l'ultimo messaggio**, non l'ultima riga: se ne
  hai mandate tre insieme le toglie tutte e tre. Toglie dai posseduti
  solo i volumi che quel messaggio aveva portato: un doppione
  registrato apposta non fa sparire la copia che c'era già.
- **Le prove**: `npm test` (o `npm run prova`) gira senza rete né
  database e parte da sola a ogni push; `verifica`, `simula` e
  `prova-uscite` parlano col database vero dentro una transazione che
  alla fine si annulla.
