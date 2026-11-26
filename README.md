# QR-payment-system (SIPS)

Gasten van SIPS scannen een QR-code op tafel, kiezen hun drank (whisky, rum, gin, cognac, wijn, champagne…), zien de fles het glas inschenken en betalen **online (Mollie)** of **cash aan de kassa**. Het personeel volgt alles op `staff.html`.

- **Hosting:** Vercel (statische pagina's + API-routes in `api/`)
- **Database & login:** Supabase (PostgreSQL, Auth)
- **Betalingen:** Mollie

## Onderdelen

| Bestand | Wat |
|---|---|
| `index.html` + `js/app.js` + `css/sips.css` | Gastpagina in SIPS-stijl: 18+-check, drankkaart, giet-animatie, bestelling, cash of online betalen, live wachtscherm met vullend glas |
| `js/scene3d.js` | **3D** (three.js): realistische flessen en glazen met lichtbreking, draaibare weergave, 3D-giet-animatie en 3D-wachtglas |
| `js/vendor/` | three.js r170 (MIT-licentie, zie `LICENSE-three.txt`) |
| `js/drinkart.js` | 2D-reserve als een toestel geen 3D (WebGL2) aankan |
| `js/guest-api.js` | Cashbestellingen (Supabase) en online bestellingen (`/api/create-payment`) |
| `js/guest-status.js` | Privé bestelstatus volgen met het geheim op het apparaat van de gast |
| `js/realtime.js` | Live updates via Supabase Realtime (geen extra bibliotheek nodig) |
| `staff.html` | Personeel: accepteren, bereiden, cash registreren, weigeren/annuleren, terugbetalen, uitverkocht |
| `api/create-payment.js` | Maakt online bestelling + Mollie-betaling (hergebruikt een open betaling bij een nieuwe poging) |
| `api/mollie-webhook.js` | Mollie meldt een statuswijziging; de server haalt de betaling zelf opnieuw op |
| `api/staff-refund.js` | Online terugbetalen (alleen eigenaar/manager) |
| `api/_lib.js` | Gedeelde serverhulp (geen eigen route) |
| `database/001`–`010` | Migraties, in volgorde uitvoeren |

## Installatie

### 1. Supabase

1. Voer in de **SQL Editor** de bestanden `database/001_…sql` t/m `database/010_…sql` uit, één voor één en in volgorde.
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

## Drankkaart en flesfoto's

- Migratie `009` zet een **voorbeeldkaart** klaar. De prijzen zijn voorbeelden: pas `price_cents` (in centen) aan in Supabase via **Table Editor → products**. Opties zoals "On the rocks" of "Hele fles" staan in `product_options`.
- Per drankje bepalen `glass` (`tumbler`, `wine`, `flute`, `snifter`, `copa`, `highball`), `liquid_color` (bijv. `#c8862a`) en `ice` hoe het glas eruitziet.
- **Flesfoto toevoegen:** maak in Supabase een **Storage**-bucket `bottles` aan (Public) en upload de foto (PNG met transparante achtergrond werkt het mooist). Kopieer de publieke URL. Ga dan op `staff.html` naar **Menu & uitverkocht** en klik bij het drankje op **Foto toevoegen**. Zonder foto tekent de site een fles van het juiste type.
- Gebruik alleen foto's waarvoor SIPS toestemming heeft (eigen foto's of beeldmateriaal van de leverancier).

## Personeelspagina: rollen en ☰-menu

Rechtsboven opent de ☰-knop het menu met **Bestellingen**, **Menukaart** en **Instellingen**.

| | Owner | Manager | Personeel |
|---|---|---|---|
| Bestellingen afhandelen | ✓ | ✓ | ✓ |
| Menukaart bekijken, uitverkocht zetten | ✓ | ✓ | ✓ |
| Prijzen wijzigen | ✓ | – | – |
| Instellingen (meldingen) | ✓ | – | – |
| Terugbetalen, flesfoto's | ✓ | ✓ | – |

De database controleert deze rechten; de pagina verbergt alleen wat iemand niet mag gebruiken.

## Geluidsmeldingen (personeel)

Op `staff.html` klinkt een bel bij elke nieuwe bestelling die opgepakt moet worden: een cashbestelling die geaccepteerd moet worden, of een betaalde online bestelling. Standaardgeluid is **Lounge**. Herhalen staat standaard uit; wie het vinkje "Herhaal elke 30 s" aanzet, hoort hetzelfde geluid elke 30 seconden zolang er zo'n bestelling openstaat. Nieuwe bestellingen lichten op en het tabblad toont het aantal open bestellingen.

- De **owner** kiest onder **Instellingen**: geluid aan/uit, welk geluid (Bar-bel, Glazen klinken, Ding-dong, Lounge, Kassa, Luid signaal), volume, en of en hoe vaak de melding herhaalt (30 sec, 1 min of 2 min). Deze instellingen gelden voor **alle toestellen** van het personeel en worden direct doorgegeven.
- Browsers spelen pas geluid af na een tik op de pagina. Inloggen telt als tik; anders verschijnt een melding.
- Meldingen komen ook binnen als het tabblad op de achtergrond staat. Het scherm van de tablet blijft aan zolang de pagina open is (waar de browser dat ondersteunt). Zet het volume van de tablet aan en sluit de pagina niet.

## 3D

De drankkaart, het detailvenster (veeg om de fles te draaien), het inschenken en het wachtscherm zijn echte 3D-scènes (three.js, WebGL2). three.js laadt pas nadat de kaart zichtbaar is, zodat de pagina snel opent. De kaartafbeeldingen worden één keer per bezoek op het toestel gerenderd. Toestellen zonder WebGL2 krijgen automatisch de 2D-versie.

Een flesfoto (zie hierboven) wordt in de 3D-scène als fles neergezet. De foto moet dan van een server komen die CORS toestaat; Supabase Storage doet dat standaard. Lukt het laden niet, dan wordt de fles in 3D getekend.

## Hoe betalen werkt

1. De gast kiest **online**, en de server maakt een bestelling met status `awaiting_payment` en een Mollie-betaling.
2. De gast betaalt bij Mollie en komt terug op de site; de pagina volgt de status.
3. Mollie roept de webhook aan. De server haalt de betaling opnieuw op bij Mollie en controleert bedrag en valuta.
4. Betaald: de bestelling wordt `received` en verschijnt als werk bij het personeel.
5. Mislukt/afgebroken: de bestelling wordt pas geannuleerd als er geen andere openstaande betaling meer is. De gast kan met één klik opnieuw proberen.
6. Betaald voor een geannuleerde bestelling, of dubbel betaald: het personeel ziet **"Let op"** met een knop om terug te betalen.

## Live updates

Gast- en personeelspagina werken zichzelf direct bij, zonder verversen. De database stuurt bij elke wijziging van een bestelling of betaling een leeg "changed"-seintje via Supabase Realtime (`database/008_live_updates.sql`). De pagina haalt daarna de nieuwe status op via de gewone, beveiligde functies. Het seintje zelf bevat dus geen bestelgegevens.

Valt de liveverbinding weg, dan verversen de pagina's automatisch om de paar seconden. Op de personeelspagina staat **● Live** zolang de verbinding er is. In Supabase moeten publieke Realtime-kanalen toegestaan zijn; dat is de standaardinstelling.

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
