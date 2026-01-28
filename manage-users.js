/**
 * Benutzer-Verwaltung für SAP Basis Jahresplaner
 * 
 * Verwendung:
 *   node manage-users.js add <username> <password> <role>
 *   node manage-users.js list
 *   node manage-users.js delete <username>
 * 
 * Rollen: admin (Schreibzugriff), user (nur Lesezugriff)
 */

const bcrypt = require('bcrypt');
const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'sap-planner.db'));

const command = process.argv[2];

switch (command) {
    case 'add': {
        const username = process.argv[3];
        const password = process.argv[4];
        const role = process.argv[5] || 'user';

        if (!username || !password) {
            console.log('Verwendung: node manage-users.js add <username> <password> [admin|user]');
            process.exit(1);
        }

        if (!['admin', 'user'].includes(role)) {
            console.log('Rolle muss "admin" oder "user" sein');
            process.exit(1);
        }

        try {
            const hash = bcrypt.hashSync(password, 10);
            db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run(username, hash, role);
            console.log(`✅ Benutzer "${username}" mit Rolle "${role}" erstellt!`);
        } catch (e) {
            console.log(`❌ Fehler: Benutzer "${username}" existiert bereits`);
        }
        break;
    }

    case 'list': {
        const users = db.prepare('SELECT id, username, role, created_at FROM users ORDER BY id').all();
        console.log('\n📋 Benutzer:');
        console.log('─'.repeat(50));
        users.forEach(u => {
            console.log(`  ${u.id}. ${u.username} (${u.role}) - erstellt: ${u.created_at}`);
        });
        console.log('');
        break;
    }

    case 'delete': {
        const username = process.argv[3];
        if (!username) {
            console.log('Verwendung: node manage-users.js delete <username>');
            process.exit(1);
        }
        if (username === 'admin') {
            console.log('❌ Der admin-Benutzer kann nicht gelöscht werden');
            process.exit(1);
        }
        const result = db.prepare('DELETE FROM users WHERE username = ?').run(username);
        if (result.changes > 0) {
            console.log(`✅ Benutzer "${username}" gelöscht`);
        } else {
            console.log(`❌ Benutzer "${username}" nicht gefunden`);
        }
        break;
    }

    default:
        console.log(`
Benutzer-Verwaltung für SAP Basis Jahresplaner

Befehle:
  node manage-users.js add <username> <password> <role>   - Benutzer erstellen
  node manage-users.js list                               - Alle Benutzer anzeigen
  node manage-users.js delete <username>                  - Benutzer löschen

Rollen:
  admin  - Vollzugriff (lesen + schreiben)
  user   - Nur Lesezugriff
`);
}

db.close();
