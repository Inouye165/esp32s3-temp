# Temperature Synchronization & Calibration Guide (Legacy/Debug)

> [!WARNING]
> This document describes legacy **firmware-level NVS offsets** which are kept for debug/manual legacy purposes only. For the primary, automated, and unified calibration system, see [CALIBRATION.md](CALIBRATION.md).

## Problem Solved

Previously, the three units (A, B, C) read their temperature sensors at different intervals:
- Unit A: every 15 seconds
- Unit B: every 10 seconds  
- Unit C: every 10 seconds

This caused temperatures to drift apart because:
1. **No synchronization** - each unit read at different times
2. **Different sensor accuracies** - DHT11 (±2°C), DHT22 (±0.5°C), SHT30 (±0.3°C)
3. **No calibration** - sensor offsets were not compensated
4. **Physical differences** - sensors at different locations with different ambient temps

## New Solution

### 1. Synchronized Reading
- Unit A broadcasts a **SYNC command** every 30 seconds
- Units B and C immediately read their sensors upon receiving SYNC
- Unit A reads its own sensor at the same time
- **Result**: All temperatures are read at the same moment

### 2. Persistent Calibration
- Each unit can have a calibration offset stored in NVS (non-volatile storage)
- Offsets survive reboots and power cycles
- Applied automatically to all temperature readings
- Managed via HTTP API

## HTTP API Endpoints

### Trigger Synchronized Reading
```
GET http://<unit-a-ip>/sync
```
Forces an immediate synchronized read across all three units.

### Set Calibration Offset
```
GET http://<unit-a-ip>/set_cal?unit=a&offset=0.5
GET http://<unit-a-ip>/set_cal?unit=b&offset=-0.3
GET http://<unit-a-ip>/set_cal?unit=c&offset=1.2
```
- `unit`: a, b, or c
- `offset`: float value in °C (positive or negative)
- Automatically saved to NVS

### Get Current Calibration
```
GET http://<unit-a-ip>/get_cal
```
Returns JSON:
```json
{
  "ok": true,
  "cal_a": 0.5,
  "cal_b": -0.3,
  "cal_c": 1.2
}
```

### Reset Calibration
```
GET http://<unit-a-ip>/reset_cal
```
Sets all offsets back to 0.0 and saves to NVS.

## Calibration Procedure

### Step 1: Baseline Measurement
1. Place all three units in the same location (close together)
2. Wait 10-15 minutes for temperatures to stabilize
3. Trigger a sync read: `http://<unit-a-ip>/sync`
4. Check temperatures:
   - `http://<unit-a-ip>/temp_a`
   - `http://<unit-a-ip>/temp_b`
   - `http://<unit-a-ip>/temp_c`

### Step 2: Choose Reference
Pick the most accurate sensor as your reference (typically Unit B with SHT30).
Example readings:
- Unit A (DHT22): 23.5°C
- Unit B (SHT30): 23.2°C ← reference
- Unit C (DHT11): 24.8°C

### Step 3: Calculate Offsets
Calculate what offset each unit needs to match the reference:
- Unit A: 23.2 - 23.5 = **-0.3°C**
- Unit B: 23.2 - 23.2 = **0.0°C** (reference)
- Unit C: 23.2 - 24.8 = **-1.6°C**

### Step 4: Apply Calibration
```bash
# Apply offsets
curl "http://<unit-a-ip>/set_cal?unit=a&offset=-0.3"
curl "http://<unit-a-ip>/set_cal?unit=b&offset=0.0"
curl "http://<unit-a-ip>/set_cal?unit=c&offset=-1.6"

# Trigger sync read to verify
curl "http://<unit-a-ip>/sync"
```

### Step 5: Verify
After 5-10 seconds, check all temperatures again. They should now be very close (within ±0.1-0.3°C).

### Step 6: Test Persistence
Reboot Unit A and verify calibration persists:
1. Power cycle Unit A
2. Wait for it to reconnect to WiFi
3. Check calibration: `http://<unit-a-ip>/get_cal`
4. Trigger sync: `http://<unit-a-ip>/sync`
5. Verify temperatures are still aligned

## How It Works

### Sync Packet
```cpp
struct SyncPacket { 
    uint8_t magic;  // 0xCC
    uint8_t cmd;    // 1 = read_now
};
```

### Flow Diagram
```
Unit A (every 30s)
    |
    ├─> Broadcast SYNC (0xCC, 1)
    |       |
    |       ├──> Unit B receives → reads SHT30 → sends TempPacket
    |       |
    |       └──> Unit C receives → reads DHT11 → sends TempPacket
    |
    └─> Read DHT22 locally

    All readings happen within ~50-100ms of each other
```

### Calibration Storage
- Stored in ESP32 NVS (non-volatile storage) namespace "espnow"
- Keys: `cal_a`, `cal_b`, `cal_c` (float values)
- Loaded on boot in Unit A's `setup()`
- Saved immediately when changed via `/set_cal`

### Applied Calibration
```cpp
// Unit A receiving from Unit B
_tempB_c = raw_temp_from_B + _calOffset_B;

// Unit A reading its own sensor
_tempA_c = raw_temp_from_DHT22 + _calOffset_A;
```

## Troubleshooting

### Temperatures Still Drift
- **Check physical setup**: Are units in different air currents, near heat sources, or in direct sunlight?
- **Sensor placement**: DHT sensors are slower to respond than SHT30. Wait longer for stabilization.
- **Re-calibrate**: Environmental changes may require periodic recalibration.

### Calibration Not Persisting
- Check serial monitor for "Loaded: A=X.XX, B=X.XX, C=X.XX" message on boot
- If all zeros, calibration wasn't saved. Try `/set_cal` again.
- NVS may be corrupted - try `/reset_cal` then recalibrate.

### Sync Not Working
- Check serial monitors on Units B and C for "SYNC received" messages
- Verify ESP-NOW channel is consistent (check `ESPNOW_CHANNEL` in code)
- Confirm Units B and C are running and connected

### Offset Seems Wrong
- Remember: offset is ADDED to the raw reading
- If unit reads HIGH, use NEGATIVE offset
- If unit reads LOW, use POSITIVE offset

## Example Script

```bash
#!/bin/bash
IP="192.168.1.100"  # Replace with Unit A's IP

# Reset calibration
curl "$IP/reset_cal"
sleep 1

# Trigger sync and wait
curl "$IP/sync"
sleep 5

# Read all temps (parse JSON with jq if available)
echo "Unit A:" && curl -s "$IP/temp_a" | jq .temp_c
echo "Unit B:" && curl -s "$IP/temp_b" | jq .temp_c
echo "Unit C:" && curl -s "$IP/temp_c" | jq .temp_c

# Calculate offsets manually, then apply
# (example assuming B=23.2, A=23.5, C=24.8)
curl "$IP/set_cal?unit=a&offset=-0.3"
curl "$IP/set_cal?unit=b&offset=0.0"
curl "$IP/set_cal?unit=c&offset=-1.6"

# Verify
curl "$IP/sync"
sleep 5
curl -s "$IP/temp_a" | jq .temp_c
curl -s "$IP/temp_b" | jq .temp_c
curl -s "$IP/temp_c" | jq .temp_c
```

## Serial Monitor Output

**Unit A:**
```
[cal] Loaded: A=-0.30, B=0.00, C=-1.60
WiFi OK  IP=192.168.1.100  CH=11  RSSI=-45
HTTP server ready
Endpoints: /sync /set_cal?unit=a&offset=0.5 /get_cal /reset_cal
[A] Broadcast SYNC READ
[A] raw=23.5C cal=23.2C hum=45%
[recv B] raw=23.2C cal=23.2C hum=44%
[recv C] raw=24.8C cal=23.2C hum=46%
```

**Unit B:**
```
Unit B — RECEIVER + SHT30
SHT30 OK at 0x44
WiFi STA (no AP), locked to CH=11
Ready — pings every 500ms, temp on SYNC command
[B] SYNC received — reading now
[B] temp=23.2C hum=44%
```

**Unit C:**
```
Unit C — UNIT_C + DHT11
WiFi STA (no AP), locked to CH=11
Ready — pings every 500ms, temp on SYNC command
[C] SYNC received — reading now
[C] temp=24.8C hum=46%
```
