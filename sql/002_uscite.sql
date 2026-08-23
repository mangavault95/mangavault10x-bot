-- ============================================================
-- 002 — IL BOT DELLE USCITE SA CHI GLI PARLA
--
-- COME ESEGUIRLO:
--   Supabase → SQL Editor → New query → incolla tutto → Run
--
-- È SICURO: aggiunge e basta, si può rieseguire senza danni.
--
-- `utenti.telegram_chat_id` NON è qui: esiste già dalla 019 del
-- backend, ed è lì che deve stare — è un attributo della persona, non
-- una cosa del bot. Qui c'è solo quello che serve a ricevere.
-- ============================================================


-- ------------------------------------------------------------
-- GLI AGGIORNAMENTI GIÀ VISTI, DEL SECONDO BOT
--
-- Stessa ragione di `telegram_visti` (sql/001): Telegram rimanda lo
-- stesso aggiornamento finché non riceve un 200, e una funzione lenta
-- a partire basta a farne arrivare due copie. Chi scrive per primo
-- vince, il secondo trova il posto occupato e si ferma.
--
-- ⚠️ PERCHÉ UNA TABELLA A PARTE e non una riga in più in
-- `telegram_visti`: `update_id` è una numerazione DI OGNI BOT, non di
-- Telegram. Due bot diversi possono emettere lo stesso numero, e in
-- una tabella sola il messaggio del secondo bot risulterebbe "già
-- visto" per colpa di un acquisto registrato settimane prima. Una
-- riga persa per una collisione che non si vedrebbe nei log è il
-- genere di guasto che non si trova più.
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS telegram_visti_uscite (
  update_id  BIGINT PRIMARY KEY,
  visto_il   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE telegram_visti_uscite IS
  'Gli aggiornamenti già gestiti di @Videoteca10xBot. Separata da telegram_visti perché update_id è una numerazione per bot: due bot possono emettere lo stesso numero.';
