# Escrow: schlanker Abnahmelauf

Stand: 12.10.2026, Anwendungsbasis `d2d54cd5`. Dieser Plan aktiviert nichts und beauftragt keine echten API-Aufrufe. Verantwortlich für das Go und die Abnahme ist Kev.

## Bereits nachgewiesen

3.106 lokale Tests sind grün (3.103 Frontend, 3 Backend), dazu 70 SQL-Prüfungen in PGlite, Typecheck, Source-Lint und Produktionsbuild. Die isolierte Browserprüfung bei 1440×900 und 390×844 besteht: ein kostenloses Bild pro UTC-Tag, vier Bilder mit bewusster Wahl des bezahlten Modells und Servergesamtpreis vor der Bestätigung, verfügbare und ausgeschöpfte Kontingente in Editor und Bildansicht. Dabei liefen keine echten Zahlungen oder Provider-Generierungen. Die Beispielquote $0.066 ist kein Produktionspreis.

Vor Aktivierung bleibt der echte PostgreSQL-Test mit getrennten, konkurrierenden Sitzungen erforderlich. `npm run test:migrations:postgres` nutzt ausschließlich die dafür vorgesehene leere lokale `enki_escrow_test`-Datenbank. Die genehmigte Loopback-Verbindung wird über `ENKI_ESCROW_TEST_DATABASE_URL` lokal gesetzt und nie ausgegeben; das Harness legt sein Testschema an. Das ist kein Nachweis aus PGlite. Tageskontingent und Unit-Claims müssen unter konkurrierenden Sitzungen ebenfalls genau einen Gewinner haben; ein fehlender realer Konkurrenznachweis bleibt als Abnahmepunkt offen.

## Lauf vorab mit Kev festlegen

In ClickUp ein kurzes Laufblatt ausfüllen und Kevs Go festhalten:

- Build/Commit, Test-URL, Entwicklungsdatenbank, Cluster **Devnet**, bereitgestelltes Programm und dessen Config, Test-USDC-Mint sowie zwei eigene Testkonten A/B.
- Gewähltes Basismodell und bezahltes Modell aus dem tatsächlichen Katalog, Auflösung/Qualität, Anzahl der echten Bilder und maximale Anzahl aller metered Requests einschließlich Polling/Downloads/RPC.
- Geschätzte Providerkosten, genehmigte maximale Kosten und Abbruchgrenze. Zahlen aus dem Provider/Katalog prüfen; dieser Plan setzt keinen Preis oder Betrag fest.
- Welche Fälle nur simuliert bleiben und welche vollständig über die echte Anwendung laufen. Keine zusätzlichen Versuche oder Subagentenaufrufe außerhalb dieses Budgets.

**Devnet-Test-SOL und Test-USDC ersetzen echte Token, aber keine Providerrechnung.** Zuerst die vorhandenen lokalen Mocks verwenden. Ein separat freigegebener Devnet-SDK-Smoke kann Deposit → Settle → Reclaim mit Testtoken prüfen, ohne Bildprovider aufzurufen; er ersetzt den Anwendungstest mit dauerhafter Bildspeicherung nicht. Auch ein Devnet-RPC kann Credits kosten.

Echte Generierung folgt erst nach dem ausgefüllten Laufblatt. Entwicklungsaufrufe durch `scripts/metered-guard.mjs` führen; `METERED_BUDGET` und `METERED_MAX_IMAGES` aus dem genehmigten Lauf setzen. Der Guard begrenzt Requests/Bildzahl und ersetzt keine finanzielle Kostengrenze. Provideraufrufe vor dem ersten Versuch zählen, auch erwartete Fehler. Lauf stoppen, sobald Kontingent, Kosten oder Ergebnis vom Go abweichen.

Voraussetzungen für den Anwendungstest: vollständige reviewed Migrationen, erfolgreicher PostgreSQL-Konkurrenztest, korrekte Devnet-Config/Operator/Treasury und geklärte Programm-/IDL-Version. Die Reihenfolge und das vorherige Leeren der alten Nonce-Schiene stehen in [ESCROW-APPLICATION-CUTOVER.md](ESCROW-APPLICATION-CUTOVER.md). Dieser Lauf enthält keinen Mainnetbetrieb und keine Rust-Builds.

## Fünf fokussierte Fälle

Die Fälle zusammen ausführen und Ergebnisse wiederverwenden. Den echten Bildumfang legt Kev vor dem Start fest; die Vier-Bilder-Preisvorschau muss nicht vier echte Generierungen auslösen.

| Fall | Schritte | Abnahmekriterium und Nachweis |
| --- | --- | --- |
| 1. Ein kostenloses Bild pro Tag | Konto A mit verbleibendem Kontingent öffnet Editor oder Bildansicht und erzeugt genau ein Basismodell-Bild. Danach nochmals versuchen, ohne bezahltes Modell zu wählen. | GET `/api/generate-free/quota`: zuerst `limit=1, remaining=1`, danach `remaining=0, exhausted=true`. Genau eine erfolgreiche Tagesclaim in `free_generation_claims`; zweiter Versuch erzeugt keinen weiteren Providerauftrag. Screenshot zeigt ausgeschöpftes Kontingent und verständlichen Hinweis auf die bezahlte Modellwahl. Tagesgrenze ist UTC; keinen weiteren echten Call zum Testen eines Datumswechsels auslösen. |
| 2. Vier Bilder, 1 frei + 3 bezahlt | Mit einem separaten frischen Testkonto vier Bilder auswählen; Konto A hat sein Tageskontingent durch Fall 1 bereits verbraucht. Zunächst kein bezahltes Modell wählen, anschließend ein kompatibles bezahltes Katalogmodell ausdrücklich auswählen. Vor Zahlungsbestätigung anhalten. | Bestätigung bis zur Modellwahl/gültigen Serverquote gesperrt. Aufteilung und Gesamtpreis entsprechen der echten Quote; kein stiller Modellwechsel. Vor Bestätigung kein Deposit-Submit und keine Generierung. Je ein Desktop-/Mobil-Screenshot. Der vollständige Vier-Bilder-Lauf ist nur Bestandteil der Abnahme, wenn Kev genau diesen Bildumfang freigegeben hat. |
| 3. Abbruch und Reload ohne Doppelarbeit | Einen freigegebenen bezahlten Auftrag einmal bestätigen. Nach Submit die Ansicht schließen/reloaden; denselben Auftrag über seinen Status fortsetzen. Kein neuer Auftrag zur Reparatur eines unklaren Status. Abbruch danach über die Anwendung testen; laufende Units dürfen auslaufen. | Derselbe `intentId` und unveränderte Deposit-Signatur bleiben bestehen. Ein gültiger Retry sendet dieselben gespeicherten Bytes; kein zweites Deposit für denselben Intent. Pro Unit höchstens ein Providerauftrag und eine dauerhaft gespeicherte Bildlieferung. Status stellt das Bild wieder her. Unbegonnene abgebrochene Units werden nicht mehr gestartet; Settle und Reclaim sind getrennte Transaktionen. |
| 4. Teilweise Lieferung und Erstattung | In einem isolierten Testauftrag mehrere bezahlte Units reservieren und nur einen Teil dauerhaft liefern. Rest kontrolliert vor Provideraufruf stoppen oder mit einem geprüften Testadapter fehlschlagen lassen. Keinen teuren Providerfehler provozieren und keine Ledgerzeile manuell erfinden. | SQL friert `k` als Anzahl der `delivered`-Units ein; On-chain `settled_units=k`. Treasury/Künstlerzahlungen und `refund_due` entsprechen den gespeicherten Pro-Unit-Beträgen und den tatsächlich bezahlten Legs. Danach separate Reclaim-Signatur, Erstattung an Käufer, beide PDAs geschlossen und Miete zurück. Wiederholter Status/Abbruch ändert Zahlung oder Recovery nicht erneut. Ohne geeigneten isolierten Fehleradapter bleibt der echte Teilfehlerlauf offen; vorhandene Mocktests belegen ihn bereits lokal. |
| 5. Server prüft Eigentümer | Konto B versucht Status, Authorize, Submit, Cancel und Generate für einen Intent von A. Anfragen in einem isolierten Client gezielt ausführen; keine fremden realen Konten verwenden. | Ablehnung ohne fremde Zahlungs-/Bilddaten, neuen Claim, Signierung, Broadcast oder Provideraufruf. Owner stammt aus der authentifizierten Sitzung; Body/Query dürfen ihn nicht ersetzen. Vorher-/Nachhervergleich der Intent-/Unit-/Transaktionszeilen und Anfrageprotokoll. |

## Ergebnisnachweise pro bezahltem Intent

Nur die nötigen Felder als lesenden Export erfassen; Secrets, Session-/Claim-Tokens, private Keys, `.env` und rohe signierte Transaktionsbytes gehören nicht ins Ticket.

| Quelle | Festzuhalten |
| --- | --- |
| `generation_escrow_deposits` | `intent_id`, `state`, Deposit-Signatur, `confirmed_slot`, kanonische Escrow-/Vault-Adressen. Funding erst nach erfolgreichem Receipt plus geprüftem Escrow und Vault auf mindestens dessen Slot. |
| `generation_escrow_units` / `generation_escrow_batches` | Unit-Index, Zustand, `generation_id`; Batchzustand und eingefrorene `delivered_units`. Für jede gelieferte Unit existieren dauerhafte Generation und Bilddatei. Üblicher Pfad: `open` → `closing`/`ready` → `settled` → `closed`; `closing` darf auf laufende Leases warten. |
| `generation_escrow_transactions` | Getrennt für `kind=settle` und `kind=reclaim`: Zustand, Signatur, Bestätigungsslot. Settle benötigt Receipt plus passenden kanonischen Accountzustand. Reclaim benötigt Receipt plus Abwesenheit beider PDAs auf mindestens dessen Slot. |
| `generation_escrow_recovery` und Künstlerledger | Zustand, `units`, `delivered_units`, `recovery_unit_micro`, Pro-Unit-Legs und Settlement-Signatur. Recovery genau einmal für bestätigte bezahlte Lieferung buchen; Werte aus der Reservierungs-RPC, keine zweite TypeScript-Formel. |
| Devnet-Accounts/Receipts | Mint/Programm/Config, Kaufbetrag aus Snapshot, Vaultsaldo, `settled_units`, `refund_due`, Käufer-/Treasury-/Künstler-Tokenänderungen und Rückgabe der Rent-Lamports. Für Gebühren/Rent getrennt Token- und SOL-Beträge vergleichen. |
| UI und Requests | Screenshot vor Bestätigung mit Modell, Aufteilung und Gesamtpreis; Kontingent-/Abbruch-/Erstattungsanzeige; Zähler tatsächlicher Provideraufträge und Signaturen. Kennzeichnen, ob Daten simuliert oder echte Devnet-/Providerergebnisse sind. |

Ein Timeout oder RPC-Ausfall ist keine Erstattung und kein Verfallsbeweis. Offene/unklare Zahlungen als pending dokumentieren und über ihren gespeicherten Status abgleichen. Verfall braucht die vorhandene finalized Blockhöhen-/Accountprüfung; nicht aufgrund verstrichener Wandzeit einen neuen Auftrag erzeugen.

Kev nimmt den Lauf ab, wenn die genehmigten echten Fälle diese Nachweise liefern und keine offenen Geld-/Eigentümerabweichungen bestehen. Nicht ausgeführte echte Fälle ausdrücklich offen lassen. Die lokale Browser-QA fand keinen konkreten zusätzlichen Frontend-Polishmangel; daraus wird keine unbelegte Nacharbeit für die Frontend-Devs abgeleitet.


