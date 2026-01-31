const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, 'planner.db');
const db = new Database(dbPath);

try {
    const tableInfo = db.prepare("PRAGMA table_info(landscapes)").all();
    console.log("Columns in landscapes table:");
    tableInfo.forEach(col => {
        console.log(`- ${col.name} (${col.type})`);
    });

    const hasSortOrder = tableInfo.some(col => col.name === 'sort_order');
    if (hasSortOrder) {
        console.log("\nSUCCESS: sort_order column exists.");
    } else {
        console.log("\nFAILURE: sort_order column MISSING.");
    }
} catch (err) {
    console.error("Error inspecting database:", err);
}
