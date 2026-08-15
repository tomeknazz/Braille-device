#include <Wire.h>
#include <Adafruit_PWMServoDriver.h>

// --- Configuration Constants ---
// Fallback values used to seed the per-servo calibration table below.
#define DEFAULT_RETRACTED 120
#define DEFAULT_EXTENDED 520

// Absolute PWM limits - protects the servos from being driven past their stops.
#define PWM_MIN 110
#define PWM_MAX 520

#define CASCADE_DELAY_MS 20
#define PINS_PER_CELL 6
#define MAX_CELLS 5
#define SERVOS_PER_MODULE 16

#define TOTAL_SERVOS (MAX_CELLS * PINS_PER_CELL)

#define MODULE_1_I2C_ADDR 0x40
#define MODULE_2_I2C_ADDR 0x41

static_assert(TOTAL_SERVOS <= 2 * SERVOS_PER_MODULE,
              "More servos requested than the two PCA9685 modules can drive");

// --- Per-servo calibration table ---
// Every servo is mounted at a slightly different angle and some of them are
// mirrored, so a single global pair of values does not fit all of them.
// `retracted` is the PWM tick count for "dot down", `extended` for "dot up".
// For a mirrored servo `retracted` will be numerically GREATER than `extended` -
// that is expected and handled correctly by the code below.
//
// How to calibrate:
//   1. Flash this firmware and open the serial monitor at 115200 baud.
//   2. Send "<index>,<pwm>" (e.g. "7,430") and step the value until the pin
//      sits exactly where you want it.
//   3. Write the two values you found into the row for that servo here.
//   4. Send "<index>,min" / "<index>,max" to verify the stored values, or
//      "dump" to print the whole table.
struct ServoRange {
  uint16_t retracted;  // dot down
  uint16_t extended;   // dot up
};

const ServoRange servo_range[TOTAL_SERVOS] = {
  // --- Cell 0 (servos 0-5) ---
  {DEFAULT_RETRACTED-10, 140},  //  0 - dot 1
  {510, 480},  //  1 - dot 2
  {120, 160},  //  2 - dot 3
  {140, 90},  //  3 - dot 4
  {100, 150},  //  4 - dot 5
  {120, 160},  //  5 - dot 6

  // --- Cell 1 (servos 6-11) ---
  {500, 460},  //  6 - dot 1
  {490, 450},  //  7 - dot 2
  {DEFAULT_RETRACTED, DEFAULT_EXTENDED},  //  8 - dot 3
  {DEFAULT_RETRACTED, DEFAULT_EXTENDED},  //  9 - dot 4
  {DEFAULT_RETRACTED, DEFAULT_EXTENDED},  // 10 - dot 5
  {DEFAULT_RETRACTED, DEFAULT_EXTENDED},  // 11 - dot 6

  // --- Cell 2 (servos 12-17) ---
  {DEFAULT_RETRACTED, DEFAULT_EXTENDED},  // 12 - dot 1
  {DEFAULT_RETRACTED, DEFAULT_EXTENDED},  // 13 - dot 2
  {DEFAULT_RETRACTED, DEFAULT_EXTENDED},  // 14 - dot 3
  {DEFAULT_RETRACTED, DEFAULT_EXTENDED},  // 15 - dot 4
  {DEFAULT_RETRACTED, DEFAULT_EXTENDED},  // 16 - dot 5
  {DEFAULT_RETRACTED, DEFAULT_EXTENDED},  // 17 - dot 6

  // --- Cell 3 (servos 18-23) ---
  {DEFAULT_RETRACTED, DEFAULT_EXTENDED},  // 18 - dot 1
  {DEFAULT_RETRACTED, DEFAULT_EXTENDED},  // 19 - dot 2
  {DEFAULT_RETRACTED, DEFAULT_EXTENDED},  // 20 - dot 3
  {DEFAULT_RETRACTED, DEFAULT_EXTENDED},  // 21 - dot 4
  {DEFAULT_RETRACTED, DEFAULT_EXTENDED},  // 22 - dot 5
  {DEFAULT_RETRACTED, DEFAULT_EXTENDED},  // 23 - dot 6

  // --- Cell 4 (servos 24-29) ---
  {DEFAULT_RETRACTED, DEFAULT_EXTENDED},  // 24 - dot 1
  {DEFAULT_RETRACTED, DEFAULT_EXTENDED},  // 25 - dot 2
  {DEFAULT_RETRACTED, DEFAULT_EXTENDED},  // 26 - dot 3
  {DEFAULT_RETRACTED, DEFAULT_EXTENDED},  // 27 - dot 4
  {DEFAULT_RETRACTED, DEFAULT_EXTENDED},  // 28 - dot 5
  {DEFAULT_RETRACTED, DEFAULT_EXTENDED},  // 29 - dot 6
};

// Braille Alphabet Dictionary (A-Z)
// 1 means pin extended (Maximum), 0 means pin retracted (Minimum)
// Array order: {Servo0, Servo1, Servo2, Servo3, Servo4, Servo5}
const byte braille_alphabet[26][PINS_PER_CELL] = {
  {1,0,0, 0,0,0}, // A
  {1,1,0, 0,0,0}, // B
  {1,0,0, 1,0,0}, // C
  {1,0,0, 1,1,0}, // D
  {1,0,0, 0,1,0}, // E
  {1,1,0, 1,0,0}, // F
  {1,1,0, 1,1,0}, // G
  {1,1,0, 0,1,0}, // H
  {0,1,0, 1,0,0}, // I
  {0,1,0, 1,1,0}, // J
  {1,0,1, 0,0,0}, // K
  {1,1,1, 0,0,0}, // L
  {1,0,1, 1,0,0}, // M
  {1,0,1, 1,1,0}, // N
  {1,0,1, 0,1,0}, // O
  {1,1,1, 1,0,0}, // P
  {1,1,1, 1,1,0}, // Q
  {1,1,1, 0,1,0}, // R
  {0,1,1, 1,0,0}, // S
  {0,1,1, 1,1,0}, // T
  {1,0,1, 0,0,1}, // U
  {1,1,1, 0,0,1}, // V
  {0,1,0, 1,1,1}, // W
  {1,0,1, 1,0,1}, // X
  {1,0,1, 1,1,1}, // Y
  {1,0,1, 0,1,1}  // Z
};

// Declaration of two modules on different hardware addresses
Adafruit_PWMServoDriver pwm1 = Adafruit_PWMServoDriver(MODULE_1_I2C_ADDR);
Adafruit_PWMServoDriver pwm2 = Adafruit_PWMServoDriver(MODULE_2_I2C_ADDR);

// --- 1. Hardware Abstraction Layer Function ---
// Sets any of the 30 servos to a raw PWM value, automatically selecting the module.
void set_servo_from_global_index(uint8_t servo_index, uint16_t pwm_value) {
  if (servo_index >= TOTAL_SERVOS) return;

  // Never drive a servo outside of the safe mechanical range.
  if (pwm_value < PWM_MIN) pwm_value = PWM_MIN;
  if (pwm_value > PWM_MAX) pwm_value = PWM_MAX;

  if (servo_index < SERVOS_PER_MODULE) {
    pwm1.setPWM(servo_index, 0, pwm_value);
  } else {
    pwm2.setPWM(servo_index - SERVOS_PER_MODULE, 0, pwm_value);
  }
}

// Moves a servo to its own calibrated end position instead of a global one.
void set_servo_state(uint8_t servo_index, bool is_extended) {
  if (servo_index >= TOTAL_SERVOS) return;

  const ServoRange &range = servo_range[servo_index];
  set_servo_from_global_index(servo_index, is_extended ? range.extended : range.retracted);
}

// --- 2. Character Translation Function ---
// letter - character to display (e.g., 'A')
// module_position - which braille cell to display the letter on (from 0 to MAX_CELLS - 1)
void display_letter(char letter, uint8_t module_position) {
  // Protection against exceeding the maximum cell limit
  if (module_position >= MAX_CELLS) return;

  // Convert lowercase letter to uppercase to avoid errors
  letter = toupper(letter);

  // Calculate the starting servo index for this module
  uint8_t base_servo_index = module_position * PINS_PER_CELL;

  // Clear the module for a space character
  if (letter == ' ') {
    for (uint8_t i = 0; i < PINS_PER_CELL; i++) {
      set_servo_state(base_servo_index + i, false);
      delay(CASCADE_DELAY_MS);
    }
    return;
  }

  // Check if the letter is in the A-Z range
  if (letter >= 'A' && letter <= 'Z') {
    uint8_t alphabet_index = letter - 'A';

    // Iterate through the points of the Braille cell
    for (uint8_t i = 0; i < PINS_PER_CELL; i++) {
      bool state = braille_alphabet[alphabet_index][i];
      set_servo_state(base_servo_index + i, state);

      delay(CASCADE_DELAY_MS);
    }
  }
}

// Prints the calibration table so the current values can be copied back into the source.
void dump_calibration() {
  Serial.println("index,cell,dot,retracted,extended");
  for (uint8_t i = 0; i < TOTAL_SERVOS; i++) {
    Serial.print(i);
    Serial.print(',');
    Serial.print(i / PINS_PER_CELL);
    Serial.print(',');
    Serial.print(i % PINS_PER_CELL + 1);
    Serial.print(',');
    Serial.print(servo_range[i].retracted);
    Serial.print(',');
    Serial.println(servo_range[i].extended);
  }
}

void setup() {
  Serial.begin(115200);

  pwm1.begin();
  pwm1.setOscillatorFrequency(27000000);
  pwm1.setPWMFreq(50); // Standard 50Hz for SG90
  pwm2.begin();
  pwm2.setOscillatorFrequency(27000000);
  pwm2.setPWMFreq(50); // Standard 50Hz for SG90

  delay(1000);

  Serial.println("Servo tester ready.");
  Serial.println("  <index>,<pwm>  - raw PWM value");
  Serial.println("  <index>,min    - calibrated retracted position");
  Serial.println("  <index>,max    - calibrated extended position");
  Serial.println("  dump           - print the calibration table");
}

void loop() {
  if (Serial.available() > 0) {
    String command = Serial.readStringUntil('\n');
    command.trim();

    if (command.equalsIgnoreCase("dump")) {
      dump_calibration();
      return;
    }

    int commaIndex = command.indexOf(',');
    if (commaIndex != -1) {
      String indexStr = command.substring(0, commaIndex);
      String valueStr = command.substring(commaIndex + 1);
      valueStr.trim();

      int servoIndex = indexStr.toInt();
      if (servoIndex < 0 || servoIndex >= TOTAL_SERVOS) {
        Serial.print("Servo index out of range: ");
        Serial.println(servoIndex);
        return;
      }

      uint16_t pwmValue;
      if (valueStr.equalsIgnoreCase("min")) {
        pwmValue = servo_range[servoIndex].retracted;
      } else if (valueStr.equalsIgnoreCase("max")) {
        pwmValue = servo_range[servoIndex].extended;
      } else {
        pwmValue = valueStr.toInt();
      }

      Serial.print("Setting servo ");
      Serial.print(servoIndex);
      Serial.print(" to PWM ");
      Serial.println(pwmValue);

      set_servo_from_global_index(servoIndex, pwmValue);
    }
  }
}
