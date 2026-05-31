'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const http      = require('http');
const express   = require('express');
const WebSocket = require('ws');
const db        = require('./db');

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

httpServer.listen(PORT, () => {
    console.log(`\nColor Picker  ->  http://localhost:${PORT}`);
    console.log(`ESP32 target  ->  http://${ESP_IP}/`);
    console.log(`WebSocket     ->  ws://localhost:${PORT}\n`);
});
