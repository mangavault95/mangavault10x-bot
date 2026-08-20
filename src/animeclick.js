// AnimeClick — la fonte italiana: ricerca per titolo e lettura della scheda.
//
// Serve per una cosa sola: quando compri il primo volume di una serie
// che non hai in collezione, il bot deve poterla creare senza farti
// scrivere niente. AnimeClick è l'unico posto dove trama, editore e
// stato di pubblicazione sono già quelli dell'edizione ITALIANA.
//
// Il backend legge un'altra pagina dello stesso sito (/edizioni, per
// il controllo mensile dei volumi usciti). Sono due parser diversi su
// due pagine diverse, ognuno in un posto solo: qui la scheda, là le
// edizioni.
//
// Sulla ricerca: la pagina /ricerca/manga non risponde a una GET con
// parametri, e nemmeno a una POST normale — restituisce sempre il
// modulo vuoto. Risponde solo alla POST che fa il loro JavaScript,
// cioè con l'intestazione `X-Requested-With: XMLHttpRequest`: allora
// torna un JSON con dentro il frammento di HTML dei risultati. Il
// token CSRF va preso dal modulo e rimandato insieme al cookie di
// sessione, quindi ogni ricerca costa due richieste.
//
// robots.txt vieta solo /app.php/, non queste pagine, e qui si parla
// di una manciata di richieste al mese: il traffico di una persona
// che sfoglia il sito.

const BASE = "https://www.animeclick.it";

// Un'intestazione che dice chi siamo: se dà fastidio, chi gestisce il
// sito sa chi bloccare senza dover indovinare. Uguale a quella del
// backend, di proposito.
const USER_AGENT =
  "MangaVault/1.0 (collezione personale; +https://mangavault10x-frontend.vercel.app)";

const INTESTAZIONI = {
  "User-Agent": USER_AGENT,
  "Accept-Language": "it-IT,it;q=0.9"
};

const ATTESA = 20000;

// --------------------------------------------------
// Utilità di lettura dell'HTML
// --------------------------------------------------

const ENTITA = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&quot;": '"',
  "&#039;": "'",
  "&apos;": "'",
  "&agrave;": "à",
  "&egrave;": "è",
  "&eacute;": "é",
  "&igrave;": "ì",
  "&ograve;": "ò",
  "&ugrave;": "ù",
  "&lt;": "<",
  "&gt;": ">",
  "&euro;": "€"
};

function decodifica(testo) {
  return String(testo || "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&[a-z#0-9]+;/gi, (e) => ENTITA[e.toLowerCase()] ?? " ");
}

/** Il testo di un pezzo di HTML, senza tag e senza spazi doppi. */
function testoDi(html) {
  return decodifica(String(html || "").replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/** I testi dei singoli <a>: i generi sono una lista di link, non una frase. */
function linkDi(html) {
  return [...String(html || "").matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)]
    .map((m) => testoDi(m[1]))
    .filter(Boolean);
}

async function prendi(url, opzioni = {}) {
  const risposta = await fetch(url, {
    ...opzioni,
    headers: { ...INTESTAZIONI, ...(opzioni.headers || {}) },
    signal: AbortSignal.timeout(ATTESA)
  });

  if (!risposta.ok) throw new Error(`AnimeClick HTTP ${risposta.status} su ${url}`);

  return risposta;
}

// --------------------------------------------------
// RICERCA
// --------------------------------------------------

/** I risultati arrivano già ordinati per pertinenza? No: li riordino io. */
function normalizza(testo) {
  return String(testo || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function somiglianza(cercato, trovato) {
  const a = normalizza(cercato);
  const b = normalizza(trovato);

  if (!a || !b) return 0;
  if (a === b) return 100;
  if (b.startsWith(a)) return 80 - (b.length - a.length) * 0.2;
  if (b.includes(a)) return 60 - (b.length - a.length) * 0.2;

  // Nessuna delle due contiene l'altra: conto le parole in comune,
  // così "witch hat atelier" trova "Atelier of Witch Hat".
  const parole = new Set(b.split(" "));
  const comuni = a.split(" ").filter((p) => parole.has(p)).length;

  return comuni === 0 ? 0 : 30 * (comuni / a.split(" ").length);
}

function leggiSchede(frammento) {
  // Ogni risultato è un blocco .thumbnail: taglio lì invece di
  // affidarmi all'annidamento dei div, che con una regex non si
  // conta.
  const blocchi = String(frammento).split(/<div class="thumbnail/).slice(1);
  const trovati = [];

  for (const blocco of blocchi) {
    const link = blocco.match(/href="\/manga\/(\d+)\/([a-z0-9-]*)"/i);
    if (!link) continue;

    const didascalia = blocco.match(/<div class="caption[\s\S]*?<h5>([\s\S]*?)<\/h5>/i);
    const titolo = didascalia ? testoDi(didascalia[1]) : null;
    if (!titolo) continue;

    const anno = blocco.match(/<div class="pull-right">\s*(\d{4})\s*<\/div>/);

    trovati.push({
      id: Number(link[1]),
      titolo,
      anno: anno ? Number(anno[1]) : null,
      url: `${BASE}/manga/${link[1]}/${link[2] || "-"}`
    });
  }

  return trovati;
}

/**
 * Le serie che somigliano a un titolo, dalla più probabile in giù.
 *
 * Non decide niente: chi chiama mostra i primi risultati e lascia
 * scegliere. Agganciare l'opera sbagliata è il modo più veloce per
 * riempire la collezione di schede sbagliate, e su AnimeClick gli
 * omonimi sono la norma (di "Pokémon" ce ne sono decine).
 */
export async function cerca(titolo, { quanti = 3 } = {}) {
  const modulo = await prendi(`${BASE}/ricerca/manga`);
  const cookie = (modulo.headers.get("set-cookie") || "").split(",")
    .map((c) => c.split(";")[0].trim())
    .filter(Boolean)
    .join("; ");

  const html = await modulo.text();
  const token = html.match(/name="search_manga\[_token\]"[^>]*value="([^"]+)"/);

  if (!token) throw new Error("AnimeClick: token della ricerca non trovato");

  // I campi vuoti del modulo vanno mandati lo stesso, con il valore
  // che avrebbero se nessuno li toccasse. Non è pignoleria: senza
  // `anno=-1` (che vuol dire "qualunque anno") la ricerca risponde
  // "Ci sono 0 titoli in database" anche a "one piece", e sembra che
  // il sito non conosca One Piece.
  const corpo = new URLSearchParams({
    "search_manga[title]": titolo,
    "search_manga[titleOption]": "0", // 0 = contiene
    "search_manga[anno]": "-1",
    "search_manga[ordinamento]": "titolo",
    "search_manga[versoOrdinamento]": "1",
    "search_manga[_token]": token[1]
  });

  const risposta = await prendi(`${BASE}/ricerca/manga`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Requested-With": "XMLHttpRequest",
      Cookie: cookie
    },
    body: corpo.toString()
  });

  const json = await risposta.json();
  const frammento = json?.data?.html;

  if (!frammento) return [];

  const trovate = leggiSchede(frammento).map((s) => ({
    ...s,
    punteggio: somiglianza(titolo, s.titolo)
  }));

  const pertinenti = trovate.filter((s) => s.punteggio > 0);

  // Se nessuna somiglia abbastanza da farsi un punteggio, restituisco
  // comunque le prime che ha proposto AnimeClick: quando la sua
  // ricerca ripiega sui suggerimenti ("forse cercavi...") i titoli
  // possono essere lontani da quello scritto, ma sono l'unica pista
  // che c'è — e a scegliere è comunque una persona, con un bottone.
  const ordinate = pertinenti.length ? pertinenti.sort((a, b) => b.punteggio - a.punteggio) : trovate;

  return ordinate.slice(0, quanti);
}

// --------------------------------------------------
// PREZZI DEI VOLUMI
// --------------------------------------------------

// Le edizioni speciali costano tre volte tanto: la Variant di Blue
// Lock 34 sta a 19,90 € contro i 7,90 € del volume normale, e presa
// per buona falserebbe la spesa del mese.
//
// ⚠️ Queste due espressioni hanno una gemella in
// `mangavault10x-backend/services/providers/animeclick.js`, che legge
// la stessa tabella per un'altra domanda (fin dove è arrivata la
// serie in Italia). Se un giorno una va corretta, vanno corrette
// tutte e due.
const RISTAMPA = /ristampa/i;

const MARCHI_EDIZIONE =
  /\b(variant|discovery|deluxe|instant|perfect|ultimate|complete|gold|silver|omnibus|box\s*set|cofanetto|anniversary|kanzenban|bunko|new\s+edition|reloaded|collection|gazzetta|pack)\b/i;

/**
 * Solo l'identificativo conta, lo slug è decorativo — ma il segmento
 * in mezzo ci vuole: `/manga/9553/edizioni` legge "edizioni" come
 * slug e restituisce un'altra pagina.
 */
function urlEdizioni(animeClickId) {
  return `${BASE}/manga/${animeClickId}/-/edizioni`;
}

function leggiRigaEdizione(trHtml) {
  const celle = (trHtml.match(/<td[\s\S]*?<\/td>/gi) || []).map(testoDi);

  if (!celle.length) return null;

  // Le celle si riconoscono dalla forma e non dalla posizione: se un
  // giorno aggiungono una colonna, un parser che conta gli indici si
  // rompe in silenzio, questo no.
  const prezzo = celle.find((c) => /^\d{1,4}[,.]\d{2}\s*€$/.test(c));
  const data = celle.find((c) => /^\d{2}\/\d{2}\/\d{4}$/.test(c));
  const titolo = celle.find((c) => /\D\s*\d{1,3}$/.test(c) && !/^[\d.,\s€]+$/.test(c));

  if (!prezzo || !titolo) return null;

  const numero = Number(titolo.match(/(\d{1,3})\s*$/)?.[1]);

  if (!numero) return null;

  return {
    numero,
    prezzo: Number(prezzo.replace(/[^\d,.]/g, "").replace(",", ".")),
    data: data || null,
    // "27/11/2025" e "26/03/2026" confrontate come stringhe darebbero
    // la prima per più recente: si confronta il giorno prima
    // dell'anno. Girata al contrario invece si ordina da sé.
    quando: data ? data.split("/").reverse().join("-") : "",
    // Il nome dell'edizione è il titolo senza il numero in fondo.
    edizione: titolo.replace(/\s*\d{1,3}\s*$/, "").trim(),
    riga: celle.join(" ")
  };
}

/**
 * Quanto costa ogni volume di una serie, secondo il suo editore.
 *
 * Le ristampe NON si scartano, al contrario di quando si conta fin
 * dove è arrivata la serie: qui la domanda è "quanto lo paghi oggi",
 * e la ristampa del 2020 (4,90 €) è una risposta più onesta della
 * prima edizione del 1996 (1,81 €). Per ogni volume vince quindi la
 * riga con la data più recente.
 */
export async function prezziVolumi(animeClickId, { edizione = null } = {}) {
  const risposta = await prendi(urlEdizioni(animeClickId));
  const html = await risposta.text();
  const tbody = (html.match(/<tbody[\s\S]*?<\/tbody>/i) || [])[0];

  const prezzi = new Map();

  if (!tbody) return prezzi;

  const etichetta = edizione ? String(edizione).trim().toLowerCase() : null;

  for (const tr of tbody.match(/<tr[\s\S]*?<\/tr>/gi) || []) {
    const r = leggiRigaEdizione(tr);

    if (!r) continue;

    const nome = r.edizione.replace(RISTAMPA, "").trim();

    // Con un'etichetta in tabella tengo solo chi la nomina; senza, la
    // serie è l'edizione normale e chi nomina un'edizione speciale va
    // scartato.
    const suaEdizione = etichetta
      ? nome.toLowerCase().includes(etichetta)
      : !MARCHI_EDIZIONE.test(nome);

    if (!suaEdizione) continue;

    const precedente = prezzi.get(r.numero);

    if (!precedente || r.quando > precedente.quando) {
      prezzi.set(r.numero, r);
    }
  }

  return prezzi;
}

// --------------------------------------------------
// SCHEDA
// --------------------------------------------------

// Come si chiama su AnimeClick → come si chiama in tabella.
// "completato" è la parola che usano loro per una serie finita: senza
// di essa lo stato resta vuoto, e una scheda senza stato non entra
// nel controllo mensile né nei filtri del sito.
const STATO = [
  [/in corso/i, "in_corso"],
  [/(complet|conclus|finit)/i, "conclusa"],
  [/(inedit|annunciat|non pubblicat)/i, "inedita"],
  [/(sospes|interrott|annullat|cancellat)/i, "interrotta"]
];

function statoSerie(testo) {
  const trovato = STATO.find(([forma]) => forma.test(String(testo || "")));
  return trovato ? trovato[1] : null;
}

// Il pubblico dell'opera, com'è scritto da loro → il codice che va in
// tabella (vedi il vincolo `categoria_nota` in sql/010_kachinuki.sql
// del backend). La riga "Categoria" può elencarne due — "Seinen" e
// "Pubblico Adulto" — e la seconda non è un pubblico diverso ma un
// avvertimento sui contenuti: vale solo quando è l'unica cosa scritta.
const CATEGORIE = [
  [/kodomo/i, "kodomo"],
  [/sh(o|ō|ou)nen/i, "shonen"],
  [/sh(o|ō|ou)(jo|ujo)/i, "shojo"],
  [/seinen/i, "seinen"],
  [/josei/i, "josei"]
];

function categoriaDa(voci) {
  for (const voce of voci) {
    const trovata = CATEGORIE.find(([forma]) => forma.test(voce));
    if (trovata) return trovata[1];
  }

  return voci.some((v) => /pubblico\s+adulto/i.test(v)) ? "adulto" : null;
}

/**
 * L'editore italiano sta nella riga "Disponibilità", insieme al
 * pulsante del negozio partner: tengo solo il primo link, che è la
 * casa editrice, e butto il resto.
 */
function editore(ddHtml) {
  const nomi = linkDi(ddHtml).filter((n) => !/mangayo|compralo/i.test(n));
  return nomi[0] || null;
}

/**
 * Legge la scheda di una serie: tutto quello che serve per creare una
 * riga in collezione, già in italiano.
 *
 * La pagina è un <dl> di coppie etichetta/valore, e le etichette che
 * si ripetono (Storia e Disegni compaiono una volta per autore)
 * vanno raccolte tutte: Berserk ha due sceneggiatori dopo la morte di
 * Miura, e tenerne uno solo lo direbbe scritto da una persona sola.
 */
export async function scheda(animeClickId) {
  const risposta = await prendi(`${BASE}/manga/${animeClickId}/-/`, { redirect: "follow" });
  const html = await risposta.text();

  // La classe si cerca per pezzo e non per intero: quel <dl> si
  // chiamava `class="dl-horizontal"` e oggi si chiama
  // `class="ac-dl-horizontal"`. Cercarlo alla lettera lo faceva
  // sparire in silenzio — la scheda arrivava, la tabella risultava
  // vuota, e "senza autore, senza editore, senza trama" sembrava un
  // fatto invece che un parser rotto.
  //
  // ⚠️ Gemella di `tabellaScheda` nel backend: se una va corretta,
  // vanno corrette tutte e due.
  const inizio = html.search(/<dl[^>]*dl-horizontal[^>]*>/i);
  const fine = inizio < 0 ? -1 : html.indexOf("</dl>", inizio);
  const dl = inizio < 0 ? "" : html.slice(inizio, fine < 0 ? undefined : fine);

  const campi = new Map();

  for (const [, dt, dd] of dl.matchAll(/<dt>([\s\S]*?)<\/dt>\s*<dd>([\s\S]*?)<\/dd>/g)) {
    const chiave = testoDi(dt).replace(/:$/, "");
    if (!campi.has(chiave)) campi.set(chiave, []);
    campi.get(chiave).push(dd);
  }

  const valore = (chiave) => (campi.get(chiave) || []).map(testoDi).join(", ") || null;
  const persone = (chiave) => {
    const nomi = (campi.get(chiave) || []).flatMap(linkDi);
    return [...new Set(nomi)].join(", ") || null;
  };

  const titolo = decodifica(
    (html.match(/<meta property="og:title" content="([^"]*)"/) || [])[1] || ""
  ).trim();

  const cover = (html.match(/<meta property="og:image" content="([^"]*)"/) || [])[1] || null;

  // La trama è l'unico blocco marcato come descrizione: niente
  // euristiche sul testo. Le "Note:" in coda sono redazionali
  // (chi disegna la serie adesso, ecc.) e non fanno parte della trama.
  const div = html.match(/<div id="trama-div"[^>]*>([\s\S]*?)<\/div>/i);
  const trama = div
    ? testoDi(div[1]).replace(/^Trama:\s*/i, "").split(/\s*Note:\s*/)[0].trim()
    : null;

  const generi = (campi.get("Genere") || []).flatMap(linkDi);
  const volumi = Number(valore("Volumi"));

  // Il pubblico a cui l'opera è stata scritta ("Categoria" sulla
  // scheda): shonen, seinen, shojo... AniList non ce l'ha in nessuna
  // forma — i suoi generi dicono di cosa parla, mai per chi è — quindi
  // questa è l'unica fonte che ce l'ha già in italiano.
  const categoria = categoriaDa((campi.get("Categoria") || []).flatMap(linkDi));

  // L'anno può essere un intervallo ("2020 - 2024"): quello che
  // interessa è il primo, cioè quando la serie è cominciata.
  const anno = Number((valore("Anno") || "").match(/\d{4}/)?.[0]);

  return {
    id: Number(animeClickId),
    titolo: titolo || null,
    titoloOriginale: valore("Titolo originale"),
    autore: persone("Storia"),
    disegnatore: persone("Disegni"),
    generi: [...new Set(generi)],
    categoria,
    anno: Number.isFinite(anno) ? anno : null,
    // Il numero di volumi qui è quello GIAPPONESE, come su AniList:
    // quanti ne siano usciti in Italia lo dice la pagina /edizioni,
    // che è il mestiere del controllo mensile del backend.
    volumi: Number.isFinite(volumi) && volumi > 0 ? volumi : null,
    statoItalia: statoSerie(valore("Stato in Italia")),
    statoPatria: statoSerie(valore("Stato in patria")),
    editore: editore((campi.get("Disponibilità") || [])[0]),
    trama: trama || null,
    cover,
    url: `${BASE}/manga/${animeClickId}/-/`
  };
}
