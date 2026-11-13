// AniList — serve per due campi soli: la copertina e i generi.
//
// Tutto il resto di una scheda nuova viene da AnimeClick, che è la
// fonte italiana. Ma su questi due AniList vince, e non per gusto:
//
//   - la copertina di AnimeClick è una miniatura da 225x307, e sullo
//     scaffale 3D del sito i volumi si guardano da vicino;
//   - i generi in collezione sono scritti in inglese ("Comedy, Drama,
//     Romance"), perché è così che li ha sempre scritti AniList.
//     Scriverne uno in italiano non è più preciso: è una serie che
//     sparisce da tutti i filtri e da tutte le classifiche.
//
// Se AniList non trova niente — capita per le raccolte e le edizioni
// solo italiane — si tiene quello che dà AnimeClick e amen.

const ENDPOINT = "https://graphql.anilist.co";

const QUERY = `
  query ($search: String) {
    Page(perPage: 8) {
      media(search: $search, type: MANGA) {
        title { romaji english native }
        startDate { year }
        genres
        coverImage { extraLarge large }
      }
    }
  }
`;

function normalizza(testo) {
  return String(testo || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * La copertina grande e i generi di una serie, cercata per titolo.
 *
 * L'anno è il controllo che tiene lontani gli omonimi: su AniList
 * "Berserk" sono almeno tre opere diverse (la serie, un one-shot, uno
 * spin-off), e sbagliare significa mettere in collezione la copertina
 * di un altro fumetto. Con un anno che non combacia si preferisce non
 * rispondere: meglio la miniatura di AnimeClick che la scheda giusta
 * con la faccia sbagliata.
 */
export async function copertinaEGeneri(titoli, anno) {
  const candidati = [...new Set(titoli.filter(Boolean))];

  for (const titolo of candidati) {
    try {
      const risposta = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: QUERY, variables: { search: titolo } }),
        signal: AbortSignal.timeout(6000)
      });

      if (!risposta.ok) continue;

      const json = await risposta.json();
      const opere = json?.data?.Page?.media || [];
      const cercato = normalizza(titolo);

      const scelta = opere.find((m) => {
        const nomi = [m?.title?.romaji, m?.title?.english, m?.title?.native].map(normalizza);
        const stessoTitolo = nomi.some((n) => n === cercato);
        const suoAnno = m?.startDate?.year;

        // Senza anno da confrontare mi fido del titolo esatto; con
        // l'anno pretendo che combaci a meno di uno (le fonti non
        // concordano su cosa sia l'inizio: rivista o primo volume).
        return stessoTitolo && (!anno || !suoAnno || Math.abs(suoAnno - anno) <= 1);
      });

      if (!scelta) continue;

      return {
        cover: scelta?.coverImage?.extraLarge || scelta?.coverImage?.large || null,
        generi: scelta?.genres || []
      };
    } catch {
      // AniList giù o lenta: non è un errore che valga la pena
      // raccontare a chi sta comprando un fumetto.
    }
  }

  return null;
}
