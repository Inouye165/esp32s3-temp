'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const http      = require('http');
const express   = require('express');
const WebSocket = require('ws');

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

httpServer.listen(PORT, () => {
    console.log(`\nColor Picker  ->  http://localhost:${PORT}`);
    console.log(`ESP32 target  ->  http://${ESP_IP}/`);
    console.log(`WebSocket     ->  ws://localhost:${PORT}\n`);
});
