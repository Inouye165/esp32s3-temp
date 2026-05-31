# Temperature Logging & Graphing

This document describes the temperature logging and visualization system added to the ESP32 mesh dashboard.

## Overview

The system automatically logs temperature readings from all three ESP32 units every 5 minutes and displays them in a time-series graph on the dashboard.

## Architecture

### Data Flow

```
ESP32 Units → Server (every 5 min) → SQLite Database → Frontend Graph
     ↓
  ESP-NOW sync reading (every 30s)
```

### Components

1. **Server Polling** (`server/server.js`)
   - Polls `/temp_a`, `/temp_b`, `/temp_c` from ESP32 Unit A every 5 minutes
   - Saves readings to SQLite database with timestamp
   - Broadcasts new readings to WebSocket clients

2. **Database Layer** (`server/db.js`)
   - SQLite for development (easy to use, no setup)
   - Abstraction layer designed for easy migration to PostgreSQL/MySQL
   - Stores: `unit_id`, `unit_name`, `temp_c`, `humidity`, `timestamp`
   - Indexes on `timestamp` and `unit_id` for fast queries

3. **API Endpoints**
   - `GET /api/temperature/history` - Get historical readings
   - `GET /api/temperature/latest` - Get most recent reading for each unit
   - `GET /api/temperature/stats/:unitId` - Get statistics (avg, min, max)
   - `GET /api/temperature/unit/:unitId` - Get readings for specific unit

4. **Frontend Graph** (`server/public/index.html`)
   - Chart.js time-series visualization
   - Three lines: Unit A (blue), Unit B (green), Unit C (yellow)
   - Time range controls: 1h, 6h, 24h, 7d
   - Auto-refreshes every minute
   - Displays temperature in °F (converts from °C)

## Database Schema

```sql
CREATE TABLE temperature_readings (
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
```

## Configuration

### Environment Variables

- `DB_PATH` - SQLite database file path (default: `server/temperatures.db`)
- `ESP_IP` - IP address of Unit A (already configured in `.env`)

### Polling Interval

To change the 5-minute polling interval, edit `server/server.js`:

```javascript
// Poll every 5 minutes (300,000 ms)
setInterval(pollTemperature, 5 * 60 * 1000);
```

## Migrating to a Production Database

The code is structured to make database migration easy. See `server/db.js` for detailed instructions.

### PostgreSQL Migration

1. Install `pg` package:
   ```bash
   npm install pg
   ```

2. Replace connection in `db.js`:
   ```javascript
   const { Pool } = require('pg');
   const pool = new Pool({
     host: 'localhost',
     database: 'esp32_temperatures',
     user: 'your_user',
     password: 'your_password',
   });
   ```

3. Update schema (replace `AUTOINCREMENT` with `SERIAL`)

4. Replace `db.prepare().run()` with `await pool.query()`

5. Replace `.all()` with `(await pool.query()).rows`

### MySQL Migration

1. Install `mysql2` package:
   ```bash
   npm install mysql2
   ```

2. Replace connection in `db.js`:
   ```javascript
   const mysql = require('mysql2/promise');
   const pool = mysql.createPool({
     host: 'localhost',
     database: 'esp32_temperatures',
     user: 'your_user',
     password: 'your_password',
   });
   ```

3. Update schema (replace `AUTOINCREMENT` with `AUTO_INCREMENT`)

4. Use `await pool.execute()` for queries

## API Usage Examples

### Get last 24 hours of data

```bash
curl http://localhost:3000/api/temperature/history?hours=24
```

### Get last 1000 readings

```bash
curl http://localhost:3000/api/temperature/history?hours=168&limit=1000
```

### Get latest reading for each unit

```bash
curl http://localhost:3000/api/temperature/latest
```

### Get statistics for Unit A (last 24 hours)

```bash
curl http://localhost:3000/api/temperature/stats/a?hours=24
```

### Get all readings for Unit B (last 6 hours)

```bash
curl http://localhost:3000/api/temperature/unit/b?hours=6
```

## Response Format

### History Response

```json
{
  "ok": true,
  "count": 144,
  "readings": [
    {
      "id": 1,
      "unit_id": "a",
      "unit_name": "Unit A (DHT22)",
      "temp_c": 24.5,
      "humidity": 45,
      "timestamp": 1735635429,
      "created_at": "2024-12-31 06:17:09"
    },
    // ... more readings
  ]
}
```

### Latest Response

```json
{
  "ok": true,
  "readings": {
    "a": {
      "unit_id": "a",
      "unit_name": "Unit A (DHT22)",
      "temp_c": 24.5,
      "humidity": 45,
      "timestamp": 1735635429
    },
    "b": { /* ... */ },
    "c": { /* ... */ }
  }
}
```

### Stats Response

```json
{
  "ok": true,
  "unitId": "a",
  "hours": 24,
  "stats": {
    "count": 288,
    "avg_temp": 24.3,
    "min_temp": 23.1,
    "max_temp": 25.7,
    "avg_humidity": 46.2
  }
}
```

## Dashboard Features

### Temperature Graph

Located at the bottom of the dashboard, below the signal strength panel.

**Features:**
- Three colored lines for each unit
- Time range buttons: 1h, 6h, 24h, 7d
- Hover tooltips showing exact values
- Auto-refresh every minute
- Handles missing data gracefully (sensor failures)

**Colors:**
- Unit A (DHT22): Blue (#7ecfff)
- Unit B (SHT30): Green (#5fdb8a)
- Unit C (DHT11): Yellow (#facc15)

## Maintenance

### Database Cleanup

Old readings can be cleaned up using the provided function:

```javascript
const db = require('./db');
// Delete readings older than 30 days
const deleted = db.cleanupOldReadings(30);
console.log(`Deleted ${deleted} old readings`);
```

You can add this to a scheduled task (cron job or systemd timer) for automatic cleanup.

### Monitoring

The server logs each temperature poll:

```
[temp poll] Logged at 5/31/2026, 6:17:09 AM
```

Failed polls log errors but continue running (graceful degradation).

## Troubleshooting

### Graph shows no data

1. Check server logs for temperature polling
2. Verify ESP32 Unit A is powered on and accessible at `ESP_IP`
3. Check database file exists: `server/temperatures.db`
4. Verify database has readings: `sqlite3 server/temperatures.db "SELECT COUNT(*) FROM temperature_readings;"`

### Temperature readings are null

- This indicates sensor communication failure on the ESP32
- Unit is online but sensor is not responding
- Check ESP32 serial monitor for sensor errors
- Verify sensor connections and power

### Database errors

- Ensure `better-sqlite3` is installed: `npm install`
- Check file permissions on `temperatures.db`
- For migration issues, see comments in `server/db.js`

## Performance Notes

- SQLite handles ~1 reading per 5 minutes × 3 units = ~864 readings/day
- 30 days = ~25,000 readings (< 5MB database size)
- For high-scale deployments, migrate to PostgreSQL
- Database uses WAL mode for better write concurrency
- Indexes ensure fast queries even with large datasets

## Future Enhancements

Potential improvements for production deployments:

1. **Database migrations** - Track schema versions
2. **Aggregations** - Pre-compute hourly/daily averages
3. **Alerts** - Email/SMS when temperature exceeds thresholds
4. **Export** - CSV/JSON download of historical data
5. **Retention policies** - Automatic cleanup of old data
6. **Multi-node** - Support multiple ESP32 mesh networks
7. **Authentication** - Secure API endpoints
8. **HTTPS** - TLS encryption for production
