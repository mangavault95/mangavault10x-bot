// Lo schema di prova: una copia ridotta del database vero, in uno schema Postgres
// creato per l'occasione e buttato via alla fine. Lo usano le prove che parlano con
// un Postgres (PROVA_DATABASE_URL): `prova-db.js` e `prova-flusso.js`.
//
// Il trigger che in produzione tiene in ordine i numeri (sql/022 del backend) qui è
// riscritto in tre righe. Se la 022 cambia comportamento, le prove non lo sanno.

import pg from "pg";

const SQL = `
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
      INSERT INTO utenti VALUES (1, true);
`;

/** Crea lo schema e restituisce un pool che ci guarda dentro, più `chiudi()` che lo butta via. */
export async function creaSchemaProva(url) {
  const schema = `prova_bot_${Math.random().toString(36).slice(2, 10)}`;
  const locale = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const ssl = locale ? false : { rejectUnauthorized: false };

  const admin = new pg.Pool({ connectionString: url, ssl, max: 1 });

  await admin.query(`CREATE SCHEMA ${schema}`);

  const pool = new pg.Pool({ connectionString: url, ssl, max: 8, options: `-c search_path=${schema}` });

  await pool.query(SQL);

  return {
    pool,
    async chiudi() {
      await pool.end().catch(() => {});
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
      await admin.end().catch(() => {});
    }
  };
}
