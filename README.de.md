# SIGNAL – Launch-Readiness-Gate

**Erst prüfen. Dann starten.** SIGNAL ist ein kleines, selbst gehostetes Werkzeug. Es sagt einem Team, ob eine Kampagne, ein Formular oder eine Prozessübergabe live gehen darf: **GO**, **BLOCKED** oder **NEEDS REVIEW**. Die Antwort beruht auf deterministischen Prüfungen, einer namentlichen Freigabe und einem lückenlosen Protokoll. Sie ist keine Prognose.

[English version](README.md)

## Schnellstart

```bash
node bin/signal.js serve --demo
```

Öffne http://127.0.0.1:8080. Das Passwort für die Demo-Nutzer ist `demo-password-123`. Das Demo-CRM verliert ein Pflichtfeld, deshalb startet der Beispiel-Launch mit **BLOCKED**. Klicke auf „Demo-CRM-Mapping umschalten“ und danach auf „Alle automatischen Prüfungen ausführen“. Der Status wechselt dann zu **NEEDS REVIEW**. Melde dich als `sam@example.test` an und gib den Launch frei, um **GO** zu erhalten.

## Installation im Team

```bash
node bin/signal.js init        # erzeugt signal.config.json
node bin/signal.js serve --config signal.config.json --host 0.0.0.0
```

Alternativ mit Docker: `docker compose up -d`. Für den Betrieb hinter HTTPS setze `SIGNAL_SECURE_COOKIES=1`.

Voraussetzung ist Node.js 22.13 oder neuer. SIGNAL hat keine weiteren Abhängigkeiten, und die Daten bleiben auf eurem Server.

## Regeln in einem Satz

Kritische Prüfungen, die fehlschlagen, unbekannt, ungeprüft oder zu alt sind, ergeben **BLOCKED**. Offene nicht-kritische Lücken und fehlende, veraltete, abgelaufene oder selbst erteilte Freigaben ergeben **NEEDS REVIEW**. Nur alles bestanden plus eine gültige Freigabe für genau diese Version ergibt **GO**.

Alle weiteren Details (Prüftypen, Konfiguration, CI-Gate, Rollen, Sicherheit) stehen in der [englischen README](README.md).

## Personalisierung

Name, Farbe, Kürzel, Standardsprache, Regelparameter und Prüfvorlagen werden in `signal.config.json` festgelegt. Nach einer Änderung muss der Server neu gestartet werden.
