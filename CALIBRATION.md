# Temperature Sensor Calibration System

## Overview

This system implements **polynomial calibration** for cross-calibrating multiple temperature sensors. It uses peer calibration (sensors calibrating against each other) or against an independent reference thermometer.

## How It Works

### 1. Theory

Each sensor has inherent bias and non-linear response characteristics. We correct these using a polynomial function:

```
T_corrected = c0 + c1*T_raw + c2*T_raw² + c3*T_raw³
```

Where:
- `T_raw` = raw sensor reading (°C)
- `T_corrected` = calibrated temperature (°C)
- `c0, c1, c2, c3` = polynomial coefficients (computed from calibration data)

### 2. Calibration Process

#### Step 1: Collect Calibration Points

You need **at least 5 calibration points** spread across your expected temperature range. For example:

| Environment | Approximate Temp |
|------------|-----------------|
| Fridge | 4°C (39°F) |
| Cold outdoor | 10°C (50°F) |
| Room temperature | 20°C (68°F) |
| Warm outdoor | 30°C (86°F) |
| Hot environment | 40°C+ (104°F+) |

**Important**: Let sensors stabilize for 10-15 minutes before logging each point.

#### Step 2: Create Calibration Sessions

1. Place all sensors in the same stable environment
2. Wait 10-15 minutes for thermal equilibrium
3. In the dashboard, go to **Calibration** tab
4. Create a new calibration session:
   - **Session Name**: Optional (e.g., "Indoor baseline")
   - **Start Time / End Time**: Select the time range when sensors were stable together
   - **Reference Temp**: 
     - Leave empty to use the mean of all sensors as truth
     - OR enter an independent thermometer reading (more accurate)
   - **Notes**: Optional (e.g., "All sensors in living room")
5. Click **Preview Data** to verify the readings
6. Click **Create Session** to save

Repeat this process for each temperature point (minimum 5 different temperatures).

#### Step 3: Compute Calibration

After collecting 5+ sessions:

1. In the **Calibration** tab, scroll to "Compute Calibration Coefficients"
2. Select polynomial degree:
   - **Degree 2 (Quadratic)**: Recommended for most cases
   - **Degree 1 (Linear)**: If you only have 2-3 points
   - **Degree 3 (Cubic)**: For very non-linear sensors (rare)
3. Click **Compute Now**
4. The system will calculate coefficients for each sensor and display:
   - RMSE (Root Mean Square Error) — lower is better
   - Number of data points used
   - Polynomial coefficients

#### Step 4: Verify Calibration

- Calibrated values appear in the main Controls tab under each sensor's temperature
- Look for the 📐 icon showing the calibrated reading
- Compare raw vs. calibrated values
- If RMSE is high (>1°C), collect more calibration points or check for outliers

## Using the System

### Dashboard Features

#### Calibration Tab
- **Create Calibration Sessions**: Define time ranges with stable readings
- **View Sessions**: See all your calibration points
- **Compute Calibration**: Calculate polynomial coefficients
- **View Coefficients**: See active calibration parameters
- **Delete**: Remove sessions or coefficients

#### Controls Tab
- Temperature displays now show:
  - Raw reading with offset (main value)
  - Calibrated reading (📐 Cal: XX.X °F)

### API Endpoints

The system exposes these REST endpoints:

- `GET /api/calibration/sessions` - List all calibration sessions
- `POST /api/calibration/sessions` - Create a new session
- `DELETE /api/calibration/sessions/:id` - Delete a session
- `GET /api/calibration/preview` - Preview readings for a time range
- `POST /api/calibration/compute` - Compute coefficients (body: `{degree: 2}`)
- `GET /api/calibration/coefficients` - Get all current coefficients
- `GET /api/calibration/coefficients/:unitId` - Get coefficients for one unit
- `DELETE /api/calibration/coefficients/:unitId` - Delete calibration
- `GET /api/temperature/history/calibrated` - Get history with calibrated values

### Database Schema

Three new tables:

1. **calibration_sessions**: Stores time ranges when sensors were stable together
2. **calibration_coefficients**: Stores polynomial coefficients per sensor
3. Temperature readings table unchanged (backwards compatible)

## Best Practices

### For Accurate Calibration

1. **More points = better**: Aim for 7-10 calibration points across your range
2. **Spread your points**: Cover the full temperature range you'll measure
3. **Stable readings**: Wait 10-15 minutes for thermal equilibrium
4. **Independent reference**: Use a trusted thermometer when possible
5. **Check RMSE**: Should be <0.5°C for good calibration, <0.2°C for excellent

### Common Issues

**"Not enough data points"**
- You need at least `degree + 1` points (e.g., 3 points for degree 2)
- Create more calibration sessions

**High RMSE (>1°C)**
- Sensors moved during data collection
- Not enough stabilization time
- Outlier readings — review and delete bad sessions

**"Singular matrix" error**
- All calibration points are at the same temperature
- Need temperature spread across your range

## Example Workflow

```
1. Day 1: Fridge (4°C)
   - Place sensors in fridge
   - Wait 15 minutes
   - Create session: "Fridge baseline" with reference 4°C

2. Day 1: Room (20°C)
   - Move sensors to room
   - Wait 15 minutes
   - Create session: "Room temp" with reference 20°C

3. Day 2: Outside cold (10°C)
   - Place sensors outside
   - Wait 15 minutes
   - Create session: "Cold outdoor"

4. Day 2: Outside warm (30°C)
   - Wait for afternoon
   - Wait 15 minutes
   - Create session: "Warm outdoor"

5. Day 3: Hot location (40°C)
   - Place in car/hot space
   - Wait 15 minutes
   - Create session: "Hot environment"

6. Compute calibration (degree 2)
7. Verify RMSE < 0.5°C
8. Done! Calibration active automatically
```

## Technical Details

### Polynomial Fitting

Uses least-squares regression with Gaussian elimination for solving the normal equations:

```
(A^T * A) * coeffs = A^T * b
```

Where A is the design matrix of [1, T, T², T³] for each calibration point.

### Computation

- Server-side in [calibration.js](server/calibration.js)
- Pure JavaScript implementation (no external dependencies)
- Handles 1st, 2nd, and 3rd degree polynomials

### Storage

- Coefficients stored in SQLite database
- Persisted across server restarts
- Applied in real-time via `applyCalibratedTemp()` function

## Files Modified

- `server/db.js` - Database schema and functions
- `server/calibration.js` - NEW: Polynomial fitting algorithm
- `server/server.js` - API endpoints
- `server/public/index.html` - UI components

## References

- Polynomial regression: https://en.wikipedia.org/wiki/Polynomial_regression
- Sensor calibration: https://en.wikipedia.org/wiki/Calibration
- Cross-calibration: Using multiple sensors to calibrate each other
