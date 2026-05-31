# espnow-practice

ESP-NOW experimentation project using three **udevqal ESP32-S3 N16R8** development boards.

## Features

- **ESP-NOW Mesh Network**: Three ESP32 units communicating via ESP-NOW protocol
- **Temperature Monitoring**: DHT22, SHT30, and DHT11 sensors with synchronized readings
- **Synchronized Temperature Reads**: All units read sensors simultaneously every 30 seconds
- **Persistent Calibration**: Sensor offsets stored in NVS (survives reboots)
- **Historical Temperature Logging**: Automatic 5-minute logging to SQLite database
- **Time-Series Graphing**: Interactive Chart.js visualization with 1h/6h/24h/7d views
- **Real-time Dashboard**: React-based web UI with WebSocket updates
- **Signal Strength Monitoring**: Live RSSI display for WiFi and ESP-NOW links
- **LED Color Control**: Remote control of WS2812B LEDs on all units

---

## Modules

### Unit A — sender (`-DROLE_SENDER`) — **the hub**
- **COM12**, IP `10.0.0.48`, MAC `a4:cb:8f:d1:ef:58`
- Connects to home WiFi (SSID / pass from `include/credentials.h`)
- Hosts a lightweight HTTP server on port 80 — the Node.js dashboard proxies to it
- **Broadcasts SYNC commands** every 30s to trigger synchronized temperature reads
- Reads its own **DHT22** sensor on GPIO 4 with calibration offset applied
- Sends `ColorPacket` to Unit B and Unit C via ESP-NOW (and sets its own WS2812B LED)
- Receives `TempPacket` from Unit B (SHT30) and Unit C (DHT11), applies calibration, exposes via `/temp_b` and `/temp_c`
- **Persistent calibration** stored in NVS (survives reboots)
- Measures its own RSSI to B and C (B and C ping A every 500 ms); exposes via `/rssi`
- WiFi watchdog: if WiFi drops for > 30 s the board reboots

### Unit B — receiver (`-DROLE_RECEIVER`) — **remote sensor**
- **COM11**, no HTTP server, no router connection (channel-locked to 11)
- MAC `a4:cb:8f:d1:f2:a8`
- Sets its WS2812B LED to whatever `ColorPacket` A forwards
- Hosts a **SHT30** (I²C, address `0x44`) temperature + humidity sensor
  - SDA → GPIO 8, SCL → GPIO 9
- **Reads SHT30 on SYNC command** from Unit A and sends `TempPacket` immediately
- Sends `PingPacket` to A every 500 ms so A can measure A↔B RSSI

### Unit C — unit_c (`-DROLE_UNIT_C`) — **remote sensor**
- **COM14**, no HTTP server, no router connection (channel-locked to 11)
- MAC `a4:cb:8f:d1:ef:a0`
- Sets its WS2812B LED to whatever `ColorPacket` A forwards
- Hosts a **DHT11** temperature + humidity sensor on GPIO 4
- **Reads DHT11 on SYNC command** from Unit A and sends `TempPacket` immediately
- Sends `PingPacket` to A every 500 ms so A can measure A↔C RSSI

---

## Temperature Synchronization & Calibration

**Problem:** Temperature readings from different sensors (DHT11, DHT22, SHT30) can drift apart due to:
- Different reading times (no synchronization)
- Different sensor accuracies (±2°C for DHT11, ±0.5°C for DHT22, ±0.3°C for SHT30)
- Sensor-specific offsets and calibration errors
- Different physical locations and ambient conditions

**Solution:** Synchronized reading + persistent calibration offsets

### How It Works

1. **Unit A broadcasts SYNC commands** every 30 seconds (or on-demand via `/sync`)
2. **Units B and C respond immediately** by reading their sensors
3. **Unit A reads its own sensor** at the same time
4. **Calibration offsets** are applied to all readings and stored in NVS (non-volatile storage)

### New HTTP Endpoints

```bash
# Trigger immediate synchronized read
GET http://10.0.0.48/sync

# Set calibration offset (in °C)
GET http://10.0.0.48/set_cal?unit=a&offset=-0.3
GET http://10.0.0.48/set_cal?unit=b&offset=0.0
GET http://10.0.0.48/set_cal?unit=c&offset=-1.6

# Get current calibration
GET http://10.0.0.48/get_cal

# Reset all calibration to zero
GET http://10.0.0.48/reset_cal
```

### Quick Calibration Guide

1. **Place all units close together** and wait 10-15 minutes
2. **Trigger sync read:** `curl http://10.0.0.48/sync`
3. **Read all temperatures:**
   ```bash
   curl http://10.0.0.48/temp_a  # e.g., 23.5°C
   curl http://10.0.0.48/temp_b  # e.g., 23.2°C (SHT30, most accurate)
   curl http://10.0.0.48/temp_c  # e.g., 24.8°C
   ```
4. **Choose Unit B as reference** (SHT30 is most accurate)
5. **Calculate offsets:**
   - Unit A: 23.2 - 23.5 = **-0.3**
   - Unit B: 23.2 - 23.2 = **0.0**
   - Unit C: 23.2 - 24.8 = **-1.6**
6. **Apply calibration:**
   ```bash
   curl "http://10.0.0.48/set_cal?unit=a&offset=-0.3"
   curl "http://10.0.0.48/set_cal?unit=b&offset=0.0"
   curl "http://10.0.0.48/set_cal?unit=c&offset=-1.6"
   ```
7. **Verify:** `curl http://10.0.0.48/sync` then check temps again

**See [SYNC_CALIBRATION.md](SYNC_CALIBRATION.md) for detailed instructions.**

---

## Temperature Logging & Historical Graphing

The server automatically logs temperature readings from all three units every 5 minutes to a SQLite database and displays them in an interactive time-series graph on the dashboard.

**Features:**
- ⏱️ Automatic 5-minute logging
- 📊 Interactive Chart.js graph with 1h/6h/24h/7d views
- 💾 SQLite database (easily migrates to PostgreSQL/MySQL)
- 🔄 Real-time WebSocket updates
- 📡 REST API for historical data queries
- 🎨 Color-coded by unit (A=blue, B=green, C=yellow)

**Dashboard Graph:**

The temperature graph appears at the bottom of the dashboard showing:
- Unit A (DHT22) in blue
- Unit B (SHT30) in green  
- Unit C (DHT11) in yellow

Click the time range buttons (1h, 6h, 24h, 7d) to adjust the view.

**Database:**
- Location: `server/temperatures.db`
- Auto-created on first run
- Schema: `unit_id`, `temp_c`, `humidity`, `timestamp`

**API Endpoints:**
- `GET /api/temperature/history?hours=24` - Get readings for last N hours
- `GET /api/temperature/latest` - Get latest reading per unit
- `GET /api/temperature/stats/a` - Get statistics (avg, min, max)
- `GET /api/temperature/unit/a?hours=6` - Get readings for specific unit

**See [TEMPERATURE_LOGGING.md](TEMPERATURE_LOGGING.md) for complete documentation and database migration guide.**

---

## Module Setup

### Unit A Setup (Hub with WiFi + ESP-NOW)

**Hardware:**
- **MAC Address:** `a4:cb:8f:d1:ef:58`
- **IP Address:** `10.0.0.48` (assigned by router)
- **COM Port:** COM12
- **Sensor:** DHT22 on GPIO 4
- **RGB LED:** WS2812B on GPIO 48

**Wiring:**
```
DHT22:
  VCC  → 3.3V
  DATA → GPIO 4
  GND  → GND
```

**Setup Steps:**
1. Create WiFi credentials file:
   ```powershell
   Copy-Item include/credentials.h.template include/credentials.h
   # Edit credentials.h: set WIFI_SSID="Dobby" WIFI_PASS="sanmina-1"
   ```

2. Flash the firmware:
   ```powershell
   pio run -e sender --target upload
   ```

3. Monitor and verify:
   ```powershell
   pio device monitor -p COM12 -b 115200
   ```
   Look for startup message with IP address and WiFi channel.

4. Test HTTP endpoints:
   ```powershell
   curl http://10.0.0.48/temp_a    # DHT22 reading
   curl http://10.0.0.48/rssi      # RSSI data
   ```

**Expected Output:**
- Startup: `[A] IP: 10.0.0.48 Channel: 11`
- DHT22 readings every 15s: `[A] temp=28.5°C hum=43%`

---

### Unit B Setup (SHT30 Remote Sensor)

**Hardware:**
- **MAC Address:** `a4:cb:8f:d1:f2:a8`
- **COM Port:** COM11
- **Sensor:** SHT30 (I²C) at address 0x44
- **RGB LED:** WS2812B on GPIO 48
- **Transport:** ESP-NOW only (channel 11)

**Wiring:**
```
SHT30:
  VCC → 3.3V
  SDA → GPIO 8
  SCL → GPIO 9
  GND → GND
```

**Setup Steps:**
1. Verify Unit A is running and on channel 11 (check `/rssi` endpoint)

2. Flash the firmware:
   ```powershell
   pio run -e receiver --target upload
   ```

3. Monitor and verify:
   ```powershell
   pio device monitor -p COM11 -b 115200
   ```
   Look for: `[B] temp=28.4°C hum=44%` every 10 seconds.

4. Verify from Unit A:
   ```powershell
   curl http://10.0.0.48/temp_b    # Should show SHT30 data
   curl http://10.0.0.48/rssi      # Should show b.rssi value
   ```

**Expected Output:**
- Startup: `Unit B — ROLE_RECEIVER + SHT30`
- Sensor readings every 10s: `[B] temp=28.36°C hum=44%`
- RSSI pings every 500ms

---

### Unit C Setup (DHT11 Remote Sensor)

**Hardware:**
- **MAC Address:** `a4:cb:8f:d1:ef:a0`
- **COM Port:** COM14
- **Sensor:** DHT11 on GPIO 4
- **RGB LED:** WS2812B on GPIO 48
- **Transport:** ESP-NOW only (channel 11)

**Wiring:**
```
DHT11:
  VCC  → 3.3V
  DATA → GPIO 4
  GND  → GND
```

**Setup Steps:**
1. Verify Unit A is running and on channel 11

2. Flash the firmware:
   ```powershell
   pio run -e unit_c --target upload
   ```

3. Monitor and verify:
   ```powershell
   pio device monitor -p COM14 -b 115200
   ```
   Look for: `[C] temp=27.1°C hum=42%` every 10 seconds.

4. Verify from Unit A:
   ```powershell
   curl http://10.0.0.48/temp_c    # Should show DHT11 data
   curl http://10.0.0.48/rssi      # Should show c.rssi value
   ```

**Expected Output:**
- Startup: `Unit C — UNIT_C + DHT11`
- Sensor readings every 10s: `[C] temp=27.1°C hum=42%`
- RSSI pings every 500ms

---

### Quick Reference: All Units

| Unit | MAC                | IP         | COM   | Sensor | Flash Command                     |
|------|--------------------|------------|-------|--------|-----------------------------------|
| A    | a4:cb:8f:d1:ef:58  | 10.0.0.48  | COM12 | DHT22  | `pio run -e sender -t upload`     |
| B    | a4:cb:8f:d1:f2:a8  | —          | COM11 | SHT30  | `pio run -e receiver -t upload`   |
| C    | a4:cb:8f:d1:ef:a0  | —          | COM14 | DHT11  | `pio run -e unit_c -t upload`     |

**Test All Units:**
```powershell
# From Node.js server (localhost:3000)
curl http://localhost:3000/api/temp_a    # Unit A DHT22
curl http://localhost:3000/api/temp_b    # Unit B SHT30
curl http://localhost:3000/api/temp_c    # Unit C DHT11
curl http://localhost:3000/api/rssi      # All RSSI values
curl http://localhost:3000/api/info      # All unit info
```

---

## Architecture

```
Browser
  |
  |  HTTP POST /api/color/{a|b|c}  {r, g, b}
  |  HTTP GET  /api/temp_a  /api/temp_b  /api/temp_c  /api/rssi  /api/info
  v
Node.js server  (localhost:3000)   <-- also serves the dashboard
  |
  |  HTTP GET /color  /forward  /forward_c  /temp_a  /temp_b  /temp_c  /rssi
  v
Unit A -- ESP32-S3 (COM12, 10.0.0.48)   <-- HTTP API hub; DHT22 on GPIO4
  |
  |  ESP-NOW
  |    ColorPacket  (3 B)  A -> B,C
  |    TempPacket   (5 B)  B,C -> A  (every 10 s)
  |    PingPacket   (2 B)  B,C -> A  (every 500 ms, for RSSI)
  v
Unit B (COM11)   <-- SHT30 on GPIO 8/9, channel-locked to 11
Unit C (COM14)   <-- DHT11 on GPIO 4, channel-locked to 11
```

**Key points**
- Unit A is the only board on WiFi. Units B and C use ESP-NOW only.
- ESP-NOW link is locked to channel 11 (must match the router channel A connects to).
- The dashboard shows live RSSI for A↔WiFi, A↔B, and A↔C.
- Per-sensor calibration offsets (°F) are persisted in browser `localStorage`.
- "Sync to Average" adjusts checked units' offsets so they all display the same temperature.

---

## Hardware

|                 | Unit A (sender)              | Unit B (receiver)             | Unit C (unit_c)             |
|-----------------|------------------------------|-------------------------------|---------------------------------|
| COM port        | **COM12**                    | **COM11**                     | **COM14**                       |
| IP address      | `10.0.0.48`                  | — (ESP-NOW only)              | — (ESP-NOW only)                |
| MAC address     | `a4:cb:8f:d1:ef:58`          | `a4:cb:8f:d1:f2:a8`           | `a4:cb:8f:d1:ef:a0`             |
| Temp sensor     | **DHT22** on GPIO 4          | **SHT30** on GPIO 8 / 9 (I²C) | **DHT11** on GPIO 4             |
| Transport       | WiFi (HTTP) + ESP-NOW        | ESP-NOW (channel 11)          | ESP-NOW (channel 11)            |
| Role            | Hub: HTTP API + aggregator   | Remote sensor + LED           | Remote sensor + LED             |

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
| `ColorPacket` | 3 B  | `uint8_t r, g, b`                   | A → B,C     |
| `TempPacket`  | 5 B  | `float temp_c; uint8_t humidity`    | B,C → A     |
| `PingPacket`  | 2 B  | `uint8_t magic = 0xBB; uint8_t seq` | B,C → A     |

Unit A dispatches incoming ESP-NOW packets by size, magic byte, and source MAC. A sentinel `temp_c == -99` means the sensor returned NaN.

---

## Web UI

Three unit cards (A, B, and C), a calibration sync panel, and a signal-strength panel:

- **Unit A** — colour picker, Send button, live **DHT22** temperature, calibration offset.
  Card header shows: role chip (HUB), sensor (DHT22), MAC, IP, COM port, transport.
- **Unit B** — Match A / Independent mode, colour picker, live **SHT30** temperature, calibration offset.
  Card header shows: role chip (SENSOR), sensor (SHT30), MAC, COM port, transport (ESP-NOW ch 11).
- **Unit C** — Match A / Independent mode, colour picker, live **DHT11** temperature, calibration offset.
  Card header shows: role chip (SENSOR), sensor (DHT11), MAC, COM port, transport (ESP-NOW ch 11).
- **Temperature Calibration Sync panel** — checkbox per unit + "Sync to Average" button. Offsets persist in `localStorage`.
- **Signal Strength panel** — live RSSI bars for A↔WiFi, A↔B, and A↔C (streamed via WebSocket every 300 ms).

If the server can't reach Unit A, Units B and C cards display a "Unit A must be active" warning banner.

---

## Node.js API (`server/server.js`, port 3000)

| Method | Path             | Description                                |
|--------|------------------|--------------------------------------------|
| POST   | `/api/color/a`   | Set Unit A LED colour                      |
| POST   | `/api/color/b`   | Set Unit B LED colour (forwarded via A)    |
| POST   | `/api/color/c`   | Set Unit C LED colour (forwarded via A)    |
| GET    | `/api/temp_a`    | Unit A DHT22 reading                       |
| GET    | `/api/temp_b`    | Unit B SHT30 reading (cached by A)         |
| GET    | `/api/temp_c`    | Unit C DHT11 reading (cached by A)         |
| GET    | `/api/temp`      | Alias for `/api/temp_c`                    |
| GET    | `/api/rssi`      | RSSI values: `wifi`, `b`, `c`              |
| GET    | `/api/info`      | MAC, IP, port, sensor, role, transport     |

WebSocket on the same port broadcasts RSSI updates every 300 ms.

---

## Unit A HTTP endpoints (direct, port 80)

| Path                     | Description                              |
|--------------------------|------------------------------------------|
| `/color?r=&g=&b=`        | Set Unit A LED                           |
| `/forward?r=&g=&b=`      | Forward colour to Unit B via ESP-NOW     |
| `/forward_c?r=&g=&b=`    | Forward colour to Unit C via ESP-NOW     |
| `/temp_a`                | Local DHT22 reading (JSON)               |
| `/temp_b`                | Cached SHT30 reading from Unit B (JSON)  |
| `/temp_c` or `/temp`     | Cached DHT11 reading from Unit C (JSON)  |
| `/rssi`                  | RSSI values (JSON: `wifi`, `b`, `c`)     |

---

## First-time setup

**WiFi credentials** — copy the template and fill in your network:
```powershell
Copy-Item include/credentials.h.template include/credentials.h
# edit include/credentials.h -- set WIFI_SSID and WIFI_PASS
```

**Flash all three boards** (auto-detected by MAC via `auto_port.py`):
```powershell
pio run -e sender   --target upload    # Unit A (DHT22)
pio run -e receiver --target upload    # Unit B (SHT30)
pio run -e unit_c   --target upload    # Unit C (DHT11)
```

**Find Unit A's IP** — open the serial monitor and press RST:
```powershell
pio device monitor -p COM12 -b 115200
# Look for:   IP: 10.0.x.x   Channel: N
```

If the channel is not `11`, update `-DESPNOW_CHANNEL=<n>` in `[env:receiver]` and `[env:unit_c]` and reflash Units B and C.

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
| `unit_c`    | COM14    | `-DROLE_UNIT_C`   | DHT sensor library, Adafruit Unified Sensor |

`auto_port.py` re-maps the upload port to whichever COM device matches the target MAC, so listed COM numbers are only fallbacks.

---

## Notes

- Hold BOOT (GPIO 0) while pressing RST to enter download mode manually if auto-reset ever fails.
- The CH343P USB chip normally handles auto-reset for you.
- `include/credentials.h` and `server/.env` are git-ignored — never commit secrets.
- The ESP-NOW channel must match Unit A's WiFi channel. Verify with `GET http://<unit-a-ip>/rssi` → `wifi.ch`.
