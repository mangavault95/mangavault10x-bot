-- ============================================================
-- MangaVault bot — quello che serve al database.
--
-- COME ESEGUIRLO:
--   Supabase → SQL Editor → New query → incolla tutto → Run
--
-- È SICURO: aggiunge e basta. Nessuna tabella viene toccata nei
-- dati, si può rieseguire più volte senza danni.
--
-- La tabella degli acquisti NON è qui: esiste già da
-- mangavault10x-backend/sql/001_fondamenta.sql, con le colonne
-- giuste (volume_da, volume_a, prezzo, data_acquisto, negozio,
-- condizione). Finora non l'aveva mai scritta nessuno.
-- ============================================================


-- ------------------------------------------------------------
-- 1. GLI AGGIORNAMENTI GIÀ VISTI
--
-- Telegram rimanda lo stesso messaggio finché non riceve un 200, e
-- una funzione lenta a partire basta a farne arrivare due copie.
-- Senza questa tabella lo stesso volume verrebbe registrato due
-- volte, e la spesa del mese direbbe il doppio del vero.
--
-- La chiave primaria è l'unico meccanismo che serve: chi scrive per
-- primo vince, il secondo trova il posto occupato e si ferma.
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS telegram_visti (
  update_id  BIGINT PRIMARY KEY,
  visto_il   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ------------------------------------------------------------
-- 2. DA QUALE MESSAGGIO VIENE UN ACQUISTO
--
-- Serve a /annulla. Quello che si vuole disfare non è mai l'ultima
-- riga scritta: è l'ultimo messaggio mandato, che di righe può
-- averne tre. Segnarsi il messaggio è l'unico modo di rimetterle
-- insieme dopo.
-- ------------------------------------------------------------

ALTER TABLE acquisti ADD COLUMN IF NOT EXISTS telegram_update_id BIGINT;

CREATE INDEX IF NOT EXISTS idx_acquisti_telegram
  ON acquisti (telegram_update_id DESC)
  WHERE telegram_update_id IS NOT NULL;

COMMENT ON COLUMN acquisti.telegram_update_id IS
  'Il messaggio Telegram che ha registrato questo acquisto. Vuoto = inserito da altrove.';
