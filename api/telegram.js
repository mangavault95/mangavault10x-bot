// Il bot: riceve un messaggio da Telegram e registra un acquisto.
//
// Tutto quello che c'è da sapere per usarlo sta in /aiuto qui sotto.
// Quello che c'è da sapere per leggerlo è questo: una funzione
// serverless vive il tempo di una risposta, quindi qui non c'è nessuno
// stato in memoria. Quando serve ricordarsi qualcosa fra un messaggio
// e il tocco di un bottone, il ricordo viaggia DENTRO il bottone
// (`callback_data`, 64 byte) — non in una sessione che al prossimo
// avvio non ci sarebbe più.

import { interpreta, blocchi, ripartisci } from "../src/messaggio.js";
import { conBudget, abbastanza, avvisoTraMs, FRAZIONE, BUDGET_PREDEFINITO_MS } from "../src/tempo.js";
import * as db from "../src/collezione.js";
import * as animeclick from "../src/animeclick.js";
import { copertinaEGeneri } from "../src/anilist.js";
import { invia, modifica, confermaBottone, esc } from "../src/telegram.js";

// --------------------------------------------------
// FORMATO
// --------------------------------------------------

const euro = new Intl.NumberFormat("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const MESI = ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno",
              "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"];

function soldi(n) {
  return `${euro.format(Number(n || 0))} €`;
}

function contaVolumi(n) {
  return n === 1 ? "1 volume" : `${n} volumi`;
}

function elencaVolumi(gruppi) {
  return gruppi
    .map((g) => (g.da === g.a ? `${g.da}` : `${g.da}-${g.a}`))
    .join(", ");
}

// I volumi dentro un bottone: "42-44.47" sta in pochi byte e si
// rilegge senza ambiguità.
function codificaVolumi(volumi) {
  if (!volumi || volumi.length === 0) return "-";
  return elencaVolumi(blocchi(volumi)).replace(/, /g, ".");
}

/**
 * `callback_data` ha un tetto di 64 byte e un titolo lungo lo sfonda
 * da solo. Taglio il titolo e non il resto: quel testo serve solo a
 * rifare la ricerca, e mezzo titolo la serie la trova lo stesso.
 */
function accorcia(prefisso, titolo) {
  const misura = (t) => new TextEncoder().encode(t).length;
  let testo = String(titolo);

  while (testo && misura(prefisso + testo) > 64) testo = testo.slice(0, -1);

  return prefisso + testo;
}

function decodificaVolumi(testo) {
  if (!testo || testo === "-") return null;

  const numeri = [];

  for (const pezzo of testo.split(".")) {
    const [da, a = da] = pezzo.split("-").map(Number);
    for (let v = da; v <= a; v++) numeri.push(v);
  }

  return numeri;
}

// --------------------------------------------------
// AIUTO
// --------------------------------------------------

const AIUTO = `📚 <b>MangaVault</b> — registra i volumi che compri.

Scrivi il titolo e il volume:
<code>berserk 42</code>
<code>one piece 105-107 19,80</code>
<code>vagabond 12 8,90 ieri</code>

• Il <b>volume</b> si può omettere: prendo il prossimo che ti manca.
• Il <b>prezzo</b> è il totale della riga e va scritto con i decimali o con €, altrimenti lo leggo come un altro volume. Se non lo scrivi uso il prezzo di copertina.
• La <b>data</b> è oggi, oppure <code>ieri</code> o <code>3/8</code>.
• Più righe in un messaggio = più serie in un colpo solo.

Se la serie non ce l'hai, la cerco su AnimeClick e la creo con trama, copertina ed editore. Se la cerco e non la trovo, mandami il link della sua scheda:
<code>animeclick.it/manga/9607/berserk 1 6,90</code>

/mese — quanto hai speso questo mese
/mancanti — cosa ti manca da comprare
/annulla — disfa l'ultimo messaggio`;

// --------------------------------------------------
// REGISTRAZIONE
// --------------------------------------------------

/**
 * Il prezzo da scrivere quando non l'hai battuto tu, e da dove viene.
 *
 * Dirlo cambia quanto ci si può fidare del totale del mese: il prezzo
 * di copertina è il prezzo vero di quel volume, mentre "Costo" è
 * quanto costano di solito i volumi di quella serie — una media che
 * per un volume speciale può essere lontana.
 */
async function prezzoDiRipiego(serie, numeri, prezziPronti) {
  const quanti = numeri.length;

  // AnimeClick sa il prezzo di ogni singolo volume, e non è la stessa
  // cosa di una media: il 34 di Blue Lock costa 7,90 € e il primo
  // costava 7,00 €. Vale la pena scaricare la pagina delle edizioni
  // (~1 MB) perché il numero che ne esce è quello stampato in quarta
  // di copertina, non una stima.
  //
  // `prezziPronti`: una serie appena creata li ha già chiesti mentre aspettava
  // AniList (`creaERegistra`). `null` vuol dire «li ho chiesti e non sono
  // arrivati»: non si rifà la stessa richiesta lenta una seconda volta.
  if (serie.animeClickId && prezziPronti !== null) {
    try {
      const prezzi = prezziPronti ?? (await animeclick.prezziVolumi(serie.animeClickId, { edizione: serie.edizione }));
      const trovati = numeri.map((n) => prezzi.get(n)?.prezzo).filter((p) => p > 0);

      // O tutti o nessuno: mescolare due fonti in un totale solo
      // vorrebbe dire non poter più dire da dove viene il numero.
      if (trovati.length === quanti && plausibile(trovati, serie)) {
        return {
          totale: trovati.reduce((s, p) => s + p, 0),
          nota: "prezzo di copertina, da AnimeClick",
          unitario: prezzi.get(Math.max(...numeri))?.prezzo ?? null
        };
      }
    } catch (errore) {
      console.error("prezzi AnimeClick:", errore.message);
    }
  }

  if (serie.prezzoCopertina > 0) {
    return { totale: serie.prezzoCopertina * quanti, nota: "prezzo di copertina" };
  }

  if (serie.costo > 0) {
    return { totale: serie.costo * quanti, nota: "prezzo abituale della serie" };
  }

  return { totale: 0, nota: "prezzo non indicato" };
}

/**
 * Il controllo che tiene lontane le edizioni sbagliate.
 *
 * Su AnimeClick una serie ha spesso più edizioni nella stessa
 * tabella, e non tutte si riconoscono dal nome: il primo volume di
 * One Piece risulta a 10,90 € perché è una ristampa da collezione.
 * Se il prezzo trovato è lontanissimo da quello che quella serie ti
 * costa di solito, è più probabile che sia l'edizione sbagliata che
 * un rincaro.
 */
function plausibile(prezzi, serie) {
  if (!(serie.costo > 0)) return true;

  const medio = prezzi.reduce((s, p) => s + p, 0) / prezzi.length;

  return medio >= serie.costo * 0.4 && medio <= serie.costo * 2.5;
}

/**
 * "su 26 usciti" e "su 43 in tutto" non sono la stessa frase: il
 * primo numero è quello che si trova in fumetteria oggi, il secondo
 * quanti ne esistono in Giappone. Dire "usciti" del totale giapponese
 * farebbe sembrare arretrati dei volumi che nessuno può comprare.
 */
function statoSerie(serie) {
  const inItalia = serie.volumiItalia;
  const traguardo = inItalia ?? serie.volumiTotali;

  if (!traguardo) return `ora hai ${contaVolumi(serie.posseduti)}`;
  if (serie.posseduti >= traguardo) return `ora hai ${contaVolumi(serie.posseduti)} — sei in pari`;

  return `ora hai ${contaVolumi(serie.posseduti)} su ${traguardo} ${inItalia ? "usciti" : "in tutto"}`;
}

/**
 * Scrive l'acquisto e racconta cos'è successo.
 *
 * L'avviso sul buco non è un dettaglio estetico: comprare il 45 quando
 * si è fermi al 41 lascia fuori 42-44, e dirlo subito è il modo di non
 * scoprirlo davanti allo scaffale. Dal 02/11/2026 il buco si legge
 * dall'elenco vero dei posseduti, quindi è giusto anche per una serie
 * sparsa: «ti manca ancora 6-10» e non un intervallo indovinato.
 */
async function scrivi({ serie, volumi, prezzo, data, updateId, prezziPronti }) {
  const numeri = volumi ?? [db.primoMancante(serie.numeri)];
  const gruppi = blocchi(numeri);
  const quanti = numeri.length;

  const ripiego = prezzo === null ? await prezzoDiRipiego(serie, numeri, prezziPronti) : null;
  const totale = prezzo ?? ripiego.totale;

  // Se AnimeClick ci ha detto il prezzo di copertina e in tabella non
  // c'era, tanto vale scriverlo: è un dato che serve anche al sito, e
  // ce l'abbiamo già in mano.
  if (ripiego?.unitario > 0 && !(serie.prezzoCopertina > 0)) {
    await db.salvaPrezzoCopertina(serie.id, ripiego.unitario);
  }

  const esito = await db.registra({
    serie,
    gruppi: ripartisci(totale, gruppi),
    data,
    updateId
  });

  const righe = [
    `✅ <b>${esc(serie.titolo)}</b> — vol. ${elencaVolumi(gruppi)}`,
    `${soldi(totale)}${ripiego ? ` (${ripiego.nota})` : ""} · ${statoSerie(esito.serie)}`
  ];

  // Uno zero in mezzo agli acquisti non si nota, e il conto del mese
  // resta sotto senza che si capisca perché. Meglio dirlo subito,
  // finché correggere costa due parole.
  if (totale === 0) {
    righe.push("⚠️ senza prezzo non entra nella spesa del mese: /annulla e riscrivilo col prezzo");
  }

  const primo = Math.min(...numeri);
  const presenti = new Set(esito.serie.numeri);
  const buchi = [];

  for (let n = 1; n < primo; n += 1) if (!presenti.has(n)) buchi.push(n);

  if (buchi.length) {
    const gruppiBuchi = blocchi(buchi);
    const solo = gruppiBuchi.length === 1 && gruppiBuchi[0].da === gruppiBuchi[0].a;

    righe.push(`⚠️ ti manca ancora ${solo ? `il ${buchi[0]}` : elencaVolumi(gruppiBuchi)}`);
  }

  return { testo: righe.join("\n"), spesa: totale };
}

/** Il totale del mese, da mettere in coda alla conferma. */
async function codaDelMese() {
  const oggi = db.oggiInItalia();
  const acquisti = await db.acquistiDelMese(oggi);

  if (acquisti.length === 0) return "";

  const quanti = acquisti.reduce((s, a) => s + a.quanti, 0);
  const spesa = acquisti.reduce((s, a) => s + a.prezzo, 0);
  const mese = MESI[Number(oggi.slice(5, 7)) - 1];

  return `\n\n📅 ${mese}: ${contaVolumi(quanti)} · ${soldi(spesa)}`;
}

// --------------------------------------------------
// UNA RIGA DEL MESSAGGIO
// --------------------------------------------------

/**
 * Prova a registrare una riga. Se non è sicura di aver capito, non
 * scrive niente e restituisce dei bottoni: una serie sbagliata scritta
 * di nascosto costa più fatica di un tocco in più.
 */
async function gestisciRiga({ chatId, riga, serie, updateId }) {
  if (riga.errore) {
    return { testo: `❓ <code>${esc(riga.testo)}</code> — ${riga.errore}` };
  }

  const centesimi = riga.prezzo === null ? "" : Math.round(riga.prezzo * 100);
  const giorno = riga.data ? db.giornoISO(riga.data) : "";

  // Il link della scheda AnimeClick salta tutto: niente ricerca,
  // niente scelta fra i risultati. Serve quando la ricerca del sito
  // non trova la serie perché la elenca con un altro titolo — è
  // successo per Rent a Girlfriend, e succederà ancora.
  const link = riga.titolo.match(/animeclick\.it\/manga\/(\d+)/i) || riga.titolo.match(/^#(\d{2,6})$/);

  if (link) {
    return {
      creaDaAnimeClick: {
        animeClickId: Number(link[1]),
        volumi: riga.volumi,
        prezzo: riga.prezzo,
        giorno
      }
    };
  }

  const trovata = db.cercaFra(serie, riga.titolo, riga.titoloIntero);
  const volumi = trovata.comeTitoloIntero ? null : riga.volumi;

  if (trovata.alternative) {
    const coda = `${codificaVolumi(volumi)}|${centesimi}|${giorno}`;

    return {
      testo: `❓ <b>${esc(riga.titolo)}</b> — quale?`,
      bottoni: [
        ...trovata.alternative.map((s) => [
          {
            text: `${s.titolo} (${s.posseduti} vol.)`,
            callback_data: `s|${s.id}|${coda}`
          }
        ]),
        // La via d'uscita. Senza, una serie che non hai ma che
        // somiglia a tre che hai resta irraggiungibile: il bot
        // chiede "quale?" e nessuna delle risposte è quella giusta.
        [
          {
            text: "➕ Nessuna: cercala su AnimeClick",
            callback_data: accorcia(`c|${coda}|`, riga.titolo)
          }
        ]
      ]
    };
  }

  if (!trovata.certa) {
    return { cercaSuAnimeClick: { titolo: riga.titolo, volumi, centesimi, giorno } };
  }

  return conferma({ chatId, serie: trovata.certa, volumi, prezzo: riga.prezzo, giorno, updateId });
}

/**
 * L'ultimo controllo prima di scrivere: quel volume risulta già tuo?
 *
 * Il contatore basta a sospettarlo (se possiedi 42 volumi, il 30 ce
 * l'hai già), e da quando esiste il bot la tabella degli acquisti sa
 * anche i numeri esatti. In entrambi i casi non decido io: lo dico e
 * lascio il bottone, perché le ristampe e i regali esistono.
 */
async function conferma({ chatId, serie, volumi, prezzo, giorno, updateId, forza = false, prezziPronti }) {
  const numeri = volumi ?? [db.primoMancante(serie.numeri)];

  if (!forza) {
    const registrati = await db.volumiRegistrati(serie.id);
    const doppi = numeri.filter((v) => registrati.has(v) || serie.numeri.includes(v));

    if (doppi.length > 0) {
      const centesimi = prezzo === null || prezzo === undefined ? "" : Math.round(prezzo * 100);

      return {
        testo:
          `🤔 <b>${esc(serie.titolo)}</b> vol. ${elencaVolumi(blocchi(doppi))} ` +
          `risulta${doppi.length > 1 ? "no" : ""} già tuo${doppi.length > 1 ? "i" : ""} ` +
          `(hai ${contaVolumi(serie.posseduti)}).`,
        bottoni: [
          [
            {
              text: "Registralo lo stesso",
              callback_data: `f|${serie.id}|${codificaVolumi(numeri)}|${centesimi}|${giorno || ""}`
            }
          ]
        ]
      };
    }
  }

  const esito = await scrivi({
    serie,
    volumi: numeri,
    prezzo: prezzo === undefined ? null : prezzo,
    data: giorno || null,
    updateId,
    prezziPronti
  });

  return { testo: esito.testo, registrato: true };
}

// --------------------------------------------------
// IL TEMPO (vedi src/tempo.js)
// --------------------------------------------------

const AVVISO_LENTO =
  "⏱️ Ci sta mettendo più del previsto e potrei non farcela. Se fra poco non vedi la conferma, " +
  "guarda con /mese se l'acquisto c'è; se non c'è, rimanda la riga (la scheda, se l'ho già creata, la ritrovo).";

/**
 * Se la scheda non finisce in tempo, il messaggio non resta fermo su «Sto
 * compilando…»: poco prima che Vercel chiuda la funzione dice com'è messa.
 * Se invece finisce, la conferma riscrive lo stesso messaggio e questo avviso
 * sparisce. Va fermato con `clearTimeout` quando il lavoro è finito.
 */
function vigila(chatId, messaggioId) {
  const tra = avvisoTraMs();

  if (tra === null || !messaggioId) return null;

  return setTimeout(() => {
    modifica(chatId, messaggioId, AVVISO_LENTO);
  }, tra);
}

/** Quello che non si è fatto per tempo, da rimandare. */
function messaggioNonFatte(testi) {
  return (
    "⏱️ Ho finito il tempo che ho a disposizione. Non ho fatto:\n" +
    testi.map((t) => `• <code>${esc(t)}</code>`).join("\n") +
    "\n\nRimandamele in un altro messaggio."
  );
}

// --------------------------------------------------
// SERIE NUOVA, DA ANIMECLICK
// --------------------------------------------------

async function proponiDaAnimeClick(chatId, richiesta, messaggioId = null) {
  const attesa = `🔎 <b>${esc(richiesta.titolo)}</b> non è in collezione — cerco su AnimeClick…`;

  // Arrivando da un bottone la domanda è già lì: si riscrive quel
  // messaggio invece di aggiungerne un altro sotto.
  let avviso = { message_id: messaggioId };

  if (messaggioId) await modifica(chatId, messaggioId, attesa);
  else avviso = await invia(chatId, attesa);

  let candidati = [];

  try {
    candidati = await animeclick.cerca(richiesta.titolo);
  } catch (errore) {
    console.error("AnimeClick ricerca:", errore.message);
  }

  const testo = candidati.length
    ? `➕ <b>${esc(richiesta.titolo)}</b> non è in collezione. È una di queste?`
    : `🤷 <b>${esc(richiesta.titolo)}</b> non è in collezione e su AnimeClick non l'ho trovata.\n` +
      `Capita quando la elencano con un altro titolo: mandami il link della sua scheda ` +
      `(anche seguito da volume e prezzo) e la creo lo stesso.`;

  const bottoni = candidati.map((c) => [
    {
      text: `${c.titolo}${c.anno ? ` (${c.anno})` : ""}`,
      callback_data: `n|${c.id}|${codificaVolumi(richiesta.volumi)}|${richiesta.centesimi}|${richiesta.giorno}`
    }
  ]);

  if (avviso) await modifica(chatId, avviso.message_id, testo, { bottoni: bottoni.length ? bottoni : null });
  else await invia(chatId, testo, { bottoni: bottoni.length ? bottoni : null });
}

/**
 * Costruisce la scheda e la mette in collezione.
 *
 * Da AnimeClick viene tutto quello che riguarda l'edizione italiana
 * (trama già tradotta, editore, stato della pubblicazione); da AniList
 * solo copertina e generi, per i motivi scritti in src/anilist.js.
 */
async function creaERegistra({ chatId, animeClickId, volumi, prezzo, giorno, updateId }) {
  // Può già esserci sotto un altro nome — la collezione usa i titoli
  // dell'edizione italiana, AnimeClick a volte un altro. In quel caso
  // non si crea un doppione: si registra sulla scheda che c'è.
  const gia = await db.esisteAnimeClickId(animeClickId);

  if (gia) {
    const esito = await conferma({ chatId, serie: gia, volumi, prezzo, giorno, updateId });
    return esito;
  }

  const scheda = await animeclick.scheda(animeClickId);

  if (!scheda?.titolo) throw new Error("scheda AnimeClick illeggibile");

  // I prezzi servono solo se non li hai battuti tu, e non dipendono da AniList
  // né dalla serie appena creata: partono insieme alla ricerca di copertina e
  // generi invece di aspettarla (fino a 6 secondi risparmiati). Se non
  // arrivano, `null`: `scrivi` non li richiede una seconda volta.
  const prezziPromessi =
    prezzo === null || prezzo === undefined
      ? animeclick.prezziVolumi(animeClickId).catch((errore) => {
          console.error("prezzi AnimeClick:", errore.message);
          return null;
        })
      : null;

  const daAniList = await copertinaEGeneri(
    [scheda.titoloOriginale, scheda.titolo],
    scheda.anno
  );

  const serie = await db.creaSerie({
    titolo: scheda.titolo,
    titoloOriginale: scheda.titoloOriginale,
    autore: scheda.autore,
    disegnatore: scheda.disegnatore,
    // I generi della collezione sono in inglese: mescolarci l'italiano
    // vorrebbe dire una serie che non compare in nessun filtro.
    genere: (daAniList?.generi?.length ? daAniList.generi : scheda.generi).join(", ") || null,
    // La categoria invece è solo di AnimeClick: AniList non dice per
    // quale pubblico un'opera è stata scritta.
    categoria: scheda.categoria,
    trama: scheda.trama,
    cover: daAniList?.cover || scheda.cover,
    editore: scheda.editore,
    volumiTotali: scheda.volumi,
    // Lo stato che conta è quello ITALIANO: è la pubblicazione che
    // segui tu, ed è la condizione che fa entrare la serie nel
    // controllo mensile dei volumi usciti.
    stato: scheda.statoItalia || scheda.statoPatria,
    anno: scheda.anno,
    animeClickId: scheda.id,
    prezzo: prezzo ?? null
  });

  const esito = await conferma({
    chatId,
    serie,
    volumi: volumi ?? [1],
    prezzo,
    giorno,
    updateId,
    forza: true, // appena creata: non può avere doppioni
    prezziPronti: prezziPromessi ? await prezziPromessi : undefined
  });

  return { testo: `🆕 scheda creata da AnimeClick\n${esito.testo}` };
}

// --------------------------------------------------
// COMANDI
// --------------------------------------------------

async function comando(chatId, nome, argomento) {
  if (nome === "start" || nome === "aiuto" || nome === "help") {
    return invia(chatId, AIUTO);
  }

  if (nome === "mese") {
    const oggi = db.oggiInItalia();
    let giorno = oggi;

    // "/mese 7" o "/mese 7/2025": il mese si scrive come si dice.
    const m = argomento.match(/^(\d{1,2})(?:[/-](\d{4}))?$/);
    if (m) {
      if (Number(m[1]) < 1 || Number(m[1]) > 12) {
        return invia(chatId, "🤔 Il mese va da 1 a 12: <code>/mese 7</code> oppure <code>/mese 7/2025</code>.");
      }

      const anno = m[2] || oggi.slice(0, 4);
      giorno = `${anno}-${String(Number(m[1])).padStart(2, "0")}-01`;
    }

    const acquisti = await db.acquistiDelMese(giorno);
    const mese = `${MESI[Number(giorno.slice(5, 7)) - 1]} ${giorno.slice(0, 4)}`;

    if (acquisti.length === 0) {
      return invia(chatId, `📅 <b>${mese}</b>\nNessun acquisto registrato.`);
    }

    const quanti = acquisti.reduce((s, a) => s + a.quanti, 0);
    const spesa = acquisti.reduce((s, a) => s + a.prezzo, 0);

    const righe = acquisti.map(
      (a) =>
        `${a.giorno.slice(8)}/${a.giorno.slice(5, 7)} · ${esc(a.titolo)} ` +
        `${a.da === a.a ? a.da : `${a.da}-${a.a}`} — ${soldi(a.prezzo)}`
    );

    return invia(
      chatId,
      `📅 <b>${mese}</b>\n${contaVolumi(quanti)} · <b>${soldi(spesa)}</b>\n\n${righe.join("\n")}`
    );
  }

  if (nome === "mancanti") {
    const serie = await db.arretrati();

    if (serie.length === 0) {
      return invia(chatId, "🎉 Non ti manca niente: sei in pari con tutte le serie.");
    }

    const righe = serie
      .slice(0, 25)
      .map(
        (s) =>
          // I numeri, non il conto: davanti allo scaffale serve sapere
          // QUALI prendere. Accanto resta su quanti, perché «usciti»
          // e «in tutto» non sono la stessa promessa.
          `• ${esc(s.titolo)} — <b>${elencaVolumi(blocchi(s.mancanti))}</b> ` +
          `(${s.mancanti.length} su ${s.usciti} ${s.inItalia ? "usciti" : "in tutto"})` +
          // Una serie mollata resta in elenco — mancanti vuol dire
          // quali volumi mancano — ma segnata, o davanti allo scaffale
          // ti ritroveresti a comprare il seguito di una che avevi
          // lasciato apposta.
          (s.droppata ? " · <i>droppata</i>" : "")
      );

    const quanti = serie.reduce((s, x) => s + x.mancanti.length, 0);

    return invia(
      chatId,
      `🛒 <b>Ti mancano ${contaVolumi(quanti)}</b> su ${serie.length} serie\n\n${righe.join("\n")}` +
        (serie.length > 25 ? `\n\n…e altre ${serie.length - 25}.` : "")
    );
  }

  if (nome === "annulla") {
    const disfatti = await db.annullaUltimo();

    if (!disfatti) return invia(chatId, "Non c'è niente da annullare.");

    const righe = disfatti.map(
      (d) => `• ${esc(d.titolo)} vol. ${d.da === d.a ? d.da : `${d.da}-${d.a}`} — ${soldi(d.prezzo)}`
    );

    return invia(
      chatId,
      `↩️ Annullato:\n${righe.join("\n")}\n\n<i>La scheda di una serie creata dal bot resta: si toglie dal sito.</i>`
    );
  }

  return invia(chatId, "Non conosco questo comando. /aiuto");
}

// --------------------------------------------------
// SMISTAMENTO
// --------------------------------------------------

async function gestisciMessaggio(chatId, testo, updateId) {
  const letto = interpreta(testo, new Date(`${db.oggiInItalia()}T12:00:00Z`));

  if (letto.comando) return comando(chatId, letto.comando, letto.argomento);
  if (letto.righe.length === 0) return invia(chatId, AIUTO);

  const serie = await db.elenco();
  const conferme = [];
  const daChiedere = [];
  const daCercare = [];
  const daCreare = [];
  const nonFatte = [];

  for (const riga of letto.righe) {
    // Righe che non c'è più il tempo di cominciare: si dicono, non si perdono.
    if (!abbastanza(FRAZIONE.riga)) {
      nonFatte.push(riga.testo);
      continue;
    }

    try {
      const esito = await gestisciRiga({ chatId, riga, serie, updateId });

      if (esito.cercaSuAnimeClick) daCercare.push({ ...esito.cercaSuAnimeClick, testo: riga.testo });
      else if (esito.creaDaAnimeClick) daCreare.push({ ...esito.creaDaAnimeClick, testo: riga.testo });
      else if (esito.bottoni) daChiedere.push(esito);
      else conferme.push(esito.testo);
    } catch (errore) {
      console.error("riga:", riga.testo, errore);
      conferme.push(`⚠️ <code>${esc(riga.testo)}</code> — non sono riuscito a registrarlo`);
    }
  }

  // Prima il riepilogo di quello che è andato a buon fine, poi una
  // domanda alla volta: una tastiera di bottoni sta attaccata a un
  // messaggio solo, e mescolarle renderebbe impossibile capire a quale
  // riga si sta rispondendo.
  if (conferme.length > 0) {
    await invia(chatId, conferme.join("\n\n") + (await codaDelMese()));
  }

  for (const domanda of daChiedere) {
    await invia(chatId, domanda.testo, { bottoni: domanda.bottoni });
  }

  for (const richiesta of daCercare) {
    if (!abbastanza(FRAZIONE.ricerca)) {
      nonFatte.push(richiesta.testo);
      continue;
    }

    await proponiDaAnimeClick(chatId, richiesta);
  }

  for (const richiesta of daCreare) {
    if (!abbastanza(FRAZIONE.creazione)) {
      nonFatte.push(richiesta.testo);
      continue;
    }

    const avviso = await invia(chatId, "📥 Sto compilando la scheda da AnimeClick…");
    const guardia = vigila(chatId, avviso?.message_id);

    try {
      const esito = await creaERegistra({ chatId, ...richiesta, updateId });
      await modifica(chatId, avviso.message_id, esito.testo + (await codaDelMese()), {
        bottoni: esito.bottoni
      });
    } catch (errore) {
      console.error("creazione:", richiesta.animeClickId, errore);
      await modifica(chatId, avviso.message_id, "⚠️ Quella scheda non sono riuscito a leggerla.");
    } finally {
      clearTimeout(guardia);
    }
  }

  if (nonFatte.length > 0) await invia(chatId, messaggioNonFatte(nonFatte));
}

async function gestisciBottone(chatId, richiesta, updateId) {
  const pezzi = String(richiesta.data || "").split("|");
  const [tipo, uno, due, tre, quattro] = pezzi;
  const messaggioId = richiesta.message?.message_id;

  // "nessuna di queste": il titolo scritto se lo porta dietro il
  // bottone, perché la funzione che risponde non ha memoria del
  // messaggio di prima.
  if (tipo === "c") {
    await confermaBottone(richiesta.id);

    return proponiDaAnimeClick(
      chatId,
      {
        titolo: pezzi.slice(4).join("|"),
        volumi: decodificaVolumi(uno),
        centesimi: due,
        giorno: tre
      },
      messaggioId
    );
  }

  const volumi = decodificaVolumi(due);
  const prezzo = tre === "" || tre === undefined ? null : Number(tre) / 100;
  const giorno = quattro || "";

  await confermaBottone(richiesta.id);

  let guardia = null;

  try {
    let esito;

    if (tipo === "n") {
      await modifica(chatId, messaggioId, "📥 Sto compilando la scheda da AnimeClick…");
      guardia = vigila(chatId, messaggioId);

      esito = await creaERegistra({
        chatId,
        animeClickId: Number(uno),
        volumi,
        prezzo,
        giorno,
        updateId
      });
    } else {
      const serie = await db.perId(Number(uno));

      if (!serie) throw new Error(`serie ${uno} sparita`);

      esito = await conferma({
        chatId,
        serie,
        volumi,
        prezzo,
        giorno,
        updateId,
        forza: tipo === "f"
      });
    }

    // Il doppione chiede ancora una conferma: il messaggio cambia
    // testo ma tiene i bottoni, così la risposta resta lì dov'era.
    if (esito.bottoni) {
      return modifica(chatId, messaggioId, esito.testo, { bottoni: esito.bottoni });
    }

    await modifica(chatId, messaggioId, esito.testo + (await codaDelMese()));
  } catch (errore) {
    console.error("bottone:", richiesta.data, errore);
    await modifica(chatId, messaggioId, "⚠️ Non ci sono riuscito. Riprova fra un attimo.");
  } finally {
    clearTimeout(guardia);
  }
}

// --------------------------------------------------
// WEBHOOK
// --------------------------------------------------

async function lavora(req, res) {
  if (req.method !== "POST") return res.status(405).send("solo POST");

  // Il segreto lo manda Telegram in un'intestazione, e l'ha ricevuto
  // da noi quando abbiamo registrato il webhook: senza, chiunque
  // conoscesse l'indirizzo potrebbe scrivere sul database.
  //
  // ⚠️ Il controllo «c'è?» non è ridondante: `undefined !== undefined`
  // è FALSO, quindi senza di lui una variabile d'ambiente dimenticata
  // (un progetto Vercel ricollegato, una pubblicazione di anteprima)
  // lascerebbe passare proprio le richieste senza intestazione. Una
  // dimenticanza deve rendere il bot muto, mai spalancato — la stessa
  // regola di api/uscite.js.
  const atteso = process.env.TELEGRAM_SECRET_TOKEN;
  const chatAmmessa = process.env.TELEGRAM_CHAT_ID;

  if (!atteso || !chatAmmessa) {
    console.error("configurazione incompleta: TELEGRAM_SECRET_TOKEN o TELEGRAM_CHAT_ID mancano");
    return res.status(401).send("no");
  }

  if (req.headers["x-telegram-bot-api-secret-token"] !== atteso) {
    return res.status(401).send("no");
  }

  const aggiornamento = req.body || {};
  const messaggio = aggiornamento.message;
  const bottone = aggiornamento.callback_query;
  const chatId = messaggio?.chat?.id ?? bottone?.message?.chat?.id;

  // Un bot su Telegram lo trova chiunque conosca il nome: la
  // collezione la tocca una persona sola.
  if (chatId == null || String(chatId) !== String(chatAmmessa)) {
    console.warn("chat non autorizzata:", chatId);
    return res.status(200).send("ok");
  }

  try {
    if (!(await db.primaVolta(aggiornamento.update_id))) {
      return res.status(200).send("già visto");
    }

    if (bottone) await gestisciBottone(chatId, bottone, aggiornamento.update_id);
    else if (messaggio?.text) await gestisciMessaggio(chatId, messaggio.text, aggiornamento.update_id);
    else await invia(chatId, "So leggere solo il testo. /aiuto");
  } catch (errore) {
    console.error("errore:", errore);
    await invia(chatId, `⚠️ Qualcosa è andato storto: <code>${esc(errore.message)}</code>`);
  }

  // Sempre 200, anche dopo un errore: un codice diverso fa rimandare
  // l'aggiornamento a Telegram, e ritentare significherebbe rischiare
  // di registrare due volte quello che è già stato scritto.
  return res.status(200).send("ok");
}

/**
 * Ogni aggiornamento ha il suo orologio (src/tempo.js): 48 dei 60 secondi che
 * Vercel concede, gli altri servono a dire com'è andata. `BUDGET_TELEGRAM_MS`
 * esiste per le prove.
 */
export default function handler(req, res) {
  const budget = Number(process.env.BUDGET_TELEGRAM_MS) || BUDGET_PREDEFINITO_MS;

  return conBudget(() => lavora(req, res), budget);
}
