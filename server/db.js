'use strict';
/**
 * Database abstraction layer for temperature logging
 * 
 * Current implementation: SQLite (better-sqlite3)
 * 
 * TO MIGRATE TO POSTGRESQL:
 *   1. Replace better-sqlite3 with 'pg' package
 *   2. Update connection to use pool: const { Pool } = require('pg'); const pool = new Pool({...})
 *   3. Replace db.prepare() with pool.query()
 *   4. Replace .run() with await pool.query(sql, params)
 *   5. Replace .all() with (await pool.query(sql, params)).rows
 *   6. Replace .get() with (await pool.query(sql, params)).rows[0]
 * 
 * TO MIGRATE TO MYSQL:
 *   1. Replace better-sqlite3 with 'mysql2/promise'
 *   2. Update connection: const mysql = require('mysql2/promise'); const pool = mysql.createPool({...})
 *   3. Replace AUTOINCREMENT with AUTO_INCREMENT in schema
 *   4. Replace ? placeholders with ? (same)
 *   5. Replace db.prepare().run() with await pool.execute()
 */

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'temperatures.db');
const db = new Database(DB_PATH);

// Enable foreign keys and WAL mode for better concurrency
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');

// ── Schema ────────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS temperature_readings (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    unit_id    TEXT NOT NULL,           -- 'a', 'b', 'c'
    unit_name  TEXT NOT NULL,           -- 'Unit A (DHT22)', etc.
    temp_c     REAL,                    -- null if sensor failed
    humidity   INTEGER,                 -- null if sensor failed
    timestamp  INTEGER NOT NULL,        -- Unix timestamp (seconds)
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    
    CHECK (unit_id IN ('a', 'b', 'c')),
    CHECK (temp_c IS NULL OR (temp_c >= -50 AND temp_c <= 100)),
    CHECK (humidity IS NULL OR (humidity >= 0 AND humidity <= 100))
  );

  CREATE INDEX IF NOT EXISTS idx_readings_unit_time 
    ON temperature_readings(unit_id, timestamp DESC);
  
  CREATE INDEX IF NOT EXISTS idx_readings_time 
    ON temperature_readings(timestamp DESC);
`);

console.log(`[db] SQLite initialized at ${DB_PATH}`);

// ── Insert reading ────────────────────────────────────────────────────────────
const insertStmt = db.prepare(`
  INSERT INTO temperature_readings (unit_id, unit_name, temp_c, humidity, timestamp)
  VALUES (?, ?, ?, ?, ?)
`);

/**
 * Insert a temperature reading
 * @param {Object} reading
 * @param {string} reading.unitId - 'a', 'b', or 'c'
 * @param {string} reading.unitName - 'Unit A (DHT22)', etc.
 * @param {number|null} reading.tempC - Temperature in Celsius (null if sensor failed)
 * @param {number|null} reading.humidity - Humidity percentage (null if sensor failed)
 * @param {number} [reading.timestamp] - Unix timestamp in seconds (defaults to now)
 */
function insertReading({ unitId, unitName, tempC, humidity, timestamp }) {
    const ts = timestamp || Math.floor(Date.now() / 1000);
    return insertStmt.run(unitId, unitName, tempC, humidity, ts);
}

// ── Query readings ────────────────────────────────────────────────────────────
/**
 * Get recent readings for all units
 * @param {Object} options
 * @param {number} [options.hours=24] - How many hours back to fetch
 * @param {number} [options.limit=1000] - Max rows to return
 * @returns {Array} Array of {id, unit_id, unit_name, temp_c, humidity, timestamp, created_at}
 */
function getRecentReadings({ hours = 24, limit = 1000 } = {}) {
    const cutoff = Math.floor(Date.now() / 1000) - (hours * 3600);
    return db.prepare(`
        SELECT id, unit_id, unit_name, temp_c, humidity, timestamp, created_at
        FROM temperature_readings
        WHERE timestamp >= ?
        ORDER BY timestamp ASC
        LIMIT ?
    `).all(cutoff, limit);
}

/**
 * Get recent readings for a specific unit
 * @param {string} unitId - 'a', 'b', or 'c'
 * @param {Object} options
 * @param {number} [options.hours=24] - How many hours back to fetch
 * @param {number} [options.limit=500] - Max rows to return
 */
function getUnitReadings(unitId, { hours = 24, limit = 500 } = {}) {
    const cutoff = Math.floor(Date.now() / 1000) - (hours * 3600);
    return db.prepare(`
        SELECT id, unit_id, unit_name, temp_c, humidity, timestamp, created_at
        FROM temperature_readings
        WHERE unit_id = ? AND timestamp >= ?
        ORDER BY timestamp ASC
        LIMIT ?
    `).all(unitId, cutoff, limit);
}

/**
 * Get the latest reading for each unit
 * @returns {Object} { a: {...}, b: {...}, c: {...} }
 */
function getLatestReadings() {
    const rows = db.prepare(`
        SELECT unit_id, unit_name, temp_c, humidity, timestamp, created_at
        FROM temperature_readings
        WHERE id IN (
            SELECT MAX(id)
            FROM temperature_readings
            GROUP BY unit_id
        )
    `).all();
    
    const result = {};
    for (const row of rows) {
        result[row.unit_id] = row;
    }
    return result;
}

/**
 * Get statistics for a unit over a time period
 * @param {string} unitId
 * @param {number} hours
 */
function getUnitStats(unitId, hours = 24) {
    const cutoff = Math.floor(Date.now() / 1000) - (hours * 3600);
    return db.prepare(`
        SELECT 
            COUNT(*) as count,
            AVG(temp_c) as avg_temp,
            MIN(temp_c) as min_temp,
            MAX(temp_c) as max_temp,
            AVG(humidity) as avg_humidity
        FROM temperature_readings
        WHERE unit_id = ? AND timestamp >= ? AND temp_c IS NOT NULL
    `).get(unitId, cutoff);
}

/**
 * Delete old readings (for cleanup)
 * @param {number} daysToKeep - Keep readings from last N days
 */
function cleanupOldReadings(daysToKeep = 30) {
    const cutoff = Math.floor(Date.now() / 1000) - (daysToKeep * 86400);
    const result = db.prepare(`
        DELETE FROM temperature_readings WHERE timestamp < ?
    `).run(cutoff);
    return result.changes;
}

// ── Export ────────────────────────────────────────────────────────────────────
module.exports = {
    insertReading,
    getRecentReadings,
    getUnitReadings,
    getLatestReadings,
    getUnitStats,
    cleanupOldReadings,
    db, // Export raw db for custom queries if needed
};
