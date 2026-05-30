// ============================================================================
// ESP-NOW practice — 2-unit mesh (Unit A + Unit B)
//
//   Unit A  (-DROLE_SENDER)   COM12  MAC a4:cb:8f:d1:ef:58  DHT22  + WiFi hub
//   Unit B  (-DROLE_RECEIVER) COM11  MAC a4:cb:8f:d1:f2:a8  SHT30
//
// Wiring
//   Unit A : DHT22 data -> GPIO 4 ; WS2812B RGB LED on GPIO 48
//   Unit B : SHT30 SDA  -> GPIO 8 ; SHT30 SCL -> GPIO 9 ; WS2812B on GPIO 48
//
// ESP-NOW packets
//   ColorPacket  (3 B)  A -> B   r,g,b
//   TempPacket   (5 B)  B -> A   float temp_c, uint8_t humidity
//   PingPacket   (2 B)  B -> A   magic=0xBB, seq    (A measures A<->B RSSI)
// ============================================================================

#include <Arduino.h>
#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>
#include "credentials.h"

#ifndef ESPNOW_CHANNEL
#define ESPNOW_CHANNEL 11   // must match Unit A's router channel
#endif

#define LED_PIN 48

// ---- Packet types ----------------------------------------------------------
struct __attribute__((packed)) ColorPacket { uint8_t r, g, b; };
struct __attribute__((packed)) TempPacket  { float   temp_c; uint8_t humidity; };
struct __attribute__((packed)) PingPacket  { uint8_t magic;  uint8_t seq; };

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

// MAC of Unit B (receiver / SHT30)
uint8_t RECEIVER_B_MAC[] = { 0xa4, 0xcb, 0x8f, 0xd1, 0xf2, 0xa8 };

// ---- Cached values ----
static float    _tempA_c   = NAN;
static uint8_t  _humA      = 0;
static unsigned long _tempA_time = 0;

static float    _tempB_c   = NAN;
static uint8_t  _humB      = 0;
static unsigned long _tempB_time = 0;

static int8_t        _rssiB_atA  = 0;
static unsigned long _rssiB_time = 0;

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

// ---- ESP-NOW receive (from Unit B) ----
static void onReceive(const esp_now_recv_info_t *info, const uint8_t *data, int len) {
    if (len == (int)sizeof(TempPacket)) {
        TempPacket pkt; memcpy(&pkt, data, sizeof(pkt));
        _tempB_c    = pkt.temp_c;
        _humB       = pkt.humidity;
        _tempB_time = millis();
        Serial.printf("[recv B] temp=%.1fC hum=%d%%\n", pkt.temp_c, pkt.humidity);
    } else if (len == (int)sizeof(PingPacket)) {
        PingPacket pkt; memcpy(&pkt, data, sizeof(pkt));
        if (pkt.magic == 0xBB) {
            _rssiB_atA  = (int8_t)info->rx_ctrl->rssi;
            _rssiB_time = millis();
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
    _tempA_c    = t;
    _humA       = (uint8_t)(h + 0.5f);
    _tempA_time = millis();
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

static void handleRssi() {
    char buf[256];
    unsigned long ageB = _rssiB_time ? (millis() - _rssiB_time) / 1000 : 9999;
    snprintf(buf, sizeof(buf),
        "{\"ok\":true,"
         "\"wifi\":{\"rssi\":%d,\"ch\":%d},"
         "\"b\":{\"rssi\":%d,\"age\":%lu}}",
        (int)WiFi.RSSI(), WiFi.channel(),
        _rssiB_time ? _rssiB_atA : 0, ageB);
    server.send(200, "application/json", buf);
}

void setup() {
    Serial.begin(115200);
    delay(500);
    Serial.println("\nUnit A — SENDER + DHT22 + WiFi hub");

    pinMode(LED_PIN, OUTPUT);
    rgbLedWrite(LED_PIN, 0, 0, 0);

    dht.begin();

    initEspNowWiFi(true);

    if (esp_now_init() != ESP_OK) { Serial.println("ESP-NOW init FAILED"); return; }
    esp_now_register_recv_cb(onReceive);

    // Register Unit B as peer (use whatever channel WiFi negotiated)
    esp_now_peer_info_t peer = {};
    memcpy(peer.peer_addr, RECEIVER_B_MAC, 6);
    peer.channel = 0;
    peer.encrypt = false;
    if (esp_now_add_peer(&peer) != ESP_OK) { Serial.println("Add peer B FAILED"); return; }

    server.on("/color",   handleColor);
    server.on("/forward", handleForward);
    server.on("/temp_a",  handleTempA);
    server.on("/temp_b",  handleTempB);
    server.on("/rssi",    handleRssi);
    server.begin();

    Serial.println("HTTP server ready");
}

void loop() {
    server.handleClient();
    checkWiFi();

    static unsigned long lastTemp = 0;
    if (millis() - lastTemp > 15000) {
        lastTemp = millis();
        readLocalTemp();
    }
    delay(5);
}

// ============================================================================
// UNIT B — receiver + SHT30
// ============================================================================
#else // ROLE_RECEIVER (default)

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

static void onReceive(const esp_now_recv_info_t *info, const uint8_t *data, int len) {
    if (len == (int)sizeof(ColorPacket)) {
        ColorPacket pkt; memcpy(&pkt, data, sizeof(pkt));
        rgbLedWrite(LED_PIN, pkt.r, pkt.g, pkt.b);
        Serial.printf("[B] RGB(%d,%d,%d)\n", pkt.r, pkt.g, pkt.b);
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

    Serial.printf("Ready — pings every %lums, temp every %lus\n",
        PING_INTERVAL_MS, TEMP_INTERVAL_MS / 1000);
}

void loop() {
    unsigned long now = millis();

    if (now - _lastPing >= PING_INTERVAL_MS) {
        _lastPing = now;
        PingPacket ping = { 0xBB, _pingSeq++ };
        esp_now_send(SENDER_MAC, (uint8_t *)&ping, sizeof(ping));
    }

    if (now - _lastTempSend >= TEMP_INTERVAL_MS) {
        _lastTempSend = now;
        sendTemp();
    }

    delay(10);
}

#endif
