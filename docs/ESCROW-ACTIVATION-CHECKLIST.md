# Escrow-Aktivierung: parallele Übergabe

Stand: 12.10.2026. Lokaler Übergabestand vor diesem Dokument: `d2d54cd5`. **3.106 Anwendungstests und 70 Offline-SQL-Prüfungen sind grün**, ebenso TypeScript, Produktionsbuild und `escrow:check`. Das belegt den lokalen Stand; Live-Migrationen, finanzierte Transaktionen, echte Provider-Generierungen und GitHub-CI wurden für diese Übergabe nicht ausgeführt. Rust-Builds bleiben wegen der ungeklärten Norton-Meldung pausiert.

Lesender GitHub-Stand: Frontend-`main` ist weiterhin `470739aba34130ff0b72e2a81fa486dfeaa8440d`; Escrow-PR #1 ist offen mit HEAD `480e9a5b`. Frontend #118/#119 sowie Redesign #170–172 und #174–179 sind ebenfalls offen. Der lokale Integrationsstand wird mit Git-Bundle und Prüfnachweisen übergeben. Bereits extern erledigte Arbeiten unten bitte **bestätigen**, statt sie erneut auszuführen.

## Jetzt parallel vergeben

| Owner | Arbeitsauftrag | Fertigkriterium / Rückgabe |
| --- | --- | --- |
| **Kev + Backend-Owner** | Vollständiges Supabase-Schema lesend gegen die Migrationen prüfen: Spalten, CHECK/FK/UNIQUE-Constraints, Indizes, RLS und RPC-Rechte. Bisherige REST-Spaltenproben reichen dafür nicht. Status bereits angewendeter SQLs bestätigen; alte Nonce-Zahlungen und Recovery-Buchungen für den Cutover prüfen. | Schema-/Constraint-Nachweis, freigegebene SQL-Reihenfolge und Liste bereits angewendeter Dateien; dokumentierte alte Transaktionen/Nonce-Konten und offene Recovery-Buchungen, bis der Drain abgeschlossen ist. Ein echter Backend-Reviewer übernimmt Geld-/SQL-/Cron-Review; Kev merged anschließend. |
| **Programm-Owner, separate Release-Arbeit** | Status finaler Devnet-/Mainnet-Programmadressen und Deployment bestätigen. Anchor-Konfiguration und `anchor keys sync`, IDL-Provenienz und Frontend-Pin abstimmen; `default = []` sowie Mainnet-Build mit `--no-default-features --features mainnet` prüfen. `update_config` vor einem Timelock korrigieren: Es darf eine inzwischen erfolgte Guardian-Pause bzw. Operator-Widerruf nicht durch veraltete Argumente rückgängig machen. | Öffentlicher Cluster, Programmadresse, Programm-Source-/Deployment-SHA und Deployment-Nachweis; passende IDL samt Prüfsumme und erfolgreichem `escrow:check`; dokumentierter Guardian-/Update-Fix und freigegebener Mainnet-Build. Bereits vorhandene Nachweise genügen. Rust erst nach Klärung des Norton-Befunds fortsetzen. |
| **Kev + Deployment-Owner** | Konfiguration im vorgesehenen Deployment bestätigen, Bildspeicherung prüfen und den vorhandenen Fünf-Minuten-Job `/api/cron/sweep-payments` einplanen. Parallel den lokalen Stack und das Bundle reviewen; GitHub-CI-Status bestätigen, sobald die Änderungen dort verfügbar sind. | Nur Konfigurationsstatus und öffentliche Adressen zurückgeben; bestätigter Storage-Pfad und Cron-Ausführung mit Reconciliation-Ergebnis. Noch keine neuen Zahlungen freischalten. |

Wallet-Aufteilung mit Kev bestätigen: Squads **2-of-3** ist der vorgeschlagene Aufbau für Upgrade-/Admin-Autorität, mit drei getrennt verwahrten Signierern. Der Guardian erhält den unabhängigen Notfallpfad zum Pausieren/Widerrufen. Der laufende Server-Operator bleibt ein eigener begrenzter Signierer; die aktuelle Anwendung erwartet für jede Einzahlung und Abrechnung dessen Signatur. Ein Multisig ersetzt diesen Signierer nicht ohne zusätzliche Integration.

Die on-chain `Config` muss zum Deployment passen: Operator, Guardian/Admin, Treasury-Owner, TTL und `max_deposit_micro`; außerdem die im Programm festgelegte USDC-Mint gegen den Cluster prüfen. Der beschlossene Klickdeckel **50 USDC** steht ausschließlich in `Config.max_deposit_micro`, ohne zweiten SQL-/TypeScript-Deckel. Treasury-ATA während offener Escrows weder schließen noch unbrauchbar machen. Bei Operator-Rotation den ursprünglichen Rent-Payer bis zum Abschluss seiner Escrows verfügbar halten: Eine Rückholung mit fehlendem Käufer-ATA braucht dessen Signatur. Den Rückholungspfad für alte Rent-Payer vor einer Rotation bestätigen; der Server lädt derzeit einen Operator-Schlüssel.

## Konfiguration aus dem tatsächlichen Code

**Keine Schlüssel oder ENV-Dateien im Chat.** Geheimnisse nur im vorgesehenen Secret-Store setzen; zur Übergabe reichen „vorhanden/geprüft“ und öffentliche Adressen.

| ENV-Name | Prüfung |
| --- | --- |
| `SOLANA_PAYMENT_CHAIN` | Explizit `solana-devnet` oder `solana`; `SOLANA_FUND_CHAIN` ist der vorhandene Fallback. Eine eindeutige, konsistente Auswahl bestätigen. |
| `SOLANA_ESCROW_PROGRAM_ID` | Öffentliche Adresse des tatsächlich auf diesem Cluster deployten, passend gepinnten Programms. |
| `SOLANA_FEE_PAYER_SECRET_KEY` | Server-only; öffentliche abgeleitete Adresse muss `Config.operator` entsprechen; ausreichend SOL für Gebühren und Rent. |
| `SOLANA_RPC_URL`, `SOLANA_RPC_URL_FALLBACK` | Optionale Mainnet-RPCs. Der bestehende Code nutzt diese Overrides ausschließlich bei `solana`; Devnet verwendet den konfigurierten öffentlichen Endpunkt. |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Richtige Umgebung; Service-Key nur serverseitig für die Escrow-RPCs. |
| `CRON_SECRET` | Deployment und authentifizierter Cron-Aufruf müssen übereinstimmen. |
| `BLOB_READ_WRITE_TOKEN` | Optionaler Vercel-Blob-Pfad; alternativ den bestehenden Supabase-Storage-Pfad einschließlich `generations`-Bucket bestätigen. |
| `FIELD_ENCRYPTION_KEY_B64` | Bestehende Feldverschlüsselung verfügbar. `FIELD_ENCRYPTION_KEYS_RETIRED` und `PROMPT_ENCRYPTION_KEY` nur entsprechend bestehender Entschlüsselungs-/Rotationshistorie erhalten. |

Treasury-/Admin-/Guardian-Adressen stammen aus der on-chain Config; dafür wird hier kein neuer ENV-Name eingeführt. Provider-Zugang und Modell für einen echten Test gesondert bestätigen, ohne Geheimnisse auszutauschen.

## Zwingende Startreihenfolge

1. **Review parallel abschließen:** SQL-/Schema-Review, separater Programm-Release und App-Review können gleichzeitig vorbereitet werden. Programm-/IDL-Nachweis und geprüfte Config müssen vor einer neuen Einzahlung vorliegen.
2. **Alte Nonce-Schiene anhalten und drainen:** Alle alten Admissions stoppen; bisherigen Release für Abrechnung/Drain erhalten. Laufende Generierungen abwarten, signierte Transaktionen und Nonce-Konten on-chain abgleichen, erfasste Zahlungen und Recovery-Ledger vollständig buchen. Unbenutzte Nonce-Konten schließen und Audit behalten. Zeitablauf oder ein leerer Sweep beweisen diesen Abschluss nicht.
3. **Freigegebene SQLs in dieser Reihenfolge anwenden bzw. vorhandene Anwendung bestätigen:**
   - `2026-10-05-escrow-recovery-reservations.sql`
   - `2026-10-06-escrow-deposit-persistence.sql`
   - `2026-10-12-escrow-cutover-guard.sql` im Wartungsfenster, nach dem Drain
   - `2026-10-12-escrow-unit-claims.sql`
   - `2026-10-12-escrow-settlement-attempts.sql`
   - `2026-10-12-escrow-orphan-reservations.sql`
   - `2026-10-06-free-generation-claims.sql`, falls noch nicht vorhanden, vor `2026-10-12-free-daily-quota.sql`
   - `2026-10-12-free-daily-quota.sql`

   Der Guard prüft ungelöste DB-Marker; zusätzlich bleibt der on-chain-/Ledger-Nachweis aus Schritt 2 erforderlich. Den echten Mehrsitzungs-PostgreSQL-Locktest im isolierten Testsystem durchführen; die 70 Offline-Prüfungen ersetzen ihn nicht.
4. **Passende App gemeinsam mit Quota-RPC und Konfiguration deployen.** Status, Speichern der Bilder und Cron prüfen. Die Regel ist ein kostenloses Bild pro UTC-Tag auf dem bisherigen kostenlosen Modell; weitere Bilder benötigen die ausdrücklich gewählte bezahlte Variante und den angezeigten Serverpreis.
5. **Begrenzten Devnet-Abnahmetest nach konkretem Go durchführen:** Cluster, Test-Wallet, Modell, Bildanzahl und maximale Providerkosten vorher festlegen. Nachweis für Einzahlung → dauerhaft gespeichertes Bild → separate Abrechnung → separate Rückholung, einschließlich ungenutzter Einheiten; DB-Bildzählung, `settled_units`, Treasury und Rückzahlung abgleichen. Erst nach diesem Nachweis gibt Kev die Produktion frei.

Die bestehenden x402-`exact`-Routen bleiben der direkte Zahlungsweg; diese Übergabe aktiviert dort kein Escrow-Protokoll. Details zu Transaktionsnachweisen und Cutover stehen in [ESCROW-APPLICATION-CUTOVER.md](./ESCROW-APPLICATION-CUTOVER.md).

## Rückmeldung für die gemeinsame Aktivierung

Bitte gesammelt zurückgeben: **öffentliche Programmadresse + Cluster + Deployment-SHA**, IDL-Nachweis, geprüfte Config-/Wallet-Rollen, **bestätigte SQL-Dateien mit Schema-/Drain-Nachweis**, Deployment-/Cron-Status und das konkrete Devnet-Test-Go. Damit lassen sich die parallelen Arbeiten zusammenführen, ohne Schlüssel im Chat oder eine neue Runde allgemeiner Rückfragen.
