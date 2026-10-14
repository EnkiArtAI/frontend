# Escrow: Übergabe für paralleles Review

Stand: **2026-10-12**, Branch `codex/escrow-lifecycle-backend-2026-10-12`, geprüfter lokaler Commit **`d2d54cd5`**. Diese Übergabe bezieht sich auf denselben Stand wie [ESCROW-APPLICATION-CUTOVER.md](ESCROW-APPLICATION-CUTOVER.md). Der neue Anwendungsstack beginnt nach `99437143`; `b40c5e28` übernimmt den zuvor geprüften Escrow-Client.

Die drei Bereiche können gleichzeitig gegen diesen festen Stand geprüft werden. Ihre Freigaben gelten für den jeweiligen Bereich; der gemeinsame Release benötigt alle drei. Es gibt keine Freigabe für Livezahlungen oder bezahlte Testgenerierungen. Änderungen, Tests und Build sind lokal; daraus folgt keine grüne GitHub-CI.

## 1. SQL und RPCs

**Review:** Backend-Owner, zusätzlich Kev wegen Zahlungs- und Kontingentverhalten. Migrationen erhalten eigene PRs.

| Commit | Gegenstand |
| --- | --- |
| `85344ed8` | Gefundete Einzahlung, einzelne Bild-Claims und dauerhaft belegte Lieferung |
| `f72180a6` | Getrennte, gespeicherte Settlement- und Reclaim-Versuche |
| `74c9dd94` | Abgeschlossene Batches und Auswahl offener Arbeit |
| `5e9212b9` | Ein kostenloses Baseline-Bild pro UTC-Tag |
| `14bb88fe` | Sperre bei ungelösten Zahlungen des alten Nonce-Pfads |
| `0609fba7` | Ablauf von Recovery-Reservierungen ohne gespeicherte Einzahlung |
| `b7f03773` | Enthält die abschließenden SQL-Korrekturen für konkurrierende Lifecycle-Versuche und faire Kandidatenauswahl |

**Schlüsseldateien:**

- `migrations/2026-10-12-escrow-unit-claims.sql`
- `migrations/2026-10-12-escrow-settlement-attempts.sql`
- `migrations/2026-10-12-escrow-orphan-reservations.sql`
- `migrations/2026-10-12-escrow-cutover-guard.sql`
- `migrations/2026-10-12-free-daily-quota.sql`
- Bestehende Vertragsbasis: `migrations/2026-10-05-escrow-recovery-reservations.sql` und `migrations/2026-10-06-escrow-deposit-persistence.sql`.

**Abzunehmen:** Service-only-Zugriff und feste Suchpfade; Eigentümerbindung und konsistente Locks; ein Claim pro gekaufter Einheit; keine Wiederaufnahme eines bereits laufenden oder erledigten Provider-Auftrags. Nur akzeptierte, dauerhaft gespeicherte Bilder des beanspruchenden Users erhöhen die Lieferzahl. `k` muss aus den dauerhaft gelieferten Datenbankeinheiten stammen; ein Wert aus der Anfrage darf ihn nicht bestimmen. Ein gleichzeitiger Settlement-/Reclaim-Versuch darf die gemeinsame Lifecycle-Sperre nicht umgehen. Wiederholte Bestätigungen müssen idempotent sein, und offene alte Fälle dürfen neuere Fälle im Sweep nicht verdrängen.

Recovery bleibt ausschließlich die Formel der Reservierungs-RPC: halber Künstleranteil pro Einheit bis zur Rückholung, ohne separaten Raten- oder Einzahlungsdeckel. Verwaiste Reservierungen dürfen nur ohne gespeicherte Einzahlung ablaufen. Der Cutover-Guard muss sichtbar ungelöste Nonce-Zahlungen blockieren; seine Grenzen bei Chain-Abschluss und historischer Ledger-Buchung müssen berücksichtigt werden. Die Tagesgrenze muss unter dem User-Lock gelten, für Teamkonten ebenso wie andere Konten, und gescheiterte kostenlose Bilder müssen ihr Kontingent zurückgeben.

**Vorhandene Prüfbasis:** `scripts/test-escrow-recovery-migration.mjs`, `scripts/escrow-unit-migration-checks.mjs`, `scripts/escrow-settlement-migration-checks.mjs`, `scripts/escrow-orphan-migration-checks.mjs`, `scripts/escrow-cutover-checks.mjs`, `scripts/free-daily-quota-checks.mjs` und die Fixtures unter `scripts/fixtures/`. Die 70 lokalen SQL-Prüfungen sind PGlite-Prüfungen. Echte PostgreSQL-Konkurrenz über mehrere Sessions sowie die vollständigen Live-Constraints und Indizes bleiben vor Deployment abzugleichen.

## 2. Backend und Payment-SDK

**Review:** Backend-Owner **und** Kev. Backend-PRs getrennt von Migrationen und UI.

| Commit | Gegenstand |
| --- | --- |
| `b40c5e28`, `ec2d840f` | Geprüfter Client, serverseitige Einzahlung und Bestätigung |
| `69f4d312`, `e6e2682d` | Getrennte Settlement-/Reclaim-Transaktionen und owned Zahlungsrouten |
| `0481edd9`, `9362cff0` | Bild-Claims, strikte dauerhafte Aufzeichnung und Lieferbuchung |
| `363eb01f` | Entfernung der Nonce-Schiene; gemeinsame Transfer-Helfer bleiben erhalten |
| `b7f03773`, `e983ec0c` | Lifecycle-Retry, faire Reconciliation und verwaiste Reservierungen |
| `0ca58a5f`, `d47fbd4b` | Tageskontingent, weiterhin bezahlte Premiummodelle und ehrliche Fehlermeldungen |

**Schlüsseldateien:** `lib/payments/escrow/{server-chain,server-deposit,server-claims,server-lifecycle,server-sweep,server-route}.ts`; die reinen Helfer `addresses.ts`, `deposit.ts`, `confirmation.ts`, `lifecycle.ts`; `lib/payments/escrow/idl/` und `generated/`; `lib/payments/escrow-amounts.ts`; `app/api/payments/generation/{intent,authorize,submit,status,cancel}/route.ts`; `app/api/generate-image/route.ts`; `lib/generation/record.ts`; `app/api/cron/sweep-payments/route.ts`; `app/api/generate-free/{route.ts,quota/route.ts}`; `lib/generation/free-quota.ts`; `lib/payments/pricing-rules.ts` und `solana-transfer.ts`.

**Abzunehmen:** Nur serverkompilierte, gespeicherte Deposit-Nachrichten werden nach gültiger Käufersignatur mitunterzeichnet. Der gewinnende signierte Wire wird vor Broadcast gespeichert und bei Wiederholung unverändert verwendet. Genesis, expliziter Cluster, Programm, Config, Operator und kanonische PDAs müssen stimmen. `Config.max_deposit_micro` begrenzt den gesamten bezahlten Klick; kein zweiter fester Wert wird eingeführt.

Vor jeder Bildzulassung müssen Escrow, Vault und Clock aus derselben frischen Bank stammen, mindestens auf dem gespeicherten Bestätigungs-Slot. Eine Signatur oder ein Datenbankstatus allein reicht nicht. Modell und Preis stammen vom Intent; Lieferung wird nach akzeptierter dauerhafter Aufzeichnung gezählt. Settlement benutzt die eingefrorene DB-Lieferzahl, unabhängig vom Künstler-ATA. Settlement und Reclaim bleiben getrennt; Dust begründet keinen zusätzlichen Käufer-Refund. Ablauf erfordert passende finale Chain-Proofs statt RPC-Ausfall oder Walltime. Reconciliation muss Abweichungen und fehlende Abschlussbeweise melden, ohne Rohfehler oder Zugangsdaten zu loggen.

**Abgrenzung:** Der externe x402-`exact`-Endpoint behält sein Direct-Transfer-Protokoll. Er ist kein Escrow-Fallback und darf nicht als neuer Escrow-Zahlungsweg beworben werden. Der Programm-Release mit endgültigen Keys/Governance ist ebenfalls eine eigene Abhängigkeit.

**Vorhandene Prüfbasis:** `lib/payments/__tests__/escrow-*.test.ts`, `lib/__tests__/{escrow-generation-route,record-generation-strict,cron-sweep,free-daily-quota,free-quota-route}.test.ts`; IDL-Abgleich mit `npm run escrow:check`.

## 3. UI, Checkout und Quota

**Review:** Frontend-Owner; Backend-Owner prüft die Zahlungs- und Quota-Verträge mit, Kev gibt den gemeinsamen Release frei. UI erhält eigene PRs.

| Commit | Gegenstand |
| --- | --- |
| `a3a263cb` | Ein Deposit pro bezahltem Batch, eindeutige Modellwahl, Status-Recovery und dauerhafte Checkpoints |
| `840a9cb8` | Await der dauerhaften Speicherung eines Payment-Checkpoints |
| `d47fbd4b` | Gemeinsame ehrliche Behandlung gefundeter Escrow-Fehler |

**Schlüsseldateien:** `lib/generation-checkout.ts`, `lib/generation/run-generation.ts`, `hooks/useRenderQueue.ts`, `lib/ui/kit/render-queue.ts`, `lib/editor/draft-store.ts`, `components/GenerateLauncher.tsx`, `components/prompt-editor/PromptEditor.tsx`, `components/image-view/useImageViewModel.ts` und `components/image-view/MainImage.tsx`.

**Abzunehmen:** Pro Klick ein gemeinsamer bezahlter Intent mit festen Unit-Indizes und einer Käufersignatur. Keine Generierung vor `funded: true`. Checkpoints werden vor Submit und Provider-Request gespeichert und awaited. Verlorene Antworten und Reload dürfen weder einen neuen Deposit noch einen zweiten Provider-Auftrag auslösen. Restaurierte Launcher-Aufträge ohne Draft prüfen ausschließlich Status oder stornieren; sie reichen keinen vorbereiteten Wire ein. Gelieferte Bilder werden über den owned Status wiedergefunden. Bereits signierte Zahlungen sind ohne neue Preis-/Balance-Hürde prüfbar; interne IDs oder Fehlerobjekte erscheinen nicht als UI-Text.

Ein kostenloses Bild pro UTC-Tag gilt ausschließlich für das Baseline-Modell. Premium bleibt bezahlt. Bei vier Bildern und verfügbarem Kontingent zeigt der Launcher **1 kostenlos + 3 bezahlt**, verlangt ein ausdrücklich ausgewähltes kompatibles Bezahlmodell und zeigt dessen Server-Gesamtpreis vor Bestätigung. Nach Kontingentverbrauch gibt es weder einen erfundenen Baseline-Preis noch einen automatischen Modellwechsel. Referenzbilder müssen vor Checkout vollständig eingelesen sein. Nach Submit verspricht die Oberfläche keine unbelegte Aussage „nichts berechnet“.

**Vorhandene Prüfbasis:** `lib/__tests__/{generation-checkout,run-generation,quick-create-selected-model,generate-waits-for-refs,sheet-server-quote}.test.ts`; Queue-/Failure-Tests unter `lib/ui/kit/__tests__/`; `lib/editor/__tests__/{draft-store,prompt-editor-wiring}.test.ts`; `lib/ui/image-view/__tests__/wiring.test.ts`. Die lokalen Browser-Fixtures decken 1440×900 und 390×844, ausdrückliche Paid-Auswahl, simulierten Gesamtpreis und verbrauchtes Tageskontingent ab. Sie belegen keinen Live-Provider- oder Wallet-Ablauf.


## Remote-Stand und bestehender Stack

Lesend bestätigter GitHub-Stand zum Zeitpunkt der Übergabe:

- `EnkiArtAI/frontend` auf `main`: `470739aba34130ff0b72e2a81fa486dfeaa8440d`.
- [Programm-PR #1](https://github.com/EnkiArtAI/enki-escrow/pull/1) ist weiterhin **OPEN**, Head `480e9a5b`. Eine Programmfreigabe oder ein Deployment wird hier nicht vorausgesetzt.
- Frontend [#118](https://github.com/EnkiArtAI/frontend/pull/118) und [#119](https://github.com/EnkiArtAI/frontend/pull/119) sind weiterhin **OPEN**. Die Amount-/Vertragsbasis aus #118 liegt vor dem SDK aus #119; Key-Sync und IDL-Neupin gehören zum abgestimmten Programm-Release.
- Die Redesign-PRs **#170–#172 und #174–#179** sind weiterhin **OPEN**. Die lokale Integration enthält diese Basis und Korrekturen; ihr Review/Merge muss vor dem gemeinsamen Anwendungsrelease abgeschlossen werden. Die zuvor aufgebaute Reihenfolge ist UI **#170 → #171 → #172 → #174** und Backend **#175 → #176 → #177 → #178 → #179**.
- Der neue Cutover-Branch wurde am **12.10.2026 nach ausdrücklichem Go von Kev und dem Nutzer gepusht**: [Integrationssnapshot](https://github.com/EnkiArtAI/frontend/tree/codex/escrow-lifecycle-backend-2026-10-12). Das Git-Bundle bleibt ein zusätzlicher Import für das Review. Es ersetzt weder getrennte PRs noch Freigaben. Für die tatsächliche aktuelle Revision den GitHub-Head bzw. das Bundle-Manifest verwenden; der lokal vollständig geprüfte Anwendungsstand dieser Übergabe ist `d2d54cd5`. Nachfolgend wurden ausschließlich Dokumentation und der PostgreSQL-CI-Aufruf korrigiert.

Die bereits vorhandenen Recovery-/Deposit-Migrationsdateien dürfen außerdem nicht mit ihrem Live-Anwendungsstatus verwechselt werden: Vor Aktivierung ist zu prüfen, welche SQL-Verträge in der Ziel-Datenbank tatsächlich vorhanden sind.

## Zusammenführen und aktivieren

1. Die drei Reviews gegen `d2d54cd5` beginnen sofort parallel. Befunde mit Datei/Zeile, Auswirkung und konkreter Abnahmebedingung melden. Keine fremden Branches umschreiben.
2. Beim Aufteilen der lokalen Commits Dateiebene beachten: einige Integrations-/Fix-Commits enthalten mehrere Bereiche. Migrationen, Backend und UI bleiben gemäß `CONTRIBUTING.md` getrennte, reversierbare PRs. Für Geld sind Backend-Abnahme und Kevs Freigabe erforderlich; Kev merged. CODEOWNERS enthält noch `@TODO-backend` und erzwingt zwei getrennte Zustimmungen nicht automatisch.
3. Die Recovery-/Deposit-Verträge und der geprüfte Payment-Client müssen vor ihren abhängigen Anwendungs-PRs vorhanden sein. SQL für Claims, Lifecycle, verwaiste Reservierungen und Tagesquota muss vor Aktivierung der entsprechenden Backend-Routen bereitstehen. UI-Checkout und neue Backend-Verträge gehen gemeinsam im Release live; kein Zwischenstand darf Kunden auf die entfernte Nonce-Schiene schicken.
4. Im Wartungsfenster alte Nonce-Zulassungen stoppen und laufende Arbeit auslaufen lassen. Den bisherigen Release für Drain/Reconciliation vorhalten. Signierte Nonce-Transaktionen, Capture-/Ledger-Reste und Account-Rent auf Chain abgleichen; ein leerer Sweep beweist den Abschluss nicht. Den Cutover-Guard erst nach diesem Abgleich anwenden.
5. Vor Aktivierung den getrennten Programm-Release abschließen: endgültige Programm-IDs, Key-Sync, passender IDL-Pin, Mainnet-Build und geprüfte Guardian-/Operator-Regeln. Expliziten Cluster, deployed Program-ID und Operator konfigurieren, Config sowie Treasury-ATA prüfen. Alte Rent-Payer-Signierfähigkeit bis zum Schließen ihrer offenen Escrows behalten.
6. Die vollständige SQL-Reihenfolge und Betriebsbedingungen stehen in [ESCROW-APPLICATION-CUTOVER.md](ESCROW-APPLICATION-CUTOVER.md). Live-Migrationen und ein echter Acceptance-Lauf benötigen die dort genannte Freigabe mit Netzwerk, Testwallet, Bildanzahl/Modell und maximalen Providerkosten. Diese Übergabe aktiviert nichts.

## Bereits belegte lokale Prüfung

**3.103 Frontendtests**, **3 Backendtests**, **70 PGlite-SQLchecks**, vollständiger Typecheck, Source-Lint mit **0 Fehlern / 117 bestehenden Warnungen**, erfolgreicher Webpack-Produktionsbuild und IDL-Abgleich von **27 generierten Dateien**. Details und Grenzen sind in der Cutover-Dokumentation festgehalten. Keine Live-SQL-Migration, finanzierte Transaktion, bezahlte Provider-Generierung oder bestätigte grüne GitHub-CI ist Bestandteil dieser Abnahme.
