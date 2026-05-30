# espnow-practice

ESP-NOW experimentation project using two **udevqal ESP32-S3 N16R8** development boards.

---

## Modules

### Unit A — sender (`-DROLE_SENDER`) — **the hub**
- **COM12**, IP `10.0.0.48`, MAC `a4:cb:8f:d1:ef:58`
- Connects to home WiFi (SSID / pass from `include/credentials.h`)
- Hosts a lightweight HTTP server on port 80 — the Node.js dashboard proxies to it
- Reads its own **DHT22** sensor on GPIO 4 every 15 s, exposes via `/temp_a`
- Sends `ColorPacket` to Unit B via ESP-NOW (and sets its own WS2812B LED)
- Receives `TempPacket` from Unit B (SHT30), caches it, exposes via `/temp_b`
- Measures its own RSSI to B (B pings A every 500 ms); exposes via `/rssi`
- WiFi watchdog: if WiFi drops for > 30 s the board reboots

### Unit B — receiver (`-DROLE_RECEIVER`) — **the remote sensor**
- **COM11**, no HTTP server, no router connection (channel-locked to 11)
- MAC `a4:cb:8f:d1:f2:a8`
- Sets its WS2812B LED to whatever `ColorPacket` A forwards
- Hosts a **SHT30** (I²C, address `0x44`) temperature + humidity sensor
  - SDA → GPIO 8, SCL → GPIO 9
- Reads SHT30 every 10 s and sends `TempPacket` to A
- Sends `PingPacket` to A every 500 ms so A can measure A↔B RSSI

---

## Architecture

```
Browser
  |
  |  HTTP POST /api/color/{a|b}  {r, g, b}
  |  HTTP GET  /api/temp_a  /api/temp_b  /api/rssi  /api/info
  v
Node.js server  (localhost:3000)   <-- also serves the dashboard
  |
  |  HTTP GET /color  /forward  /temp_a  /temp_b  /rssi
  v
Unit A -- ESP32-S3 (COM12, 10.0.0.48)   <-- HTTP API hub; DHT22 on GPIO4
  |
  |  ESP-NOW
  |    ColorPacket  (3 B)  A -> B
  |    TempPacket   (5 B)  B -> A  (every 10 s)
  |    PingPacket   (2 B)  B -> A  (every 500 ms, for RSSI)
  v
Unit B (COM11)   <-- SHT30 on GPIO 8/9, channel-locked to 11
```

**Key points**
- Unit A is the only board on WiFi. Unit B uses ESP-NOW only.
- ESP-NOW link is locked to channel 11 (must match the router channel A connects to).
- The dashboard shows live RSSI for A↔WiFi and A↔B.
- Per-sensor calibration offsets (°F) are persisted in browser `localStorage`.
- "Sync to Average" adjusts checked units' offsets so they all display the same temperature.

---

## Hardware

|                 | Unit A (sender)              | Unit B (receiver)             |
|-----------------|------------------------------|-------------------------------|
| COM port        | **COM12**                    | **COM11**                     |
| IP address      | `10.0.0.48`                  | — (ESP-NOW only)              |
| MAC address     | `a4:cb:8f:d1:ef:58`          | `a4:cb:8f:d1:f2:a8`           |
| Temp sensor     | **DHT22** on GPIO 4          | **SHT30** on GPIO 8 / 9 (I²C) |
| Transport       | WiFi (HTTP) + ESP-NOW        | ESP-NOW (channel 11)          |
| Role            | Hub: HTTP API + aggregator   | Remote sensor + LED           |

### Shared hardware details

| Item     | Detail                                                       |
|----------|--------------------------------------------------------------|
| Board    | ESP32-S3-DevKitC-1-N16R8 (udevqal 3-pack)                    |
| MCU      | ESP32-S3 (QFN56) rev v0.2, 240 MHz dual-core LX7             |
| Flash    | 16 MB SPI                                                    |
| PSRAM    | 8 MB OPI                                                     |
| Crystal  | 40 MHz                                                       |
| USB chip | CH343P (auto-reset)                                          |
| Antenna  | Detachable external (IPEX connector)                         |
| RGB LED  | WS2812B NeoPixel on **GPIO 48** (both boards)                |

### Pinout highlights

- **GPIO 48** — Onboard RGB LED (WS2812B NeoPixel) — confirmed; the GPIO 38 label on the udevqal pinout image is wrong
- **GPIO 4**  — DHT22 data wire (Unit A only)
- **GPIO 8**  — SHT30 SDA (Unit B only)
- **GPIO 9**  — SHT30 SCL (Unit B only)
- **GPIO 0**  — BOOT button
- **USB_D+ / USB_D-** — GPIO 20 / GPIO 19 (native USB)

---

## ESP-NOW packet types

| Struct        | Size | Fields                              | Direction   |
|---------------|------|-------------------------------------|-------------|
| `ColorPacket` | 3 B  | `uint8_t r, g, b`                   | A → B       |
| `TempPacket`  | 5 B  | `float temp_c; uint8_t humidity`    | B → A       |
| `PingPacket`  | 2 B  | `uint8_t magic = 0xBB; uint8_t seq` | B → A       |

Unit A dispatches incoming ESP-NOW packets by size and magic byte. A sentinel `temp_c == -99` means the SHT30 returned NaN.

---

## Web UI

Two unit cards (A and B), a calibration sync panel, and a signal-strength panel:

- **Unit A** — colour picker, Send button, live **DHT22** temperature, calibration offset.
  Card header shows: role chip (HUB), sensor (DHT22), MAC, IP, COM port, transport.
- **Unit B** — Match A / Independent mode, colour picker, live **SHT30** temperature, calibration offset.
  Card header shows: role chip (SENSOR), sensor (SHT30), MAC, COM port, transport (ESP-NOW ch 11).
- **Temperature Calibration Sync panel** — checkbox per unit + "Sync to Average" button. Offsets persist in `localStorage`.
- **Signal Strength panel** — live RSSI bars for A↔WiFi and A↔B (streamed via WebSocket every 300 ms).

If the server can't reach Unit A, the Unit B card displays a "Unit A must be active" warning banner.

---

## Node.js API (`server/server.js`, port 3000)

| Method | Path             | Description                                |
|--------|------------------|--------------------------------------------|
| POST   | `/api/color/a`   | Set Unit A LED colour                      |
| POST   | `/api/color/b`   | Set Unit B LED colour (forwarded via A)    |
| GET    | `/api/temp_a`    | Unit A DHT22 reading                       |
| GET    | `/api/temp_b`    | Unit B SHT30 reading (cached by A)         |
| GET    | `/api/rssi`      | RSSI values: `wifi`, `b`                   |
| GET    | `/api/info`      | MAC, IP, port, sensor, role, transport     |

WebSocket on the same port broadcasts RSSI updates every 300 ms.

---

## Unit A HTTP endpoints (direct, port 80)

| Path                     | Description                              |
|--------------------------|------------------------------------------|
| `/color?r=&g=&b=`        | Set Unit A LED                           |
| `/forward?r=&g=&b=`      | Forward colour to Unit B via ESP-NOW     |
| `/temp_a`                | Local DHT22 reading (JSON)               |
| `/temp_b`                | Cached SHT30 reading from Unit B (JSON)  |
| `/rssi`                  | RSSI values (JSON: `wifi`, `b`)          |

---

## First-time setup

**WiFi credentials** — copy the template and fill in your network:
```powershell
Copy-Item include/credentials.h.template include/credentials.h
# edit include/credentials.h -- set WIFI_SSID and WIFI_PASS
```

**Flash both boards** (auto-detected by MAC via `auto_port.py`):
```powershell
pio run -e sender   --target upload    # Unit A (DHT22)
pio run -e receiver --target upload    # Unit B (SHT30)
```

**Find Unit A's IP** — open the serial monitor and press RST:
```powershell
pio device monitor -p COM12 -b 115200
# Look for:   IP: 10.0.x.x   Channel: N
```

If the channel is not `11`, update `-DESPNOW_CHANNEL=<n>` in `[env:receiver]` and reflash Unit B.

**Configure the server** — create `server/.env`:
```
ESP_IP=10.0.0.48
PORT=3000
```

**Start the server:**
```powershell
cd server
npm install         # first time only
npm start
```

**Restart the server** (kills any running node first):
```powershell
Get-Process -Name node -ErrorAction SilentlyContinue | Stop-Process -Force
cd server
node server.js
```

**Open the dashboard:** http://localhost:3000

---

## Repository layout

```
espnow-practice/
├── src/main.cpp                # firmware for both boards (role set by build flag)
├── include/
│   ├── credentials.h           # WiFi credentials — git-ignored, you create this
│   └── credentials.h.template  # copy → credentials.h and fill in
├── server/
│   ├── server.js               # Node.js / Express + WebSocket
│   ├── public/index.html       # React dashboard (single-file, @babel/standalone)
│   ├── .env                    # ESP_IP, PORT — git-ignored, you create this
│   └── .env.example            # copy → .env and fill in
├── auto_port.py                # PlatformIO pre-upload script (finds board by MAC)
└── platformio.ini
```

---

## PlatformIO environments

| Environment | COM port | Build flag        | Extra libs                                  |
|-------------|----------|-------------------|---------------------------------------------|
| `sender`    | COM12    | `-DROLE_SENDER`   | DHT sensor library, Adafruit Unified Sensor |
| `receiver`  | COM11    | `-DROLE_RECEIVER` | Adafruit SHT31 Library                      |

`auto_port.py` re-maps the upload port to whichever COM device matches the target MAC, so listed COM numbers are only fallbacks.

---

## Notes

- Hold BOOT (GPIO 0) while pressing RST to enter download mode manually if auto-reset ever fails.
- The CH343P USB chip normally handles auto-reset for you.
- `include/credentials.h` and `server/.env` are git-ignored — never commit secrets.
- The ESP-NOW channel must match Unit A's WiFi channel. Verify with `GET http://<unit-a-ip>/rssi` → `wifi.ch`.
