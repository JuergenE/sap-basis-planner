# SAP Basis Jahresplaner

Die SAP Basis Jahresplaner Anwendung ist ein Multi-User-fähiges Planungstool mit SQLite-Backend. Die Anwendung ermöglicht es mehreren Benutzern, die gleiche Datenbank von verschiedenen Computern aus zu nutzen, unterstützt rollenbasierten Zugriff (Admin/User) und bietet eine REST-API für die Verwaltung von Planungsdaten.

## Inhaltsverzeichnis

- [Überblick & Architektur](#überblick--architektur)
- [Installation & Start (Lokal)](#installation--start-lokal)
- [Produktions-Deployment](#produktions-deployment)
- [Benutzerverwaltung & Sicherheit](#benutzerverwaltung--sicherheit)
- [Betrieb & Wartung](#betrieb--wartung)
- [Technische Referenz (API & DB)](#technische-referenz-api--db)
- [Fehlerbehebung](#fehlerbehebung)

---

## Überblick & Architektur

Die Anwendung wurde von einer rein lokalen `localStorage`-Lösung auf eine Client-Server-Architektur umgestellt.

### Logische Architektur

```
┌─────────────────────┐      HTTP/REST      ┌─────────────────────┐
│                     │  ←────────────────→ │                     │
│   React Frontend    │                     │   Express.js API    │
│   (Browser)         │   JSON Responses    │   (Node.js)         │
│                     │                     │   Port 3232         │
20: └─────────────────────┘                     └──────────┬──────────┘
                                                       │
                                                       │ better-sqlite3
                                                       ▼
                                            ┌─────────────────────┐
                                            │                     │
                                            │   SQLite Datenbank  │
                                            │   (sap-planner.db)  │
                                            │                     │
                                            └─────────────────────┘
```

### Deployment-Architektur

In einer Produktionsumgebung greifen mehrere Clients über das Netzwerk auf den Server zu.

```
┌─────────────────┐     ┌─────────────────┐
│   Client 1      │     │   Client 2      │ ...
│ (Browser/HTML)  │     │ (Browser/HTML)  │
└────────┬────────┘     └────────┬────────┘
         │                       │
         └───────────┬───────────┘
                     │
        ┌────────────▼────────────┐
        │     Server Machine      │
        │  ┌──────────────────┐   │
        │  │   Node.js API    │   │
        │  │   Port: 3232     │   │
        │  └────────┬─────────┘   │
        │           │             │
        │  ┌────────▼─────────┐   │
        │  │   SQLite DB      │   │
        │  └──────────────────┘   │
        └─────────────────────────┘
```

### Dateistruktur

```
Planung mit DB/
├── README.md              # Diese Dokumentation
├── sap-planner.html       # Frontend (React)
├── server.js              # Backend-Server (Node.js/Express)
├── manage-users.js        # CLI-Tool für Benutzerverwaltung
├── package.json           # npm-Projektdatei
├── sap-planner.db         # SQLite-Datenbank (wird automatisch erstellt)
└── node_modules/          # npm-Abhängigkeiten
```

---

## Installation & Start (Lokal)

Voraussetzung: Node.js Version 24 oder höher (LTS).

1. **Projektverzeichnis öffnen:**
   ```bash
   cd "/Pfad/zu/Planung mit DB"
   ```

2. **Abhängigkeiten installieren:**
   ```bash
   npm install
   ```

3. **Server starten:**
   ```bash
   npm start
   # Oder für Entwicklung mit Auto-Reload:
   npm run dev
   ```
   Der Server startet auf **http://localhost:3232**.

4. **Anwendung öffnen:**
   Öffnen Sie `http://localhost:3232` im Browser.

---

## Produktions-Deployment

Für den dauerhaften Betrieb auf einem Server (Windows, Linux, macOS) im Netzwerk.

### 1. Server vorbereiten
Kopieren Sie folgende Dateien in ein Verzeichnis auf dem Server (z.B. `/opt/sap-basis-planner`):
- `server.js`
- `package.json`
- `sap-planner.html` (optional, zum Hosten über den Server)

Führen Sie im Serververzeichnis `npm install` aus.

### 2. Server als Dienst starten (PM2)
Es wird empfohlen, `pm2` zu verwenden, damit der Server nach Abstürzen oder Neustarts automatisch wieder hochfährt.

```bash
# PM2 installieren
npm install -g pm2

# Server starten
pm2 start server.js --name "sap-planner"

# Autostart bei Systemstart einrichten
pm2 startup
pm2 save
```

### 3. Firewall konfigurieren
Stellen Sie sicher, dass Port `3232` (TCP) erreichbar ist.

*   **Linux (ufw):** `sudo ufw allow 3232/tcp`
*   **Windows:** Neue eingehende Regel für Port 3232 TCP erstellen.

### 4. Client-Konfiguration (Frontend)
Damit die Clients den Server finden, muss die `sap-planner.html` angepasst werden.

1.  Öffnen Sie `sap-planner.html` in einem Editor.
2.  Suchen Sie die Zeile `this.baseUrl = ...` (ca. Zeile 86).
3.  Ändern Sie die URL auf die IP-Adresse oder den Hostnamen des Servers:
    ```javascript
    // Produktion:
    this.baseUrl = 'http://192.168.1.100:3232';
    // Oder:
    this.baseUrl = 'http://sap-planner.firma.local:3232';
    ```
4.  Verteilen Sie die angepasste HTML-Datei an die Benutzer oder hosten Sie sie zentral.

---

## Benutzerverwaltung & Sicherheit

### Benutzerrollen

| Rolle | Beschreibung | Berechtigungen |
|-------|--------------|----------------|
| **admin** | Administrator | Lesen, Schreiben, Benutzerverwaltung, Einstellungen |
| **user** | Standard-Benutzer | Nur Lesezugriff |

### Initialer Login
*   **User:** `admin`
*   **Passwort:** `buek45$d4R`
*   > ⚠️ **Wichtig:** Bitte ändern Sie das Passwort sofort nach dem ersten Login ("Profil" Icon oben rechts -> "Passwort ändern").

### CLI-Tool: `manage-users.js`
Sie können Benutzer auch über die Kommandozeile verwalten (ohne laufenden Server).

```bash
# Benutzer erstellen
node manage-users.js add <username> <password> <role>

# Alle Benutzer anzeigen
node manage-users.js list

# Benutzer löschen
node manage-users.js delete <username>
```

### Sicherheitsempfehlungen
1.  **HTTPS aktivieren:** In Produktion sollte ein Reverse Proxy (z.B. Nginx) verwendet werden, um SSL-Verschlüsselung bereitzustellen.
2.  **Passwörter:** Nutzen Sie starke Passwörter. Diese werden sicher mit `bcrypt` gehasht gespeichert.

---

## Betrieb & Wartung

### Backup
Die gesamte Datenbank ist eine einzelne Datei: `sap-planner.db`.

**Manuelles Backup:**
```bash
cp sap-planner.db sap-planner-backup.db
```

**Automatisches Backup (Cron Beispiel):**
```bash
0 2 * * * cp /opt/sap-basis-planner/sap-planner.db /backup/sap-planner-$(date +\%Y\%m\%d).db
```

### Server Monitoring
Status prüfen oder Logs einsehen:
```bash
pm2 status
pm2 logs sap-planner
```

---

## Technische Referenz (API & DB)

### Datenbankschema (Auszug)
*   **users:** `id, username, password_hash, role`
*   **landscapes:** `id, name, sort_order`
*   **sids:** `id, landscape_id, name, is_prd`
*   **activities:** `sid_id, type_id, start_date, duration`
*   **logs:** Audit-Log aller Aktionen.

### API Endpoints

| Method | Endpoint | Beschreibung |
|--------|----------|--------------|
| **Auth** | | |
| POST | `/api/auth/login` | Login |
| GET | `/api/auth/me` | Aktueller User Info |
| **Settings** | | |
| GET | `/api/settings` | Einstellungen lesen |
| PUT | `/api/settings` | Einstellungen schreiben (Admin) |
| **Data** | | |
| GET | `/api/landscapes` | Lädt alle Daten (Landschaften, SIDs, Aktivitäten) |
| POST | `/api/activities` | Neue Aktivität (Admin) |
| POST | `/api/import/json` | Import von Legacy JSON-Daten (Admin) |

(Vollständige API-Liste siehe Quellcode `server.js`)

---

## Fehlerbehebung

| Problem | Lösung |
|---------|--------|
| **Keine Verbindung zum Server** | Firewall prüfen; Läuft der Server (`pm2 status`)?; Stimmt die IP in `sap-planner.html`? |
| **Login fehlgeschlagen** | Benutzername/Passwort prüfen. Server erreichbar? |
| **"Unexpected token" Fehler** | Server neu starten, falls Code geändert wurde (`pm2 restart`). |
| **Server startet nicht (Port belegt)** | Prüfen mit `lsof -i :3232` und Prozess beenden oder Port in `server.js` ändern. |
| **Datenbank gesperrt** | SQLite erlaubt nur einen Schreiber gleichzeitig. Warten und erneut versuchen. |
| **Passwort vergessen** | Nutzen Sie `node manage-users.js`, um einen neuen Admin-User anzulegen oder das Passwort direkt in der DB zurückzusetzen (Backup!). |

---

© 2026 Optima Solutions GmbH
