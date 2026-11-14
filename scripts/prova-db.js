// Prove che girano su un Postgres vero (PROVA_DATABASE_URL), in uno schema
// loro creato e buttato via. Senza la variabile saltano, e il resto di
// `npm test` gira lo stesso.
//
//   PROVA_DATABASE_URL=postgres://… node scripts/prova-db.js
//
// Cosa controllano, perché sono le cose che sbagliare costa dati:
//   - /annulla non toglie i volumi che c'erano già;
//   - lo stesso messaggio di Telegram non si registra due volte;
//   - /mancanti dice QUALI numeri mancano;
//   - due serie create insieme non prendono lo stesso ID.
//
// Lo schema è una copia ridotta di quello vero: il trigger che in produzione
// tiene in ordine i numeri (sql/022 del backend) qui è riscritto in tre
// righe. Se la 022 cambia comportamento, questa prova non lo sa.

import pg from "pg";
import { usaConnessione, registra, annullaUltimo, primaVolta, arretrati, creaSerie, perId } from "../src/collezione.js";

const url = process.env.PROVA_DATABASE_URL;

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

if (!url) {
  console.log("\n(PROVA_DATABASE_URL non c'è: salto le prove sul database.)\n");
} else {
  const schema = `prova_bot_${Math.random().toString(36).slice(2, 10)}`;
  const locale = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const ssl = locale ? false : { rejectUnauthorized: false };

  const admin = new pg.Pool({ connectionString: url, ssl, max: 1 });

  await admin.query(`CREATE SCHEMA ${schema}`);

  const pool = new pg.Pool({ connectionString: url, ssl, max: 8, options: `-c search_path=${schema}` });

  usaConnessione(pool);

  try {
    await pool.query(`
      CREATE TABLE "Manga" (
        "ID" int PRIMARY KEY, "Titolo" text, "TitoloOriginale" text, "Autore" text, "Disegnatore" text,
        "Genere" text, "Categoria" text, "Trama" text, "CoverURL" text, "Editore" text,
        "VolumiTotali" int, "VolumiPosseduti" int NOT NULL DEFAULT 0, "NumeriPosseduti" int[] NOT NULL DEFAULT '{}',
        "VolumiItalia" int, "Costo" numeric, "PrezzoCopertina" numeric, "StatoSerie" text, "Edizione" text,
        "AnimeClickID" int, "AnnoInizio" int, "DataAggiunta" date, "SmessaIl" timestamptz);

      -- Come la 022 del backend: numeri in ordine, senza doppioni, e il conteggio che ne deriva.
      CREATE FUNCTION riordina() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        NEW."NumeriPosseduti" := ARRAY(SELECT DISTINCT n FROM unnest(NEW."NumeriPosseduti") AS n ORDER BY n);
        NEW."VolumiPosseduti" := cardinality(NEW."NumeriPosseduti");
        RETURN NEW;
      END $$;
      CREATE TRIGGER riordina BEFORE INSERT OR UPDATE ON "Manga" FOR EACH ROW EXECUTE FUNCTION riordina();

      CREATE TABLE acquisti (
        id bigserial PRIMARY KEY, manga_id int REFERENCES "Manga"("ID") ON DELETE CASCADE,
        volume_da int, volume_a int, prezzo numeric, data_acquisto date, condizione text, negozio text,
        telegram_update_id bigint, gia_posseduti int[]);
      CREATE TABLE telegram_visti (update_id bigint PRIMARY KEY, visto_il timestamptz NOT NULL DEFAULT now());
      CREATE TABLE utenti (id bigint PRIMARY KEY, proprietario boolean NOT NULL DEFAULT false);
      CREATE TABLE letture_droppate (manga_id int, utente_id bigint);
      INSERT INTO utenti VALUES (1, true);`);

    const numeri = async (id) => (await pool.query(`SELECT "NumeriPosseduti" AS n FROM "Manga" WHERE "ID" = $1`, [id])).rows[0].n;

    console.log("\n/annulla");
    {
      await pool.query(`INSERT INTO "Manga" ("ID", "Titolo", "NumeriPosseduti", "PrezzoCopertina") VALUES (1, 'Berserk', '{1,2,3}', 7.5)`);

      const serie = await perId(1);

      // «Registralo lo stesso»: il 3 c'era già.
      await registra({ serie, gruppi: [{ da: 3, a: 3, prezzo: 7.5 }], data: null, updateId: 900 });
      prova("un doppione forzato del 3", [1, 2, 3], await numeri(1));

      await annullaUltimo();
      prova("/annulla: il 3 resta, c'era già", [1, 2, 3], await numeri(1));

      await registra({ serie, gruppi: [{ da: 3, a: 4, prezzo: 15 }, { da: 9, a: 9, prezzo: 7.5 }], data: null, updateId: 901 });
      prova("compro 3-4 e 9 (il 3 c'era già)", [1, 2, 3, 4, 9], await numeri(1));

      await annullaUltimo();
      prova("/annulla: escono 4 e 9, il 3 resta", [1, 2, 3], await numeri(1));

      prova("e non resta nessuna riga di acquisto", 0, (await pool.query("SELECT count(*)::int AS n FROM acquisti")).rows[0].n);
    }

    console.log("\nLo stesso messaggio due volte");
    {
      prova("la prima volta si lavora", true, await primaVolta(5001));
      prova("la seconda (Telegram che rimanda) no", false, await primaVolta(5001));
      prova("un altro messaggio sì", true, await primaVolta(5002));
    }

    console.log("\n/mancanti");
    {
      await pool.query(`INSERT INTO "Manga" ("ID", "Titolo", "NumeriPosseduti", "VolumiItalia", "VolumiTotali") VALUES
        (10, 'Sparsa', '{1,2,3,4,5,11}', 13, 20),
        (11, 'In pari', '{1,2,3}', 3, 3),
        (12, 'Con anteprima', '{1,2,5}', 4, NULL),
        (13, 'Smessa', '{1}', 9, 9),
        (14, 'Solo totale', '{}', NULL, 2)`);
      await pool.query(`UPDATE "Manga" SET "SmessaIl" = now() WHERE "ID" = 13`);

      const a = (await arretrati()).filter((s) => s.titolo !== "Berserk");

      prova(
        "dice QUALI mancano; una smessa e una in pari non compaiono",
        [
          ["Con anteprima", [3, 4]],
          ["Solo totale", [1, 2]],
          ["Sparsa", [6, 7, 8, 9, 10, 12, 13]]
        ],
        a.map((s) => [s.titolo, s.mancanti])
      );
    }

    console.log("\nCreare serie insieme");
    {
      const nuova = (i) =>
        creaSerie({
          titolo: `Nuova ${i}`, titoloOriginale: null, autore: "A", disegnatore: "D", genere: "Azione", categoria: "seinen",
          trama: "t", cover: null, editore: "E", volumiTotali: 3, stato: "in_corso", anno: 2020, animeClickId: 1000 + i, prezzo: 5
        });

      const create = await Promise.allSettled([1, 2, 3, 4, 5, 6].map(nuova));
      const ok = create.filter((r) => r.status === "fulfilled").map((r) => r.value.id);

      prova("sei creazioni insieme: sei ID diversi e nessun errore", [6, 6], [new Set(ok).size, ok.length]);
    }
  } finally {
    await pool.end().catch(() => {});
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await admin.end().catch(() => {});
  }
}

console.log(falliti ? `\n${falliti} prove fallite.\n` : "\nTutto a posto.\n");
process.exitCode = falliti ? 1 : 0;
