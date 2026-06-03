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

  -- Calibration sessions: groups of readings taken at stable temperatures
  CREATE TABLE IF NOT EXISTS calibration_sessions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT,                        -- e.g., 'Indoor baseline', 'Outdoor test'
    reference_temp  REAL,                        -- Independent thermometer reading (°C), or NULL to use mean
    start_time      INTEGER NOT NULL,            -- Unix timestamp (seconds)
    end_time        INTEGER NOT NULL,            -- Unix timestamp (seconds)
    notes           TEXT,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Calibration coefficients: polynomial correction per sensor
  CREATE TABLE IF NOT EXISTS calibration_coefficients (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    unit_id     TEXT NOT NULL UNIQUE,           -- 'a', 'b', 'c'
    degree      INTEGER NOT NULL DEFAULT 2,      -- polynomial degree (2 = quadratic)
    c0          REAL NOT NULL DEFAULT 0,         -- constant term
    c1          REAL NOT NULL DEFAULT 1,         -- linear term
    c2          REAL DEFAULT 0,                  -- quadratic term
    c3          REAL DEFAULT 0,                  -- cubic term (future)
    computed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    num_points  INTEGER,                         -- how many calibration points used
    rmse        REAL,                            -- root mean square error
    
    CHECK (unit_id IN ('a', 'b', 'c')),
    CHECK (degree >= 1 AND degree <= 3)
  );
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

// ── Calibration functions ─────────────────────────────────────────────────────

/**
 * Create a calibration session
 * @param {Object} session
 * @param {string} [session.name] - Session name
 * @param {number|null} [session.referenceTemp] - Independent reference temperature in °C (null = use mean)
 * @param {number} session.startTime - Unix timestamp (seconds)
 * @param {number} session.endTime - Unix timestamp (seconds)
 * @param {string} [session.notes] - Notes about the session
 * @returns {Object} Result with lastInsertRowid
 */
function createCalibrationSession({ name, referenceTemp, startTime, endTime, notes }) {
    return db.prepare(`
        INSERT INTO calibration_sessions (name, reference_temp, start_time, end_time, notes)
        VALUES (?, ?, ?, ?, ?)
    `).run(name || null, referenceTemp ?? null, startTime, endTime, notes || null);
}

/**
 * Get all calibration sessions
 * @returns {Array} Array of calibration sessions
 */
function getCalibrationSessions() {
    return db.prepare(`
        SELECT id, name, reference_temp, start_time, end_time, notes, created_at
        FROM calibration_sessions
        ORDER BY start_time DESC
    `).all();
}

/**
 * Get a specific calibration session
 * @param {number} sessionId
 * @returns {Object|undefined} Calibration session
 */
function getCalibrationSession(sessionId) {
    return db.prepare(`
        SELECT id, name, reference_temp, start_time, end_time, notes, created_at
        FROM calibration_sessions
        WHERE id = ?
    `).get(sessionId);
}

/**
 * Delete a calibration session
 * @param {number} sessionId
 */
function deleteCalibrationSession(sessionId) {
    return db.prepare(`DELETE FROM calibration_sessions WHERE id = ?`).run(sessionId);
}

/**
 * Get readings for calibration sessions (grouped by session and unit)
 * @returns {Array} Array of {session_id, unit_id, temps: [array of temps]}
 */
function getCalibrationData() {
    const sessions = getCalibrationSessions();
    const result = [];
    
    for (const session of sessions) {
        const readings = db.prepare(`
            SELECT unit_id, temp_c
            FROM temperature_readings
            WHERE timestamp >= ? AND timestamp <= ? AND temp_c IS NOT NULL
            ORDER BY unit_id, timestamp
        `).all(session.start_time, session.end_time);
        
        // Group by unit_id
        const byUnit = {};
        for (const r of readings) {
            if (!byUnit[r.unit_id]) byUnit[r.unit_id] = [];
            byUnit[r.unit_id].push(r.temp_c);
        }
        
        // Calculate mean for each unit in this session
        for (const [unitId, temps] of Object.entries(byUnit)) {
            const mean = temps.reduce((a, b) => a + b, 0) / temps.length;
            result.push({
                session_id: session.id,
                session_name: session.name,
                reference_temp: session.reference_temp,
                unit_id: unitId,
                mean_temp: mean,
                count: temps.length,
                temps,
            });
        }
    }
    
    return result;
}

/**
 * Get readings within a time range for all units (for calibration)
 * @param {number} startTime - Unix timestamp (seconds)
 * @param {number} endTime - Unix timestamp (seconds)
 * @returns {Object} { a: [temps], b: [temps], c: [temps] }
 */
function getReadingsInRange(startTime, endTime) {
    const readings = db.prepare(`
        SELECT unit_id, temp_c
        FROM temperature_readings
        WHERE timestamp >= ? AND timestamp <= ? AND temp_c IS NOT NULL
        ORDER BY unit_id, timestamp
    `).all(startTime, endTime);
    
    const result = { a: [], b: [], c: [] };
    for (const r of readings) {
        result[r.unit_id].push(r.temp_c);
    }
    
    return result;
}

// Memory cache for calibration coefficients to avoid high-frequency SQLite queries during history processing
let coeffsCache = null;

function loadCoefficientsCache() {
    try {
        const rows = db.prepare(`
            SELECT unit_id, degree, c0, c1, c2, c3, computed_at, num_points, rmse
            FROM calibration_coefficients
        `).all();
        coeffsCache = { a: null, b: null, c: null };
        for (const row of rows) {
            coeffsCache[row.unit_id] = row;
        }
    } catch (err) {
        console.error('[db] Failed to load coefficients cache:', err);
        coeffsCache = { a: null, b: null, c: null };
    }
}

function getCachedCalibrationCoefficients(unitId) {
    if (!coeffsCache) {
        loadCoefficientsCache();
    }
    return coeffsCache[unitId];
}

/**
 * Save calibration coefficients for a unit
 * @param {Object} coeffs
 * @param {string} coeffs.unitId - 'a', 'b', or 'c'
 * @param {number} coeffs.degree - Polynomial degree (1, 2, or 3)
 * @param {number} coeffs.c0 - Constant term
 * @param {number} coeffs.c1 - Linear term
 * @param {number} [coeffs.c2] - Quadratic term
 * @param {number} [coeffs.c3] - Cubic term
 * @param {number} [coeffs.numPoints] - Number of calibration points used
 * @param {number} [coeffs.rmse] - Root mean square error
 */
function saveCalibrationCoefficients({ unitId, degree, c0, c1, c2, c3, numPoints, rmse }) {
    const result = db.prepare(`
        INSERT INTO calibration_coefficients (unit_id, degree, c0, c1, c2, c3, num_points, rmse, computed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(unit_id) DO UPDATE SET
            degree = excluded.degree,
            c0 = excluded.c0,
            c1 = excluded.c1,
            c2 = excluded.c2,
            c3 = excluded.c3,
            num_points = excluded.num_points,
            rmse = excluded.rmse,
            computed_at = CURRENT_TIMESTAMP
    `).run(unitId, degree, c0, c1, c2 || 0, c3 || 0, numPoints || null, rmse || null);
    
    loadCoefficientsCache();
    return result;
}

/**
 * Get calibration coefficients for a unit
 * @param {string} unitId - 'a', 'b', or 'c'
 * @returns {Object|undefined} { unit_id, degree, c0, c1, c2, c3, computed_at, num_points, rmse }
 */
function getCalibrationCoefficients(unitId) {
    return getCachedCalibrationCoefficients(unitId);
}

/**
 * Get all calibration coefficients
 * @returns {Object} { a: {...}, b: {...}, c: {...} }
 */
function getAllCalibrationCoefficients() {
    if (!coeffsCache) {
        loadCoefficientsCache();
    }
    return { ...coeffsCache };
}

/**
 * Apply calibration to a temperature reading
 * @param {string} unitId - 'a', 'b', or 'c'
 * @param {number} rawTemp - Raw temperature in °C
 * @returns {number|null} Calibrated temperature, or null if no calibration available
 */
function applyCalibratedTemp(unitId, rawTemp) {
    if (rawTemp === null || rawTemp === undefined) return null;
    
    const coeffs = getCachedCalibrationCoefficients(unitId);
    if (!coeffs) return rawTemp; // No calibration available
    
    // T_corrected = c0 + c1*T + c2*T^2 + c3*T^3
    const { c0, c1, c2, c3, degree } = coeffs;
    let corrected = c0 + c1 * rawTemp;
    if (degree >= 2) corrected += c2 * rawTemp * rawTemp;
    if (degree >= 3) corrected += c3 * rawTemp * rawTemp * rawTemp;
    
    return corrected;
}

/**
 * Delete calibration coefficients for a unit
 * @param {string} unitId - 'a', 'b', or 'c'
 */
function deleteCalibrationCoefficients(unitId) {
    const result = db.prepare(`DELETE FROM calibration_coefficients WHERE unit_id = ?`).run(unitId);
    loadCoefficientsCache();
    return result;
}

/**
 * Clear all calibration coefficients at once
 */
function clearAllCalibrationCoefficients() {
    const result = db.prepare(`DELETE FROM calibration_coefficients`).run();
    loadCoefficientsCache();
    return result;
}

// ── Export ────────────────────────────────────────────────────────────────────
module.exports = {
    insertReading,
    getRecentReadings,
    getUnitReadings,
    getLatestReadings,
    getUnitStats,
    cleanupOldReadings,
    
    // Calibration exports
    createCalibrationSession,
    getCalibrationSessions,
    getCalibrationSession,
    deleteCalibrationSession,
    getCalibrationData,
    getReadingsInRange,
    saveCalibrationCoefficients,
    getCalibrationCoefficients,
    getAllCalibrationCoefficients,
    applyCalibratedTemp,
    deleteCalibrationCoefficients,
    clearAllCalibrationCoefficients,
    
    db, // Export raw db for custom queries if needed
};
