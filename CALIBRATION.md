# Temperature Sensor Calibration System

## Overview

This system implements a single, unified database-driven **peer calibration** workflow for cross-calibrating the three colocated ESP32-S3 temperature monitors. 

Rather than relying on confusing local browser storage offsets or manual ESP32 firmware-level calibration commands, the server-side SQLite database (`calibration_coefficients` table) is the **single source of truth** for calibration coefficients.

## How It Works

### 1. Mathematical Model

Each sensor has inherent bias and response drift. We correct these using a linear calibration formula:

```
T_corrected = c0 + c1 * T_raw
```

Where:
- `T_raw` = raw temperature reading from the sensor (°C)
- `T_corrected` = calibrated/corrected temperature (°C)
- `c0` = intercept coefficient (offset)
- `c1` = slope coefficient (set to `1.0` in offset fallback mode)

If the temperature range/spread in the collected data is too narrow (< 1.0°C), the system automatically falls back to a stable **offset-only** calibration:
```
T_corrected = T_raw + offset
```

### 2. Peer Calibration Algorithm

When colocated in the physical environment, all three units *should* read the exact same temperature.
1. The backend collects timestamps where all 3 monitors reported valid readings.
2. For each timestamp, it calculates the **Group Mean** (average of A, B, and C readings) to act as the "true" target temperature.
3. It fits a linear model (`T_corrected = c0 + c1 * T_raw`) for each unit against the group mean.
4. **Sanity checking & safety validation**:
   - The calculated intercept must be within `[-15, 15]`°C and slope within `[0.7, 1.3]`. If outside, it automatically falls back to the offset method.
   - Post-calibration unit-to-unit spread is checked against raw spread. If calibration would degrade the sensor-to-sensor alignment (making it worse), the calibration is automatically rejected to guarantee improvement.

---

## Calibration Steps

### Step 1: Co-locate the Sensors
Place Unit A, Unit B, and Unit C in the **exact same physical spot** (side-by-side).

### Step 2: Let them run
Leave the modules running for **several hours or overnight** to accumulate historical synchronized readings.

### Step 3: Build Calibration
1. Navigate to the **Calibration Curve** tab on the dashboard (http://localhost:3000).
2. Select the historical window to analyze (e.g., "Last 24 Hours").
3. (Optional) Check "Dry run / preview only" to preview the results, formulas, and spread improvement without saving.
4. Click **Build Calibration From History**.
5. Once saved, the primary temperature readouts and historical trends will immediately reflect the new calibration.

### Step 4: Reset / Clear
If you want to revert to the raw sensor readings:
1. Go to the **Calibration Curve** tab.
2. Click **Clear Calibration**.

---

## Technical Details

### API Endpoints
- `POST /api/calibration/build-from-history` - Build and save linear/offset coefficients from historical data (body: `{ hours: number, dryRun: boolean }`).
- `GET /api/calibration/coefficients` - Retrieve active coefficients for all units.
- `DELETE /api/calibration/coefficients` - Clear all active coefficients.
- `GET /api/temperature/history/calibrated` - Get history with calibrated temperature values.

### Cache Optimization
Applying calibration equations over thousands of data points on history queries can cause high database load. To optimize performance, the database layer (`server/db.js`) uses an **in-memory coefficients cache** to serve calibration coefficients in O(1) time, invalidating/reloading the cache automatically when coefficients are saved or cleared.

### Testing
Verify fitting math and regression checks at any time:
```bash
npm run test
```
