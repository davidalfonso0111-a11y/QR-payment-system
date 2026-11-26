# QR-payment-system (SIPS)

Gasten scannen een QR-code op tafel, bestellen van het menu en betalen **online (Mollie)** of **cash aan de kassa**. Het personeel volgt alles op `staff.html`.

- **Hosting:** Vercel (statische pagina's + API-routes in `api/`)
- **Database & login:** Supabase (PostgreSQL, Auth)
- **Betalingen:** Mollie

## Onderdelen

| Bestand | Wat |
|---|---|
| `index.html` + `js/live-guest.js` | Gastpagina: menu, winkelmand, cash of online betalen, status volgen |
| `js/guest-api.js` | Cashbestellingen (Supabase) en online bestellingen (`/api/create-payment`) |
| `js/guest-status.js` | Privé bestelstatus volgen met het geheim op het apparaat van de gast |
| `staff.html` | Personeel: accepteren, bereiden, cash registreren, weigeren/annuleren, terugbetalen, uitverkocht |
| `api/create-payment.js` | Maakt online bestelling + Mollie-betaling (hergebruikt een open betaling bij een nieuwe poging) |
| `api/mollie-webhook.js` | Mollie meldt een statuswijziging; de server haalt de betaling zelf opnieuw op |
| `api/staff-refund.js` | Online terugbetalen (alleen eigenaar/manager) |
| `api/_lib.js` | Gedeelde serverhulp (geen eigen route) |
| `database/001`–`007` | Migraties, in volgorde uitvoeren |

## Installatie

### 1. Supabase

1. Voer in de **SQL Editor** de bestanden `database/001_…sql` t/m `database/007_…sql` uit, één voor één en in volgorde. Heb je 001–006 al gedraaid, dan alleen `007`.
2. Maak in **Authentication** een account aan voor elke medewerker.
3. Koppel elk account aan de zaak (als administrator in de SQL Editor):

   ```sql
   INSERT INTO public.staff_memberships (restaurant_id, user_id, role, active)
   VALUES ('<restaurant-id>', '<auth-user-uuid>', 'owner', true);  -- of 'manager' / 'staff'
   ```

   Alleen `owner` en `manager` mogen terugbetalen.

### 2. Vercel: Environment Variables

| Naam | Waarde |
|---|---|
| `SUPABASE_URL` | `https://<project>.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase **secret** key (`sb_secret_…`) of de oude `service_role`-JWT. **Nooit in de browser.** |
| `SUPABASE_PUBLISHABLE_KEY` | Supabase publishable key (`sb_publishable_…`) |
| `MOLLIE_API_KEY` | `test_…` om te testen, `live_…` voor echt geld |
| `PUBLIC_SITE_URL` | Het adres van de site, bijv. `https://sips.vercel.app` (zonder `/` aan het eind) |

Na het wijzigen van variabelen opnieuw deployen.

### 3. Mollie

- De webhook (`/api/mollie-webhook`) moet publiek bereikbaar zijn. Op `localhost` werkt hij niet; test op een Vercel-preview of productie-URL.
- Test eerst met een `test_`-sleutel; in testmodus kies je zelf of een betaling slaagt.

### 4. QR-codes

Elke tafel heeft een `qr_token`. De QR-code verwijst naar:

```
https://<jouw-site>/?table=<qr_token>
```

Tokens opvragen (SQL Editor):

```sql
SELECT table_number, qr_token FROM public.restaurant_tables ORDER BY table_number;
```

Maak er met een QR-generator naar keuze een code van en print die voor elke tafel.

## Hoe betalen werkt

1. De gast kiest **online**, en de server maakt een bestelling met status `awaiting_payment` en een Mollie-betaling.
2. De gast betaalt bij Mollie en komt terug op de site; de pagina volgt de status.
3. Mollie roept de webhook aan. De server haalt de betaling opnieuw op bij Mollie en controleert bedrag en valuta.
4. Betaald: de bestelling wordt `received` en verschijnt als werk bij het personeel.
5. Mislukt/afgebroken: de bestelling wordt pas geannuleerd als er geen andere openstaande betaling meer is. De gast kan met één klik opnieuw proberen.
6. Betaald voor een geannuleerde bestelling, of dubbel betaald: het personeel ziet **"Let op"** met een knop om terug te betalen.

Cash: de gast bestelt, het personeel **accepteert** de bestelling en registreert de betaling pas als het geld echt ontvangen is.

## Controleren

```bash
npm run check   # syntaxcontrole van alle JavaScript
```

## Voor livegang

- [ ] Alle migraties uitgevoerd, staff-accounts gekoppeld
- [ ] Vercel-variabelen gezet en een volledige testbestelling gedaan met `test_`-sleutel (betalen, afbreken, annuleren + terugbetalen)
- [ ] Rate limiting (bijv. Vercel Firewall / Supabase) ingesteld tegen misbruik van de publieke bestel-API
- [ ] Echte menukaart en allergenen ingevoerd; voorbeeldgegevens uit 001 verwijderd
- [ ] `MOLLIE_API_KEY` vervangen door de `live_`-sleutel
