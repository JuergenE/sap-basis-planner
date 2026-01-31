const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, 'sap-planner.db');
const db = new Database(dbPath);

console.log("Attempting to add sort_order column to landscapes table...");

try {
    db.exec("ALTER TABLE landscapes ADD COLUMN sort_order INTEGER DEFAULT 0");
    console.log("SUCCESS: sort_order column added.");
} catch (err) {
    if (err.message.includes("duplicate column")) {
        console.log("INFO: sort_order column already exists.");
    } else {
        console.error("FAILURE: Could not add column.", err);
    }
}

// Verify again
try {
    const tableInfo = db.prepare("PRAGMA table_info(landscapes)").all();
    const hasSortOrder = tableInfo.some(col => col.name === 'sort_order');
    if (hasSortOrder) {
        console.log("VERIFICATION: Column is present.");
    } else {
        console.log("VERIFICATION: Column is STILL MISSING.");
    }
} catch (err) {
    console.error("Verification error:", err);
}
