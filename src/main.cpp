#include <Wire.h>
#include <Adafruit_PWMServoDriver.h>

// --- Configuration Constants ---
#define PIN_RETRACTED 120
#define PIN_EXTENDED 520

#define CASCADE_DELAY_MS 20
#define PINS_PER_CELL 6
#define MAX_CELLS 5
#define SERVOS_PER_MODULE 16

#define MODULE_1_I2C_ADDR 0x40
#define MODULE_2_I2C_ADDR 0x41

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
// Sets any of the 30 servos to the desired position, automatically selecting the module.
void set_servo_from_global_index(uint8_t servo_index, bool is_extended) {
  uint16_t pwm_value = is_extended ? PIN_EXTENDED : PIN_RETRACTED;
  
  if (servo_index < SERVOS_PER_MODULE) {
    pwm1.setPWM(servo_index, 0, pwm_value);
  } else {
    pwm2.setPWM(servo_index - SERVOS_PER_MODULE, 0, pwm_value); 
  }
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
      set_servo_from_global_index(base_servo_index + i, false);
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
      set_servo_from_global_index(base_servo_index + i, state);
      
      delay(CASCADE_DELAY_MS); 
    }
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
}

void loop() {
  // Przejście przez wszystkie litery od A do Z
  /*
  for (char test_letter = 'A'; test_letter <= 'Z'; test_letter++) {
    Serial.print("Testowanie litery: ");
    Serial.println(test_letter);
    
    display_letter(test_letter, 2);
    //delay(500);
    //display_letter(test_letter, 1);
    //delay(500);
    //display_letter(test_letter, 2);
    //delay(500);
    //display_letter(test_letter, 3);
    //delay(500);
    //display_letter(test_letter, 4);
    //delay(500);
    }
    */
    
    display_letter(' ',0);
    display_letter(' ',1);
    display_letter(' ',2);
    display_letter(' ',3);
    display_letter(' ',4);


    delay(500); // Sekunda przerwy na obserwację mechanizmu
  
  
}