#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <DHT.h>
#include "secrets.h"

// ========== 1. CẤU HÌNH KẾT NỐI ==========
// 4 Topic: data_Sensors, device_control, device_Response, và device_Alert (màn hình mới)
const char* TOPIC_DATA_SENSOR    = "data_Sensors";
const char* TOPIC_DEVICE_CONTROL  = "device_control";
const char* TOPIC_DEVICE_RESPONSE = "device_Response";
const char* TOPIC_DEVICE_ALERT    = "device_Alert"; // Màn hình mới giám sát trạng thái/lỗi dây

// ========== 2. CẤU HÌNH GPIO ==========
#define DHTPIN        4  
#define DHTTYPE       DHT11
#define LDR_PIN       34    

#define LED_DEN       18   // Đèn LED
#define LED_QUAT      17   // Quạt
#define LED_DIEU_HOA  16   // Điều hòa

DHT dht(DHTPIN, DHTTYPE);
WiFiClient espClient;
PubSubClient client(espClient);

unsigned long lastMsg = 0;
const long interval = 2000; // thoi gian gui cam bien

void setup_wifi() {
  delay(10);
  Serial.print("Dang ket noi WiFi: ");
  Serial.println(ssid);
  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid, password);

  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\nWiFi da ket noi!");
}

// Xử lý kiểm tra và bắn trạng thái
void controlAndCheck(int pin, int device_id, const char* name, String action) {
  uint8_t desiredState = (action == "on" || action == "bat") ? LOW : HIGH;
  const char* actStr = (action == "on" || action == "bat") ? "bat" : "tat";

  // Kích mức logic ra chân
  digitalWrite(pin, desiredState);
  delay(20); // Chờ ổn định điện áp trên chân

  // Đọc ngược lại mức logic thực tế trên chân
  int actualPinState = digitalRead(pin);

  // Phản hồi thông thường cho CMD 3 (device_Response)
  StaticJsonDocument<128> resDoc;
  resDoc["device_id"]  = device_id;
  resDoc["trang_thai"] = actStr;
  resDoc["ket_qua"]    = "thanh_cong";
  char resBuffer[128];
  serializeJson(resDoc, resBuffer);
  client.publish(TOPIC_DEVICE_RESPONSE, resBuffer);

  // Bắn trạng thái chi tiết sang màn hình mới 
  StaticJsonDocument<200> alertDoc;
  alertDoc["device_id"]     = device_id;
  alertDoc["ten_thiet_bi"]  = name;
  alertDoc["trang_thai_lenh"] = actStr;
  alertDoc["dien_ap_chan"]  = (actualPinState == LOW) ? "MUC_THAP_0V" : "MUC_CAO_3V3";
  
  // Kiểm tra nếu rút dây hoặc chân không đúng mức logic
  if (actualPinState != desiredState) {
    alertDoc["canh_bao"] = "LOI: PHAN CUNG KHONG DONG BO HOAC TUOT DAY!";
  } else {
    alertDoc["canh_bao"] = "KET_NOI_ON_DINH";
  }

  char alertBuffer[200];
  serializeJson(alertDoc, alertBuffer);
  client.publish(TOPIC_DEVICE_ALERT, alertBuffer);
}

void callback(char* topic, byte* payload, unsigned int length) {
  String msg = "";
  for (unsigned int i = 0; i < length; i++) {
    msg += (char)payload[i];
  }
  Serial.print("\n[MQTT] Lenh: ");
  Serial.println(msg);

  StaticJsonDocument<256> doc;
  DeserializationError error = deserializeJson(doc, msg);
  if (error) return;

  int device_id = -1;
  if (doc.containsKey("device_id")) {
    device_id = doc["device_id"].as<int>();
  }
  String action = doc["action"] | "";
  action.toLowerCase();

  // Bật/tắt cả 3 đèn cùng lúc
  if (device_id == 0) {
    controlAndCheck(LED_DEN, 1, "Den LED", action);
    controlAndCheck(LED_QUAT, 2, "Quat", action);
    controlAndCheck(LED_DIEU_HOA, 3, "Dieu hoa", action);
    return;
  }

  // Bật/tắt từng đèn
  if (device_id == 1) controlAndCheck(LED_DEN, 1, "Den LED", action);
  else if (device_id == 2) controlAndCheck(LED_QUAT, 2, "Quat", action);
  else if (device_id == 3) controlAndCheck(LED_DIEU_HOA, 3, "Dieu hoa", action);
}

void reconnect() {
  while (!client.connected()) {
    Serial.print("Dang ket noi MQTT...");
    String clientId = "ESP32Client-" + String(random(0xffff), HEX);

    // Di chúc LWT: Nếu ESP32 bị rút nguồn/mất kết nối, Broker tự bắn vào màn hình mới (device_Alert)
    const char* willTopic = TOPIC_DEVICE_ALERT;
    const char* willMsg = "{\"canh_bao\": \"CANH BAO NGHIEP VU: ESP32 DA BI RUT NGUON / MAT KET NOI!\"}";

    if (client.connect(clientId.c_str(), mqtt_user, mqtt_pass, willTopic, 1, true, willMsg)) {
      Serial.println(" Thanh cong!");
      client.subscribe(TOPIC_DEVICE_CONTROL);

      // Thông báo thiết bị online lên màn hình mới
      client.publish(TOPIC_DEVICE_ALERT, "{\"thiet_bi\": \"ESP32\", \"trang_thai\": \"DA_CAM_DAY_HOAT_DONG\"}");
    } else {
      delay(2000);
    }
  }
}

void setup() {
  Serial.begin(115200);

  pinMode(LED_DEN, INPUT_PULLUP); // Dùng pullup/pulldown để đọc được phản hồi khi rút dây
  pinMode(LED_DEN, OUTPUT);
  pinMode(LED_QUAT, OUTPUT);
  pinMode(LED_DIEU_HOA, OUTPUT);

  digitalWrite(LED_DEN, HIGH);
  digitalWrite(LED_QUAT, HIGH);
  digitalWrite(LED_DIEU_HOA, HIGH);

  dht.begin();
  setup_wifi();
  client.setServer(mqtt_server, mqtt_port);
  client.setCallback(callback);
}

void loop() {
  if (!client.connected()) reconnect();
  client.loop();

  unsigned long now = millis();
  if (now - lastMsg > interval) {
    lastMsg = now;

    float temp = dht.readTemperature();  
    float hum  = dht.readHumidity();     
    int rawLight = analogRead(LDR_PIN);  

    int lightLux = map(rawLight, 4095, 0, 0, 1000);
    if (lightLux < 0) lightLux = 0;
    if (lightLux > 1000) lightLux = 1000;

    if (!isnan(hum) && !isnan(temp)) {
      StaticJsonDocument<256> doc;
      doc["nhiet_do"] = round(temp * 10.0) / 10.0;
      doc["do_am"]    = round(hum * 10.0) / 10.0;
      doc["anh_sang"] = lightLux;

      char buffer[256];
      serializeJson(doc, buffer);
      client.publish(TOPIC_DATA_SENSOR, buffer);
    }
  }
}
