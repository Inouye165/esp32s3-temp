'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const http      = require('http');
const express   = require('express');
const WebSocket = require('ws');
const db        = require('./db');
const calibration = require('./calibration');

const app    = express();
const PORT   = process.env.PORT   || 3000;
const ESP_IP = process.env.ESP_IP || '';

if (!ESP_IP) {
    console.warn('\n[warn] ESP_IP not set in server/.env — create it with ESP_IP=<unit-a-ip>\n');
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders: (res, path) => {
        if (path.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
        }
    }
}));

// ── HTTP server + WebSocket server on same port ───────────────────────────────
const httpServer = http.createServer(app);
const wss = new WebSocket.Server({ server: httpServer });

// ── Background RSSI polling: fetch from ESP32 every 300 ms, push via WS ───────
let rssiCache = null;

async function pollRssi() {
    if (!ESP_IP) return;
    try {
        const response = await fetch(`http://${ESP_IP}/rssi`,
            { signal: AbortSignal.timeout(800) });
        rssiCache = await response.json();
        const msg = JSON.stringify({ type: 'rssi', data: rssiCache });
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) client.send(msg);
        });
    } catch {
        // ESP32 unreachable — clients keep last known values
    }
}
setInterval(pollRssi, 300);

// Send cached RSSI to newly connected WebSocket clients
wss.on('connection', ws => {
    if (rssiCache) ws.send(JSON.stringify({ type: 'rssi', data: rssiCache }));
});

// ── Background temperature polling: fetch every 5 min, save to DB, push via WS ──
let tempCache = null;

async function pollTemperature() {
    if (!ESP_IP) return;
    
    const timestamp = Math.floor(Date.now() / 1000);
    const readings = {};
    
    // Fetch all three units in parallel
    const units = [
        { id: 'a', name: 'Unit A (DHT22)', endpoint: '/temp_a' },
        { id: 'b', name: 'Unit B (SHT30)', endpoint: '/temp_b' },
        { id: 'c', name: 'Unit C (DHT11)', endpoint: '/temp_c' },
    ];
    
    const promises = units.map(async (unit) => {
        try {
            const response = await fetch(`http://${ESP_IP}${unit.endpoint}`, 
                { signal: AbortSignal.timeout(3000) });
            const data = await response.json();
            
            // Extract temp and humidity (handle various response formats)
            const tempC = data.temp_c ?? data.tempC ?? null;
            const humidity = data.humidity ?? null;
            
            readings[unit.id] = { tempC, humidity, ok: true };
            
            // Save to database
            db.insertReading({
                unitId: unit.id,
                unitName: unit.name,
                tempC,
                humidity,
                timestamp,
            });
            
            return { unit: unit.id, success: true };
        } catch (err) {
            console.error(`[temp poll] ${unit.name} failed: ${err.message}`);
            readings[unit.id] = { tempC: null, humidity: null, ok: false };
            
            // Save null reading to track failures
            db.insertReading({
                unitId: unit.id,
                unitName: unit.name,
                tempC: null,
                humidity: null,
                timestamp,
            });
            
            return { unit: unit.id, success: false };
        }
    });
    
    await Promise.all(promises);
    
    tempCache = { timestamp, readings };
    
    // Push to all WebSocket clients
    const msg = JSON.stringify({ type: 'temperature', data: tempCache });
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) client.send(msg);
    });
    
    console.log(`[temp poll] Logged at ${new Date(timestamp * 1000).toLocaleString()}`);
}

// Poll every 5 minutes (300,000 ms)
setInterval(pollTemperature, 5 * 60 * 1000);

// Poll immediately on startup (after 2 seconds to let ESP32 boot)
setTimeout(pollTemperature, 2000);

// ── Auto-calibration mode state ───────────────────────────────────────────────
// When enabled, the operator places all sensors together (same true temperature)
// and clicks "Capture Point" in the UI to instantly record a calibration session.
// Each capture triggers an ESP /sync, samples fresh readings into the DB,
// creates a calibration_sessions row, and (optionally) recomputes coefficients.
const autoCal = {
    enabled: false,
    degree: 1,                  // 1 = linear (best for 2-3 points), 2 = quadratic (5+ points)
    autoRecompute: true,
    captureWindowSec: 90,       // how far back to average sensor readings for one capture
    startedAt: null,
};

// Trigger ESP /sync (forces all three units to read simultaneously)
async function triggerEspSync() {
    if (!ESP_IP) throw new Error('ESP_IP not configured');
    const url = `http://${ESP_IP}/sync`;
    const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw new Error(`ESP /sync returned ${response.status}`);
    return response.text();
}

// Capture N fresh samples spaced delayMs apart, persisting each to the DB.
// Returns array of {ts, readings: {a, b, c}} so the caller can summarise.
async function captureFreshSamples({ samples = 3, delayMs = 1500 } = {}) {
    const collected = [];
    for (let i = 0; i < samples; i++) {
        if (i > 0) await new Promise(r => setTimeout(r, delayMs));
        const ts = Math.floor(Date.now() / 1000);
        const units = [
            { id: 'a', name: 'Unit A (DHT22)', endpoint: '/temp_a' },
            { id: 'b', name: 'Unit B (SHT30)', endpoint: '/temp_b' },
            { id: 'c', name: 'Unit C (DHT11)', endpoint: '/temp_c' },
        ];
        const readings = {};
        await Promise.all(units.map(async (u) => {
            try {
                const r = await fetch(`http://${ESP_IP}${u.endpoint}`, { signal: AbortSignal.timeout(2500) });
                const data = await r.json();
                const tempC = data.temp_c ?? data.tempC ?? null;
                const humidity = data.humidity ?? null;
                readings[u.id] = tempC;
                db.insertReading({ unitId: u.id, unitName: u.name, tempC, humidity, timestamp: ts });
            } catch (err) {
                readings[u.id] = null;
            }
        }));
        collected.push({ ts, readings });
    }
    return collected;
}

// ── REST endpoints ────────────────────────────────────────────────────────────
app.get('/api/info', (_req, res) => {
    res.json({
        unitA: {
            mac: 'a4:cb:8f:d1:ef:58',
            ip: ESP_IP || 'not configured',
            port: 'COM12',
            sensor: 'DHT22',
            role: 'hub',
            transport: 'WiFi + ESP-NOW',
        },
        unitB: {
            mac: 'a4:cb:8f:d1:f2:a8',
            ip: null,
            port: 'COM11',
            sensor: 'SHT30',
            role: 'sensor',
            transport: 'ESP-NOW (ch 11)',
        },
        unitC: {
            mac: 'a4:cb:8f:d1:ef:a0',
            ip: null,
            port: 'COM14',
            sensor: 'DHT11',
            role: 'sensor',
            transport: 'ESP-NOW (ch 11)',
        },
    });
});

app.get('/api/rssi', (_req, res) => {
    if (!ESP_IP) return res.status(503).json({ ok: false, message: 'ESP_IP not configured' });
    if (rssiCache) return res.json({ ok: true, ...rssiCache });
    res.json({ ok: false, message: 'No data yet' });
});

function validateRgb(r, g, b) {
    return [r, g, b].every(v => Number.isInteger(v) && v >= 0 && v <= 255);
}

async function callEsp(espPath, r, g, b, res) {
    if (!ESP_IP) {
        return res.status(503).json({ ok: false, message: 'ESP_IP not configured' });
    }
    const url = `http://${ESP_IP}/${espPath}?r=${r}&g=${g}&b=${b}`;
    try {
        const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
        const text     = await response.text();
        console.log(`-> ${url}  [${response.status}] ${text.trim()}`);
        res.json({ ok: response.ok, message: text.trim() });
    } catch (err) {
        console.error(`[esp error] ${err.message}`);
        res.status(503).json({ ok: false, message: `ESP32 unreachable -- ${err.message}` });
    }
}

app.post('/api/color/a', async (req, res) => {
    const { r, g, b } = req.body;
    if (!validateRgb(r, g, b)) return res.status(400).json({ ok: false, message: 'r, g, b must be integers 0-255' });
    await callEsp('color', r, g, b, res);
});

app.post('/api/color/b', async (req, res) => {
    const { r, g, b } = req.body;
    if (!validateRgb(r, g, b)) return res.status(400).json({ ok: false, message: 'r, g, b must be integers 0-255' });
    await callEsp('forward', r, g, b, res);
});

app.post('/api/color/c', async (req, res) => {
    const { r, g, b } = req.body;
    if (!validateRgb(r, g, b)) return res.status(400).json({ ok: false, message: 'r, g, b must be integers 0-255' });
    await callEsp('forward_c', r, g, b, res);
});

app.get('/api/temp_a', async (_req, res) => {
    if (!ESP_IP) return res.status(503).json({ ok: false, message: 'ESP_IP not configured' });
    const url = `http://${ESP_IP}/temp_a`;
    try {
        const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
        const data     = await response.json();
        res.json(data);
    } catch (err) {
        res.status(503).json({ ok: false, message: `ESP32 unreachable -- ${err.message}` });
    }
});

app.get('/api/temp_b', async (_req, res) => {
    if (!ESP_IP) return res.status(503).json({ ok: false, message: 'ESP_IP not configured' });
    const url = `http://${ESP_IP}/temp_b`;
    try {
        const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
        const data     = await response.json();
        res.json(data);
    } catch (err) {
        res.status(503).json({ ok: false, message: `ESP32 unreachable -- ${err.message}` });
    }
});

app.get('/api/temp_c', async (_req, res) => {
    if (!ESP_IP) return res.status(503).json({ ok: false, message: 'ESP_IP not configured' });
    const url = `http://${ESP_IP}/temp_c`;
    try {
        const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
        const data     = await response.json();
        res.json(data);
    } catch (err) {
        res.status(503).json({ ok: false, message: `ESP32 unreachable -- ${err.message}` });
    }
});

// Alias for backward compat
app.get('/api/temp', async (_req, res) => {
    if (!ESP_IP) return res.status(503).json({ ok: false, message: 'ESP_IP not configured' });
    const url = `http://${ESP_IP}/temp`;
    try {
        const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
        const data     = await response.json();
        res.json(data);
    } catch (err) {
        res.status(503).json({ ok: false, message: `ESP32 unreachable -- ${err.message}` });
    }
});

// ── Temperature history endpoints ─────────────────────────────────────────────
app.get('/api/temperature/history', (req, res) => {
    const hours = parseInt(req.query.hours) || 24;
    const limit = parseInt(req.query.limit) || 1000;
    
    try {
        const readings = db.getRecentReadings({ hours, limit });
        res.json({ ok: true, count: readings.length, readings });
    } catch (err) {
        console.error('[api] /temperature/history error:', err);
        res.status(500).json({ ok: false, message: err.message });
    }
});

app.get('/api/temperature/latest', (_req, res) => {
    try {
        const latest = db.getLatestReadings();
        res.json({ ok: true, readings: latest });
    } catch (err) {
        console.error('[api] /temperature/latest error:', err);
        res.status(500).json({ ok: false, message: err.message });
    }
});

app.get('/api/temperature/stats/:unitId', (req, res) => {
    const { unitId } = req.params;
    const hours = parseInt(req.query.hours) || 24;
    
    if (!['a', 'b', 'c'].includes(unitId)) {
        return res.status(400).json({ ok: false, message: 'unitId must be a, b, or c' });
    }
    
    try {
        const stats = db.getUnitStats(unitId, hours);
        res.json({ ok: true, unitId, hours, stats });
    } catch (err) {
        console.error(`[api] /temperature/stats/${unitId} error:`, err);
        res.status(500).json({ ok: false, message: err.message });
    }
});

app.get('/api/temperature/unit/:unitId', (req, res) => {
    const { unitId } = req.params;
    const hours = parseInt(req.query.hours) || 24;
    const limit = parseInt(req.query.limit) || 500;
    
    if (!['a', 'b', 'c'].includes(unitId)) {
        return res.status(400).json({ ok: false, message: 'unitId must be a, b, or c' });
    }
    
    try {
        const readings = db.getUnitReadings(unitId, { hours, limit });
        res.json({ ok: true, unitId, count: readings.length, readings });
    } catch (err) {
        console.error(`[api] /temperature/unit/${unitId} error:`, err);
        res.status(500).json({ ok: false, message: err.message });
    }
});

// ── Calibration endpoints ─────────────────────────────────────────────────────

// ── Auto-Sync Calibration Mode ────────────────────────────────────────────────
// Workflow:
//   1. Place all 3 sensors together (same true temperature).
//   2. POST /api/calibration/automode { enabled: true }
//   3. POST /api/calibration/capture   (one click, optionally with a label)
//   4. Move the cluster to a new temperature, wait for stabilisation, repeat.
//   5. After 2+ captures (linear) or 5+ (quadratic) the polynomial auto-fits
//      and per-unit coefficients are saved.
app.get('/api/calibration/automode', (_req, res) => {
    // Include a quick coverage summary so the UI can guide the user.
    let coverage = null;
    try {
        const sessions = db.getCalibrationSessions();
        const calibData = db.getCalibrationData();
        // Per-session mean across all units (= the "true temp" at that point,
        // since they were colocated). Useful to show range.
        const sessionMeans = {};
        for (const p of calibData) {
            if (!sessionMeans[p.session_id]) sessionMeans[p.session_id] = [];
            sessionMeans[p.session_id].push(p.mean_temp);
        }
        const points = Object.values(sessionMeans).map(arr => arr.reduce((a, b) => a + b, 0) / arr.length);
        if (points.length > 0) {
            const min = Math.min(...points);
            const max = Math.max(...points);
            coverage = {
                numPoints: sessions.length,
                minC: min,
                maxC: max,
                rangeC: max - min,
                minF: min * 9 / 5 + 32,
                maxF: max * 9 / 5 + 32,
            };
        } else {
            coverage = { numPoints: 0, minC: null, maxC: null, rangeC: 0, minF: null, maxF: null };
        }
    } catch (err) {
        coverage = { error: err.message };
    }
    res.json({ ok: true, mode: autoCal, coverage });
});

app.post('/api/calibration/automode', (req, res) => {
    const { enabled, degree, autoRecompute, captureWindowSec } = req.body || {};
    if (typeof enabled === 'boolean') {
        if (enabled && !autoCal.enabled) autoCal.startedAt = Date.now();
        if (!enabled) autoCal.startedAt = null;
        autoCal.enabled = enabled;
    }
    if (degree === 1 || degree === 2 || degree === 3) autoCal.degree = degree;
    if (typeof autoRecompute === 'boolean') autoCal.autoRecompute = autoRecompute;
    if (Number.isFinite(captureWindowSec) && captureWindowSec >= 10 && captureWindowSec <= 600) {
        autoCal.captureWindowSec = captureWindowSec;
    }
    console.log(`[autoCal] mode=${autoCal.enabled} degree=${autoCal.degree} autoRecompute=${autoCal.autoRecompute}`);
    res.json({ ok: true, mode: autoCal });
});

app.post('/api/calibration/capture', async (req, res) => {
    if (!autoCal.enabled) {
        return res.status(400).json({ ok: false, message: 'Auto-Sync mode is OFF. Enable it first.' });
    }
    if (!ESP_IP) {
        return res.status(503).json({ ok: false, message: 'ESP_IP not configured' });
    }
    const { label, referenceTemp, notes } = req.body || {};
    const capturedAt = Math.floor(Date.now() / 1000);
    try {
        // 1. Force a fresh synchronised read on all three units.
        try { await triggerEspSync(); } catch (e) { console.warn(`[capture] /sync warning: ${e.message}`); }
        // Small wait so units B and C respond and Unit A's cache updates.
        await new Promise(r => setTimeout(r, 1500));

        // 2. Pull 3 fresh samples ~1.5s apart and write them straight to the DB.
        const samples = await captureFreshSamples({ samples: 3, delayMs: 1500 });

        // 3. Compute mean per unit from the samples we just captured.
        const perUnit = { a: [], b: [], c: [] };
        for (const s of samples) {
            for (const u of ['a', 'b', 'c']) {
                if (s.readings[u] !== null && s.readings[u] !== undefined) perUnit[u].push(s.readings[u]);
            }
        }
        const means = {};
        for (const u of ['a', 'b', 'c']) {
            means[u] = perUnit[u].length > 0
                ? perUnit[u].reduce((a, b) => a + b, 0) / perUnit[u].length
                : null;
        }
        const validMeans = Object.values(means).filter(v => v !== null);
        if (validMeans.length < 2) {
            return res.status(503).json({
                ok: false,
                message: 'Not enough sensors responded. Check ESP / units B & C are online.',
                means,
            });
        }
        const groupMean = validMeans.reduce((a, b) => a + b, 0) / validMeans.length;

        // 4. Create a calibration session covering the window we just captured.
        const startTime = samples[0].ts - 2;                  // small slack
        const endTime   = samples[samples.length - 1].ts + 2;
        const autoLabel = label || `${(groupMean * 9 / 5 + 32).toFixed(1)}°F (${new Date(capturedAt * 1000).toLocaleString()})`;
        const result = db.createCalibrationSession({
            name: autoLabel,
            referenceTemp: (referenceTemp !== undefined && referenceTemp !== null && referenceTemp !== '')
                ? parseFloat(referenceTemp)
                : null,  // null → server uses mean of all sensors as truth (correct, since they're colocated)
            startTime,
            endTime,
            notes: notes || `Auto-Sync capture; per-unit means: A=${means.a?.toFixed(2) ?? '—'} B=${means.b?.toFixed(2) ?? '—'} C=${means.c?.toFixed(2) ?? '—'} °C`,
        });

        // 5. Push live update to WS clients so the dashboard refreshes immediately.
        const wsMsg = JSON.stringify({
            type: 'temperature',
            data: {
                timestamp: samples[samples.length - 1].ts,
                readings: {
                    a: { tempC: means.a, humidity: null, ok: means.a !== null },
                    b: { tempC: means.b, humidity: null, ok: means.b !== null },
                    c: { tempC: means.c, humidity: null, ok: means.c !== null },
                },
            },
        });
        wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(wsMsg); });

        // 6. Optionally auto-recompute coefficients.
        let recompute = null;
        if (autoCal.autoRecompute) {
            try {
                const calibData = db.getCalibrationData();
                const results = calibration.computeCalibrationCoefficients(calibData, autoCal.degree);
                for (const [unitId, r] of Object.entries(results)) {
                    db.saveCalibrationCoefficients({
                        unitId,
                        degree: r.degree,
                        c0: r.coeffs[0] || 0,
                        c1: r.coeffs[1] || 1,
                        c2: r.coeffs[2] || 0,
                        c3: r.coeffs[3] || 0,
                        numPoints: r.numPoints,
                        rmse: r.rmse,
                    });
                }
                recompute = { ok: true, results, degree: autoCal.degree };
            } catch (e) {
                recompute = { ok: false, message: e.message };
            }
        }

        res.json({
            ok: true,
            sessionId: result.lastInsertRowid,
            label: autoLabel,
            means,
            groupMean,
            referenceTemp: (referenceTemp !== undefined && referenceTemp !== null && referenceTemp !== '')
                ? parseFloat(referenceTemp) : null,
            samples: samples.length,
            recompute,
        });
    } catch (err) {
        console.error('[api] /calibration/capture error:', err);
        res.status(500).json({ ok: false, message: err.message });
    }
});

// ── Bootstrap from history ───────────────────────────────────────────────────
// Treats every timestamp where all 3 units reported as a calibration point
// (since you confirm they were colocated). For each unit, fits a polynomial
// where the GROUP MEAN of the three sensors at that moment is the truth value.
//
// GET  /api/calibration/bootstrap         → preview: counts & ranges, no fit (query: startTime, endTime)
// POST /api/calibration/bootstrap         → body {degree?, dryRun?, startTime?, endTime?} → fit and save

function collectTripletPairs({ startTime = null, endTime = null } = {}) {
    // startTime/endTime are Unix timestamps (seconds). If null, no filter on that end.
    let query = "SELECT unit_id, temp_c, timestamp FROM temperature_readings WHERE temp_c IS NOT NULL";
    const params = [];
    if (startTime !== null) {
        query += " AND timestamp >= ?";
        params.push(startTime);
    }
    if (endTime !== null) {
        query += " AND timestamp <= ?";
        params.push(endTime);
    }
    query += " ORDER BY timestamp ASC";
    
    const rows = db.db.prepare(query).all(...params);
    const byTs = new Map();
    for (const r of rows) {
        if (!byTs.has(r.timestamp)) byTs.set(r.timestamp, {});
        byTs.get(r.timestamp)[r.unit_id] = r.temp_c;
    }
    const pairs = { a: [], b: [], c: [] }; // each entry: { raw, truth }
    let minTruth = Infinity, maxTruth = -Infinity;
    for (const g of byTs.values()) {
        if (g.a == null || g.b == null || g.c == null) continue;
        const truth = (g.a + g.b + g.c) / 3;
        if (truth < minTruth) minTruth = truth;
        if (truth > maxTruth) maxTruth = truth;
        pairs.a.push({ raw: g.a, truth });
        pairs.b.push({ raw: g.b, truth });
        pairs.c.push({ raw: g.c, truth });
    }
    const numPaired = pairs.a.length;
    return {
        pairs,
        numPaired,
        truthRangeC: numPaired > 0 ? { min: minTruth, max: maxTruth, spread: maxTruth - minTruth } : null,
    };
}

app.get('/api/calibration/bootstrap', (req, res) => {
    const startTime = req.query.startTime ? parseInt(req.query.startTime) : null;
    const endTime = req.query.endTime ? parseInt(req.query.endTime) : null;
    try {
        const { numPaired, truthRangeC } = collectTripletPairs({ startTime, endTime });
        res.json({
            ok: true,
            numPaired,
            truthRangeC,
            truthRangeF: truthRangeC ? {
                min: truthRangeC.min * 9 / 5 + 32,
                max: truthRangeC.max * 9 / 5 + 32,
                spread: truthRangeC.spread * 9 / 5,
            } : null,
            startTime,
            endTime,
        });
    } catch (err) {
        console.error('[api] GET /calibration/bootstrap error:', err);
        res.status(500).json({ ok: false, message: err.message });
    }
});

app.post('/api/calibration/bootstrap', (req, res) => {
    const { degree = 2, dryRun = false, startTime = null, endTime = null } = req.body || {};
    if (degree < 1 || degree > 3) {
        return res.status(400).json({ ok: false, message: 'degree must be 1, 2, or 3' });
    }
    try {
        const { pairs, numPaired, truthRangeC } = collectTripletPairs({ startTime, endTime });
        if (numPaired < degree + 1) {
            return res.status(400).json({
                ok: false,
                message: `Need at least ${degree + 1} paired triplet readings to fit degree ${degree}, but only ${numPaired} are available.`,
                numPaired,
            });
        }
        if (truthRangeC && truthRangeC.spread < 1.0) {
            return res.status(400).json({
                ok: false,
                message: `Temperature spread is only ${truthRangeC.spread.toFixed(2)}°C — too narrow for a meaningful fit.`,
                numPaired,
                truthRangeC,
            });
        }

        const results = {};
        for (const u of ['a', 'b', 'c']) {
            const x = pairs[u].map(p => p.raw);
            const y = pairs[u].map(p => p.truth);
            const coeffs = calibration.polynomialFit(x, y, degree);
            const predicted = x.map(xv => calibration.applyPolynomial(coeffs, xv));
            const rmse = calibration.calculateRMSE(y, predicted);
            results[u] = { coeffs, rmse, numPoints: x.length, degree };
        }

        if (!dryRun) {
            for (const [unitId, r] of Object.entries(results)) {
                db.saveCalibrationCoefficients({
                    unitId,
                    degree: r.degree,
                    c0: r.coeffs[0] || 0,
                    c1: r.coeffs[1] || 1,
                    c2: r.coeffs[2] || 0,
                    c3: r.coeffs[3] || 0,
                    numPoints: r.numPoints,
                    rmse: r.rmse,
                });
            }
            console.log(`[bootstrap] saved degree-${degree} polynomial from ${numPaired} paired readings`);
            console.log(calibration.formatCalibrationResults(results));
        }

        res.json({
            ok: true,
            saved: !dryRun,
            degree,
            numPaired,
            truthRangeC,
            truthRangeF: truthRangeC ? {
                min: truthRangeC.min * 9 / 5 + 32,
                max: truthRangeC.max * 9 / 5 + 32,
                spread: truthRangeC.spread * 9 / 5,
            } : null,
            results,
        });
    } catch (err) {
        console.error('[api] POST /calibration/bootstrap error:', err);
        res.status(500).json({ ok: false, message: err.message });
    }
});

// Get all calibration sessions
app.get('/api/calibration/sessions', (_req, res) => {
    try {
        const sessions = db.getCalibrationSessions();
        res.json({ ok: true, sessions });
    } catch (err) {
        console.error('[api] /calibration/sessions error:', err);
        res.status(500).json({ ok: false, message: err.message });
    }
});

// Create a new calibration session
app.post('/api/calibration/sessions', (req, res) => {
    const { name, referenceTemp, startTime, endTime, notes } = req.body;
    
    if (!startTime || !endTime) {
        return res.status(400).json({ ok: false, message: 'startTime and endTime are required' });
    }
    
    if (endTime <= startTime) {
        return res.status(400).json({ ok: false, message: 'endTime must be after startTime' });
    }
    
    try {
        const result = db.createCalibrationSession({
            name,
            referenceTemp: referenceTemp || null,
            startTime,
            endTime,
            notes,
        });
        
        res.json({ ok: true, sessionId: result.lastInsertRowid });
    } catch (err) {
        console.error('[api] POST /calibration/sessions error:', err);
        res.status(500).json({ ok: false, message: err.message });
    }
});

// Delete a calibration session
app.delete('/api/calibration/sessions/:id', (req, res) => {
    const sessionId = parseInt(req.params.id);
    
    if (!sessionId) {
        return res.status(400).json({ ok: false, message: 'Invalid session ID' });
    }
    
    try {
        const result = db.deleteCalibrationSession(sessionId);
        res.json({ ok: true, deleted: result.changes > 0 });
    } catch (err) {
        console.error(`[api] DELETE /calibration/sessions/${sessionId} error:`, err);
        res.status(500).json({ ok: false, message: err.message });
    }
});

// Get calibration data (all sessions with readings grouped by unit)
app.get('/api/calibration/data', (_req, res) => {
    try {
        const data = db.getCalibrationData();
        res.json({ ok: true, data });
    } catch (err) {
        console.error('[api] /calibration/data error:', err);
        res.status(500).json({ ok: false, message: err.message });
    }
});

// Get readings for a specific time range (for preview before creating session)
app.get('/api/calibration/preview', (req, res) => {
    const startTime = parseInt(req.query.startTime);
    const endTime = parseInt(req.query.endTime);
    
    if (!startTime || !endTime) {
        return res.status(400).json({ ok: false, message: 'startTime and endTime are required' });
    }
    
    try {
        const readings = db.getReadingsInRange(startTime, endTime);
        
        // Calculate mean for each unit
        const preview = {};
        for (const [unitId, temps] of Object.entries(readings)) {
            if (temps.length > 0) {
                const mean = temps.reduce((a, b) => a + b, 0) / temps.length;
                const min = Math.min(...temps);
                const max = Math.max(...temps);
                preview[unitId] = { mean, min, max, count: temps.length };
            } else {
                preview[unitId] = { mean: null, min: null, max: null, count: 0 };
            }
        }
        
        res.json({ ok: true, preview });
    } catch (err) {
        console.error('[api] /calibration/preview error:', err);
        res.status(500).json({ ok: false, message: err.message });
    }
});

// Compute and save calibration coefficients
app.post('/api/calibration/compute', (req, res) => {
    const { degree } = req.body;
    const polyDegree = degree || 2;
    
    if (polyDegree < 1 || polyDegree > 3) {
        return res.status(400).json({ ok: false, message: 'degree must be 1, 2, or 3' });
    }
    
    try {
        // Get calibration data
        const calibData = db.getCalibrationData();
        
        if (calibData.length === 0) {
            return res.status(400).json({ ok: false, message: 'No calibration sessions found' });
        }
        
        // Compute coefficients
        const results = calibration.computeCalibrationCoefficients(calibData, polyDegree);
        
        if (Object.keys(results).length === 0) {
            return res.status(400).json({ ok: false, message: 'Not enough data points to compute calibration' });
        }
        
        // Save to database
        for (const [unitId, result] of Object.entries(results)) {
            db.saveCalibrationCoefficients({
                unitId,
                degree: result.degree,
                c0: result.coeffs[0] || 0,
                c1: result.coeffs[1] || 1,
                c2: result.coeffs[2] || 0,
                c3: result.coeffs[3] || 0,
                numPoints: result.numPoints,
                rmse: result.rmse,
            });
        }
        
        const summary = calibration.formatCalibrationResults(results);
        console.log(summary);
        
        res.json({ ok: true, results, summary });
    } catch (err) {
        console.error('[api] POST /calibration/compute error:', err);
        res.status(500).json({ ok: false, message: err.message });
    }
});

// Get current calibration coefficients
app.get('/api/calibration/coefficients', (_req, res) => {
    try {
        const coeffs = db.getAllCalibrationCoefficients();
        res.json({ ok: true, coefficients: coeffs });
    } catch (err) {
        console.error('[api] /calibration/coefficients error:', err);
        res.status(500).json({ ok: false, message: err.message });
    }
});

// Get coefficients for a specific unit
app.get('/api/calibration/coefficients/:unitId', (req, res) => {
    const { unitId } = req.params;
    
    if (!['a', 'b', 'c'].includes(unitId)) {
        return res.status(400).json({ ok: false, message: 'unitId must be a, b, or c' });
    }
    
    try {
        const coeffs = db.getCalibrationCoefficients(unitId);
        res.json({ ok: true, coefficients: coeffs || null });
    } catch (err) {
        console.error(`[api] /calibration/coefficients/${unitId} error:`, err);
        res.status(500).json({ ok: false, message: err.message });
    }
});

// Delete calibration coefficients for a unit
app.delete('/api/calibration/coefficients/:unitId', (req, res) => {
    const { unitId } = req.params;
    
    if (!['a', 'b', 'c'].includes(unitId)) {
        return res.status(400).json({ ok: false, message: 'unitId must be a, b, or c' });
    }
    
    try {
        const result = db.deleteCalibrationCoefficients(unitId);
        res.json({ ok: true, deleted: result.changes > 0 });
    } catch (err) {
        console.error(`[api] DELETE /calibration/coefficients/${unitId} error:`, err);
        res.status(500).json({ ok: false, message: err.message });
    }
});

// Apply calibration to temperature readings (GET with calibrated=true)
app.get('/api/temperature/history/calibrated', (req, res) => {
    const hours = parseInt(req.query.hours) || 24;
    const limit = parseInt(req.query.limit) || 1000;
    
    try {
        const readings = db.getRecentReadings({ hours, limit });
        
        // Apply calibration to each reading
        for (const reading of readings) {
            if (reading.temp_c !== null) {
                reading.temp_c_calibrated = db.applyCalibratedTemp(reading.unit_id, reading.temp_c);
            } else {
                reading.temp_c_calibrated = null;
            }
        }
        
        res.json({ ok: true, count: readings.length, readings });
    } catch (err) {
        console.error('[api] /temperature/history/calibrated error:', err);
        res.status(500).json({ ok: false, message: err.message });
    }
});

httpServer.listen(PORT, () => {
    console.log(`\nColor Picker  ->  http://localhost:${PORT}`);
    console.log(`ESP32 target  ->  http://${ESP_IP}/`);
    console.log(`WebSocket     ->  ws://localhost:${PORT}\n`);
});
