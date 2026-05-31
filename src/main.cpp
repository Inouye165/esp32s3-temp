// ============================================================================
// ESP-NOW practice — 3-unit mesh (Unit A + Unit B + Unit C)
//
//   Unit A  (-DROLE_SENDER)   COM12  MAC a4:cb:8f:d1:ef:58  DHT22  + WiFi hub
//   Unit B  (-DROLE_RECEIVER) COM11  MAC a4:cb:8f:d1:f2:a8  SHT30  ESP-NOW only
//   Unit C  (-DROLE_UNIT_C)   COM14  MAC a4:cb:8f:d1:ef:a0  DHT11  ESP-NOW only
//
// Wiring
//   Unit A : DHT22 data -> GPIO 4 ; WS2812B RGB LED on GPIO 48
//   Unit B : SHT30 SDA  -> GPIO 8 ; SHT30 SCL -> GPIO 9 ; WS2812B on GPIO 48
//   Unit C : DHT11 data -> GPIO 4 ; WS2812B RGB LED on GPIO 48
//
// ESP-NOW packets
//   ColorPacket  (3 B)  A -> B,C   r,g,b
//   TempPacket   (5 B)  B,C -> A   float temp_c, uint8_t humidity
//   PingPacket   (2 B)  B,C -> A   magic=0xBB, seq    (A measures RSSI)
// ============================================================================

#include <Arduino.h>
#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>
#include <Preferences.h>
#include "credentials.h"

Preferences prefs;

#ifndef ESPNOW_CHANNEL
#define ESPNOW_CHANNEL 11   // must match Unit A's router channel
#endif

#define LED_PIN 48

// ---- Packet types ----------------------------------------------------------
struct __attribute__((packed)) ColorPacket { uint8_t r, g, b; };
struct __attribute__((packed)) TempPacket  { float   temp_c; uint8_t humidity; };
struct __attribute__((packed)) PingPacket  { uint8_t magic;  uint8_t seq; };
struct __attribute__((packed)) SyncPacket  { uint8_t magic;  uint8_t cmd; }; // magic=0xCC, cmd: 1=read_now

// ============================================================================
// COMMON: bring up WiFi STA + lock channel (used by both roles)
// ============================================================================
static void initEspNowWiFi(bool connectToAp) {
    WiFi.mode(WIFI_STA);
    if (connectToAp) {
        WiFi.begin(WIFI_SSID, WIFI_PASS);
        Serial.print("WiFi connecting");
        unsigned long t0 = millis();
        while (WiFi.status() != WL_CONNECTED && millis() - t0 < 15000) {
            delay(250); Serial.print('.');
        }
        Serial.println();
        if (WiFi.status() == WL_CONNECTED) {
            Serial.printf("WiFi OK  IP=%s  CH=%d  RSSI=%d\n",
                WiFi.localIP().toString().c_str(), WiFi.channel(), WiFi.RSSI());
        } else {
            Serial.println("WiFi FAILED — continuing in STA mode");
        }
    } else {
        // No AP, just lock channel for ESP-NOW
        esp_wifi_set_promiscuous(true);
        esp_wifi_set_channel(ESPNOW_CHANNEL, WIFI_SECOND_CHAN_NONE);
        esp_wifi_set_promiscuous(false);
        Serial.printf("WiFi STA (no AP), locked to CH=%d\n", ESPNOW_CHANNEL);
    }
}

// ============================================================================
// UNIT A — sender + WiFi hub + HTTP API
// ============================================================================
#ifdef ROLE_SENDER

#include <WebServer.h>
#include <DHT.h>

#define DHT_PIN  4
#define DHT_TYPE DHT22

DHT dht(DHT_PIN, DHT_TYPE);
WebServer server(80);

// MAC addresses
uint8_t RECEIVER_B_MAC[] = { 0xa4, 0xcb, 0x8f, 0xd1, 0xf2, 0xa8 };  // Unit B SHT30
uint8_t RECEIVER_C_MAC[] = { 0xa4, 0xcb, 0x8f, 0xd1, 0xef, 0xa0 };  // Unit C DHT11

// ---- Cached values ----
static float    _tempA_c   = NAN;
static uint8_t  _humA      = 0;
static unsigned long _tempA_time = 0;

static float    _tempB_c   = NAN;
static uint8_t  _humB      = 0;
static unsigned long _tempB_time = 0;

static float    _tempC_c   = NAN;
static uint8_t  _humC      = 0;
static unsigned long _tempC_time = 0;

static int8_t        _rssiB_atA  = 0;
static unsigned long _rssiB_time = 0;

static int8_t        _rssiC_atA  = 0;
static unsigned long _rssiC_time = 0;

// ---- Calibration offsets (persistent in NVS) ----
static float _calOffset_A = 0.0f;  // offset for Unit A
static float _calOffset_B = 0.0f;  // offset for Unit B
static float _calOffset_C = 0.0f;  // offset for Unit C

static void loadCalibration() {
    prefs.begin("espnow", true); // read-only
    _calOffset_A = prefs.getFloat("cal_a", 0.0f);
    _calOffset_B = prefs.getFloat("cal_b", 0.0f);
    _calOffset_C = prefs.getFloat("cal_c", 0.0f);
    prefs.end();
    Serial.printf("[cal] Loaded: A=%.2f, B=%.2f, C=%.2f\n", 
                  _calOffset_A, _calOffset_B, _calOffset_C);
}

static void saveCalibration() {
    prefs.begin("espnow", false); // read-write
    prefs.putFloat("cal_a", _calOffset_A);
    prefs.putFloat("cal_b", _calOffset_B);
    prefs.putFloat("cal_c", _calOffset_C);
    prefs.end();
    Serial.printf("[cal] Saved: A=%.2f, B=%.2f, C=%.2f\n", 
                  _calOffset_A, _calOffset_B, _calOffset_C);
}

// ---- WiFi watchdog ----
static unsigned long _lastWifiCheck = 0;
static unsigned long _wifiDownSince = 0;

static void checkWiFi() {
    unsigned long now = millis();
    if (now - _lastWifiCheck < 5000) return;
    _lastWifiCheck = now;
    if (WiFi.status() == WL_CONNECTED) {
        _wifiDownSince = 0;
        return;
    }
    if (_wifiDownSince == 0) {
        _wifiDownSince = now;
        Serial.println("[wifi] disconnected, attempting reconnect");
        WiFi.reconnect();
    } else if (now - _wifiDownSince > 30000) {
        Serial.println("[wifi] down >30s, rebooting");
        delay(100);
        ESP.restart();
    }
}

// ---- ESP-NOW receive (from Unit B and C) ----
static void onReceive(const esp_now_recv_info_t *info, const uint8_t *data, int len) {
    const uint8_t *mac = info->src_addr;
    bool isB = (memcmp(mac, RECEIVER_B_MAC, 6) == 0);
    bool isC = (memcmp(mac, RECEIVER_C_MAC, 6) == 0);
    
    if (len == (int)sizeof(TempPacket)) {
        TempPacket pkt; memcpy(&pkt, data, sizeof(pkt));
        if (isB) {
            _tempB_c    = pkt.temp_c + _calOffset_B;  // Apply calibration
            _humB       = pkt.humidity;
            _tempB_time = millis();
            Serial.printf("[recv B] raw=%.1fC cal=%.1fC hum=%d%%\n", 
                         pkt.temp_c, _tempB_c, pkt.humidity);
        } else if (isC) {
            _tempC_c    = pkt.temp_c + _calOffset_C;  // Apply calibration
            _humC       = pkt.humidity;
            _tempC_time = millis();
            Serial.printf("[recv C] raw=%.1fC cal=%.1fC hum=%d%%\n", 
                         pkt.temp_c, _tempC_c, pkt.humidity);
        }
    } else if (len == (int)sizeof(PingPacket)) {
        PingPacket pkt; memcpy(&pkt, data, sizeof(pkt));
        if (pkt.magic == 0xBB) {
            int8_t rssi = (int8_t)info->rx_ctrl->rssi;
            if (isB) {
                _rssiB_atA  = rssi;
                _rssiB_time = millis();
            } else if (isC) {
                _rssiC_atA  = rssi;
                _rssiC_time = millis();
            }
        }
    }
}

// ---- Local sensor read ----
static void readLocalTemp() {
    float t = dht.readTemperature();
    float h = dht.readHumidity();
    if (isnan(t) || isnan(h)) {
        Serial.println("[A] DHT22 read failed");
        return;
    }
    _tempA_c    = t + _calOffset_A;  // Apply calibration
    _humA       = (uint8_t)(h + 0.5f);
    _tempA_time = millis();
    Serial.printf("[A] raw=%.1fC cal=%.1fC hum=%d%%\n", t, _tempA_c, _humA);
}

// ---- Broadcast sync command ----
static void broadcastSyncRead() {
    SyncPacket sync = { 0xCC, 1 };  // cmd=1 means "read now"
    esp_now_send(RECEIVER_B_MAC, (uint8_t *)&sync, sizeof(sync));
    esp_now_send(RECEIVER_C_MAC, (uint8_t *)&sync, sizeof(sync));
    Serial.println("[A] Broadcast SYNC READ");
    delay(50);  // Give units time to process
    readLocalTemp();  // Unit A reads too
}

// ---- HTTP handlers ----
static bool parseRgb(uint8_t &r, uint8_t &g, uint8_t &b) {
    if (!server.hasArg("r") || !server.hasArg("g") || !server.hasArg("b")) return false;
    int rv = server.arg("r").toInt();
    int gv = server.arg("g").toInt();
    int bv = server.arg("b").toInt();
    if (rv < 0 || rv > 255 || gv < 0 || gv > 255 || bv < 0 || bv > 255) return false;
    r = (uint8_t)rv; g = (uint8_t)gv; b = (uint8_t)bv;
    return true;
}

static void handleColor() {
    uint8_t r, g, b;
    if (!parseRgb(r, g, b)) { server.send(400, "text/plain", "bad args"); return; }
    rgbLedWrite(LED_PIN, r, g, b);
    Serial.printf("[A] LED set RGB(%d,%d,%d)\n", r, g, b);
    server.send(200, "text/plain", "ok");
}

static void handleForward() {
    uint8_t r, g, b;
    if (!parseRgb(r, g, b)) { server.send(400, "text/plain", "bad args"); return; }
    ColorPacket pkt = { r, g, b };
    esp_err_t e = esp_now_send(RECEIVER_B_MAC, (uint8_t *)&pkt, sizeof(pkt));
    Serial.printf("[A->B] RGB(%d,%d,%d) send=%d\n", r, g, b, (int)e);
    server.send(200, "text/plain", e == ESP_OK ? "ok" : "send failed");
}

static void handleForwardC() {
    uint8_t r, g, b;
    if (!parseRgb(r, g, b)) { server.send(400, "text/plain", "bad args"); return; }
    ColorPacket pkt = { r, g, b };
    esp_err_t e = esp_now_send(RECEIVER_C_MAC, (uint8_t *)&pkt, sizeof(pkt));
    Serial.printf("[A->C] RGB(%d,%d,%d) send=%d\n", r, g, b, (int)e);
    server.send(200, "text/plain", e == ESP_OK ? "ok" : "send failed");
}

static void handleTempA() {
    char buf[128];
    if (isnan(_tempA_c)) {
        snprintf(buf, sizeof(buf), "{\"ok\":false,\"message\":\"no data\"}");
    } else {
        unsigned long age = (millis() - _tempA_time) / 1000;
        snprintf(buf, sizeof(buf),
            "{\"ok\":true,\"temp_c\":%.2f,\"humidity\":%d,\"age\":%lu}",
            _tempA_c, _humA, age);
    }
    server.send(200, "application/json", buf);
}

static void handleTempB() {
    char buf[128];
    if (_tempB_time == 0) {
        snprintf(buf, sizeof(buf), "{\"ok\":false,\"message\":\"no data\"}");
    } else {
        unsigned long age = (millis() - _tempB_time) / 1000;
        snprintf(buf, sizeof(buf),
            "{\"ok\":true,\"temp_c\":%.2f,\"humidity\":%d,\"age\":%lu}",
            _tempB_c, _humB, age);
    }
    server.send(200, "application/json", buf);
}

static void handleTempC() {
    char buf[128];
    if (_tempC_time == 0) {
        snprintf(buf, sizeof(buf), "{\"ok\":false,\"message\":\"no data\"}");
    } else {
        unsigned long age = (millis() - _tempC_time) / 1000;
        snprintf(buf, sizeof(buf),
            "{\"ok\":true,\"temp_c\":%.2f,\"humidity\":%d,\"age\":%lu}",
            _tempC_c, _humC, age);
    }
    server.send(200, "application/json", buf);
}

static void handleRssi() {
    char buf[384];
    unsigned long ageB = _rssiB_time ? (millis() - _rssiB_time) / 1000 : 9999;
    unsigned long ageC = _rssiC_time ? (millis() - _rssiC_time) / 1000 : 9999;
    snprintf(buf, sizeof(buf),
        "{\"ok\":true,"
         "\"wifi\":{\"rssi\":%d,\"ch\":%d},"
         "\"b\":{\"rssi\":%d,\"age\":%lu},"
         "\"c\":{\"rssi\":%d,\"age\":%lu}}",
        (int)WiFi.RSSI(), WiFi.channel(),
        _rssiB_time ? _rssiB_atA : 0, ageB,
        _rssiC_time ? _rssiC_atA : 0, ageC);
    server.send(200, "application/json", buf);
}

static void handleSync() {
    broadcastSyncRead();
    server.send(200, "text/plain", "sync read triggered");
}

static void handleSetCal() {
    // /set_cal?unit=a&offset=0.5
    if (!server.hasArg("unit") || !server.hasArg("offset")) {
        server.send(400, "text/plain", "missing unit or offset");
        return;
    }
    String unit = server.arg("unit");
    float offset = server.arg("offset").toFloat();
    
    if (unit == "a") {
        _calOffset_A = offset;
    } else if (unit == "b") {
        _calOffset_B = offset;
    } else if (unit == "c") {
        _calOffset_C = offset;
    } else {
        server.send(400, "text/plain", "invalid unit (use a, b, or c)");
        return;
    }
    
    saveCalibration();
    server.send(200, "text/plain", "calibration saved");
}

static void handleGetCal() {
    char buf[256];
    snprintf(buf, sizeof(buf),
        "{\"ok\":true,"
         "\"cal_a\":%.2f,"
         "\"cal_b\":%.2f,"
         "\"cal_c\":%.2f}",
        _calOffset_A, _calOffset_B, _calOffset_C);
    server.send(200, "application/json", buf);
}

static void handleResetCal() {
    _calOffset_A = 0.0f;
    _calOffset_B = 0.0f;
    _calOffset_C = 0.0f;
    saveCalibration();
    server.send(200, "text/plain", "calibration reset to zero");
}

void setup() {
    Serial.begin(115200);
    delay(500);
    Serial.println("\nUnit A — SENDER + DHT22 + WiFi hub");

    pinMode(LED_PIN, OUTPUT);
    rgbLedWrite(LED_PIN, 0, 0, 0);

    dht.begin();
    
    loadCalibration();  // Load persistent calibration offsets

    initEspNowWiFi(true);

    if (esp_now_init() != ESP_OK) { Serial.println("ESP-NOW init FAILED"); return; }
    esp_now_register_recv_cb(onReceive);

    // Register Unit B and C as peers (use whatever channel WiFi negotiated)
    esp_now_peer_info_t peerB = {};
    memcpy(peerB.peer_addr, RECEIVER_B_MAC, 6);
    peerB.channel = 0;
    peerB.encrypt = false;
    if (esp_now_add_peer(&peerB) != ESP_OK) { Serial.println("Add peer B FAILED"); return; }

    esp_now_peer_info_t peerC = {};
    memcpy(peerC.peer_addr, RECEIVER_C_MAC, 6);
    peerC.channel = 0;
    peerC.encrypt = false;
    if (esp_now_add_peer(&peerC) != ESP_OK) { Serial.println("Add peer C FAILED"); return; }

    server.on("/color",     handleColor);
    server.on("/forward",   handleForward);
    server.on("/forward_c", handleForwardC);
    server.on("/temp_a",    handleTempA);
    server.on("/temp_b",    handleTempB);
    server.on("/temp",      handleTempC);   // alias for Unit C
    server.on("/temp_c",    handleTempC);
    server.on("/rssi",      handleRssi);
    server.on("/sync",      handleSync);
    server.on("/set_cal",   handleSetCal);
    server.on("/get_cal",   handleGetCal);
    server.on("/reset_cal", handleResetCal);
    server.begin();

    Serial.println("HTTP server ready");
    Serial.println("Endpoints: /sync /set_cal?unit=a&offset=0.5 /get_cal /reset_cal");
}

void loop() {
    server.handleClient();
    checkWiFi();

    static unsigned long lastSync = 0;
    if (millis() - lastSync > 30000) {  // Sync every 30 seconds
        lastSync = millis();
        broadcastSyncRead();
    }
    delay(5);
}

// ============================================================================
// UNIT B — receiver + SHT30
// ============================================================================
#elif defined(ROLE_RECEIVER)

#include <Wire.h>
#include <Adafruit_SHT31.h>

#define SHT30_SDA 8
#define SHT30_SCL 9

// MAC of Unit A
uint8_t SENDER_MAC[] = { 0xa4, 0xcb, 0x8f, 0xd1, 0xef, 0x58 };

Adafruit_SHT31 sht30;
static bool _sht30_ok = false;

#define PING_INTERVAL_MS   500UL
#define TEMP_INTERVAL_MS 10000UL

static unsigned long _lastPing     = 0;
static uint8_t       _pingSeq      = 0;
static unsigned long _lastTempSend = 0;

// Forward declaration
static void sendTemp();

static void onReceive(const esp_now_recv_info_t *info, const uint8_t *data, int len) {
    if (len == (int)sizeof(ColorPacket)) {
        ColorPacket pkt; memcpy(&pkt, data, sizeof(pkt));
        rgbLedWrite(LED_PIN, pkt.r, pkt.g, pkt.b);
        Serial.printf("[B] RGB(%d,%d,%d)\n", pkt.r, pkt.g, pkt.b);
    } else if (len == (int)sizeof(SyncPacket)) {
        SyncPacket pkt; memcpy(&pkt, data, sizeof(pkt));
        if (pkt.magic == 0xCC && pkt.cmd == 1) {
            Serial.println("[B] SYNC received — reading now");
            sendTemp();
        }
    }
}

static void sendTemp() {
    if (!_sht30_ok) {
        TempPacket pkt = { -99.0f, 0 };
        esp_now_send(SENDER_MAC, (uint8_t *)&pkt, sizeof(pkt));
        Serial.println("[B] SHT30 not initialized — sent sentinel");
        return;
    }
    float t = sht30.readTemperature();
    float h = sht30.readHumidity();
    if (isnan(t) || isnan(h)) {
        TempPacket pkt = { -99.0f, 0 };
        esp_now_send(SENDER_MAC, (uint8_t *)&pkt, sizeof(pkt));
        Serial.println("[B] SHT30 read NaN — sent sentinel");
        return;
    }
    TempPacket pkt = { t, (uint8_t)(h + 0.5f) };
    esp_now_send(SENDER_MAC, (uint8_t *)&pkt, sizeof(pkt));
    Serial.printf("[B] temp=%.1fC hum=%d%%\n", t, (int)h);
}

void setup() {
    Serial.begin(115200);
    delay(500);
    Serial.println("\nUnit B — RECEIVER + SHT30");

    pinMode(LED_PIN, OUTPUT);
    rgbLedWrite(LED_PIN, 0, 0, 0);

    Wire.begin(SHT30_SDA, SHT30_SCL);
    if (sht30.begin(0x44)) {
        _sht30_ok = true;
        Serial.println("SHT30 OK at 0x44");
    } else if (sht30.begin(0x45)) {
        _sht30_ok = true;
        Serial.println("SHT30 OK at 0x45");
    } else {
        Serial.println("SHT30 NOT FOUND — check wiring (SDA=8, SCL=9)");
    }

    initEspNowWiFi(false);

    if (esp_now_init() != ESP_OK) { Serial.println("ESP-NOW init FAILED"); return; }
    esp_now_register_recv_cb(onReceive);

    esp_now_peer_info_t peer = {};
    memcpy(peer.peer_addr, SENDER_MAC, 6);
    peer.channel = ESPNOW_CHANNEL;
    peer.encrypt = false;
    if (esp_now_add_peer(&peer) != ESP_OK) { Serial.println("Add peer A FAILED"); return; }

    Serial.printf("Ready — pings every %lums, temp on SYNC command\n", PING_INTERVAL_MS);
}

void loop() {
    unsigned long now = millis();

    if (now - _lastPing >= PING_INTERVAL_MS) {
        _lastPing = now;
        PingPacket ping = { 0xBB, _pingSeq++ };
        esp_now_send(SENDER_MAC, (uint8_t *)&ping, sizeof(ping));
    }

    // Temperature now sent only on SYNC command (no automatic sending)

    delay(10);
}

// ============================================================================
// UNIT C — unit_c + DHT11
// ============================================================================
#elif defined(ROLE_UNIT_C)

#include <DHT.h>

#define DHT_PIN  4
#define DHT_TYPE DHT11

DHT dht(DHT_PIN, DHT_TYPE);

// MAC of Unit A
uint8_t SENDER_MAC[] = { 0xa4, 0xcb, 0x8f, 0xd1, 0xef, 0x58 };

#define PING_INTERVAL_MS   500UL
#define TEMP_INTERVAL_MS 10000UL

static unsigned long _lastPing     = 0;
static uint8_t       _pingSeq      = 0;
static unsigned long _lastTempSend = 0;

// Forward declaration
static void sendTemp();

static void onReceive(const esp_now_recv_info_t *info, const uint8_t *data, int len) {
    if (len == (int)sizeof(ColorPacket)) {
        ColorPacket pkt; memcpy(&pkt, data, sizeof(pkt));
        rgbLedWrite(LED_PIN, pkt.r, pkt.g, pkt.b);
        Serial.printf("[C] RGB(%d,%d,%d)\n", pkt.r, pkt.g, pkt.b);
    } else if (len == (int)sizeof(SyncPacket)) {
        SyncPacket pkt; memcpy(&pkt, data, sizeof(pkt));
        if (pkt.magic == 0xCC && pkt.cmd == 1) {
            Serial.println("[C] SYNC received — reading now");
            sendTemp();
        }
    }
}

static void sendTemp() {
    float t = dht.readTemperature();
    float h = dht.readHumidity();
    if (isnan(t) || isnan(h)) {
        TempPacket pkt = { -99.0f, 0 };
        esp_now_send(SENDER_MAC, (uint8_t *)&pkt, sizeof(pkt));
        Serial.println("[C] DHT11 read NaN — sent sentinel");
        return;
    }
    TempPacket pkt = { t, (uint8_t)(h + 0.5f) };
    esp_now_send(SENDER_MAC, (uint8_t *)&pkt, sizeof(pkt));
    Serial.printf("[C] temp=%.1fC hum=%d%%\n", t, (int)h);
}

void setup() {
    Serial.begin(115200);
    delay(500);
    Serial.println("\nUnit C — UNIT_C + DHT11");

    pinMode(LED_PIN, OUTPUT);
    rgbLedWrite(LED_PIN, 0, 0, 0);

    dht.begin();

    initEspNowWiFi(false);

    if (esp_now_init() != ESP_OK) { Serial.println("ESP-NOW init FAILED"); return; }
    esp_now_register_recv_cb(onReceive);

    esp_now_peer_info_t peer = {};
    memcpy(peer.peer_addr, SENDER_MAC, 6);
    peer.channel = ESPNOW_CHANNEL;
    peer.encrypt = false;
    if (esp_now_add_peer(&peer) != ESP_OK) { Serial.println("Add peer A FAILED"); return; }

    Serial.printf("Ready — pings every %lums, temp on SYNC command\n", PING_INTERVAL_MS);
}

void loop() {
    unsigned long now = millis();

    if (now - _lastPing >= PING_INTERVAL_MS) {
        _lastPing = now;
        PingPacket ping = { 0xBB, _pingSeq++ };
        esp_now_send(SENDER_MAC, (uint8_t *)&ping, sizeof(ping));
    }

    // Temperature now sent only on SYNC command (no automatic sending)

    delay(10);
}

#endif
