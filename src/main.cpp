#include <Wire.h>
#include <Adafruit_PWMServoDriver.h>
#include <esp_system.h>  // esp_reset_reason()

// --- Configuration Constants ---
// Fallback values used to seed the per-servo calibration table below.
#define DEFAULT_RETRACTED 120
#define DEFAULT_EXTENDED 160

// Absolute PWM limits - protects the servos from being driven past their stops.
#define PWM_MIN 90
#define PWM_MAX 520

#define CASCADE_DELAY_MS 20
#define PINS_PER_CELL 6
#define MAX_CELLS 5
#define SERVOS_PER_MODULE 16

#define TOTAL_SERVOS (MAX_CELLS * PINS_PER_CELL)

#define MODULE_1_I2C_ADDR 0x40
#define MODULE_2_I2C_ADDR 0x41

// --- Protocol v1 (see docs/PROTOCOL.md) ---
#define FW_VERSION "0.4.1"
#define PROTO_VERSION 1
#define CMD_MAX_LEN 96            // longest accepted command line, in bytes
#define SETTLE_MS 120             // wait after the last move before replying
#define FULL_TRAVEL_MS 400        // full SG90 swing, e.g. back from a raw calibration value
#define RX_BUFFER_SIZE 1024       // UART RX buffer, holds input while a slow cascade blocks
#define ANIM_MAX_MS 2000          // slowest teaching-mode step delay
#define IDLE_DOWN_S_DEFAULT 2     // retracted dots lose PWM after this long without motion
#define IDLE_SLEEP_S_DEFAULT 300  // display clears after this long without commands
#define IDLE_MAX_S 86400
#define PWM_FULL_OFF 4096         // PCA9685 FULL_OFF flag (bit 12 of the OFF register)

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
//      "dump" to print the whole table. "min" / "max" alone sweep every pin.
struct ServoRange {
  uint16_t retracted;  // dot down
  uint16_t extended;   // dot up
};

const ServoRange servo_range[TOTAL_SERVOS] = {
  // --- Cell 0 (servos 0-5) ---
  {470, 430},  //  0 - dot 1 {480, 440}
  {DEFAULT_RETRACTED, 160},  //  1 - dot 2 DEFAULT_RETRACTED, 160
  {140, 180},  //  2 - dot 3  140, 180
  {DEFAULT_RETRACTED, 160},  //  3 - dot 4 DEFAULT_RETRACTED, 160
  {175, 210},  //  4 - dot 5 160, 210
  {490, 465},  //  5 - dot 6 500, 460

  // --- Cell 1 (servos 6-11) ---
  {140, 100},  //  6 - dot 1
  {DEFAULT_RETRACTED, 150},  //  7 - dot 2 DEFAULT_RETRACTED, 150
  {115, 130},  //  8 - dot 3 115, 130
  {120, 160},  //  9 - dot 4
  {165, 195},  // 10 - dot 5
  {480, 470},  // 11 - dot 6 500, 480 
  
  // --- Cell 2 (servos 12-17) ---
  {510, 470},  // 12 - dot 1 510, 470
  {DEFAULT_RETRACTED, 175},  // 13 - dot 2 DEFAULT_RETRACTED, 160
  {130, 170},  // 14 - dot 3 130, 170
  {130, DEFAULT_EXTENDED},  // 15 - dot 4 130, DEFAULT_EXTENDED
  {DEFAULT_RETRACTED, 160},  // 16 - dot 5 DEFAULT_RETRACTED, 160
  {480, 450},  // 17 - dot 6 490, 450

  // --- Cell 3 (servos 18-23) ---
  {500, 450},  // 18 - dot 1
  {DEFAULT_RETRACTED, 170},  // 19 - dot 2 DEFAULT_RETRACTED, 160
  {110, 135},  // 20 - dot 3 110, 135
  {145, 175},  // 21 - dot 4
  {140, 180},  // 22 - dot 5 120, 160
  {475, 440},  // 23 - dot 6

  // --- Cell 4 (servos 24-29) ---
  {475, 450},  // 24 - dot 1 490, 450
  {155, 190},  // 25 - dot 2
  {155, 185},  // 26 - dot 3
  {110, 140},  // 27 - dot 4
  {130, 170},  // 28 - dot 5
  {500, 460},  // 29 - dot 6
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

// --- Display state ---
// cell_mask holds what the learner should feel: bit d = dot d+1 (Unicode braille order).
// hold tracks whether the physical position of each dot can be trusted.
enum Hold : uint8_t {
  HOLD_UNKNOWN,  // boot, after a raw-PWM command, after `refresh` is requested
  HOLD_POWERED,  // PWM is actively holding the position recorded in cell_mask
  HOLD_RESTING   // PWM off, dot is RETRACTED and rests on its stop (position trusted)
};

uint8_t cell_mask[MAX_CELLS] = {0};
Hold hold[TOTAL_SERVOS];  // zero-init = HOLD_UNKNOWN
uint16_t step_delay_ms = CASCADE_DELAY_MS;
uint32_t idle_down_ms = IDLE_DOWN_S_DEFAULT * 1000UL;
uint32_t idle_sleep_ms = IDLE_SLEEP_S_DEFAULT * 1000UL;
uint32_t last_motion_ms = 0;
uint32_t last_cmd_ms = 0;
bool asleep = false;
bool pwm1_ok = false;
bool pwm2_ok = false;
uint8_t pwm1_prescale = 0;  // prescale read back after init; a power-cycled chip differs
uint8_t pwm2_prescale = 0;
uint8_t last_fail = 0;       // servo writes that failed during the last motion
uint8_t last_fail_mask = 0;  // bit0 = pwm1, bit1 = pwm2

// --- 1. Hardware Abstraction Layer Function ---
// True when the PCA9685 driving this servo is known to answer.
bool module_ok(uint8_t servo_index) {
  return (servo_index < SERVOS_PER_MODULE) ? pwm1_ok : pwm2_ok;
}

// Records a failed I2C write. The module is marked failed so later motion stops
// hammering a dead bus; `hello` re-probes it and re-inits it when it answers.
void note_fail(uint8_t servo_index) {
  last_fail++;
  if (servo_index < SERVOS_PER_MODULE) { pwm1_ok = false; last_fail_mask |= 1; }
  else { pwm2_ok = false; last_fail_mask |= 2; }
}

// Sets any of the 30 servos to a raw PWM value, automatically selecting the module.
// Returns false when the I2C write failed.
bool set_servo_from_global_index(uint8_t servo_index, uint16_t pwm_value) {
  if (servo_index >= TOTAL_SERVOS) return false;

  // Never drive a servo outside of the safe mechanical range.
  if (pwm_value < PWM_MIN) pwm_value = PWM_MIN;
  if (pwm_value > PWM_MAX) pwm_value = PWM_MAX;

  if (servo_index < SERVOS_PER_MODULE) {
    return pwm1.setPWM(servo_index, 0, pwm_value) == 0;
  } else {
    return pwm2.setPWM(servo_index - SERVOS_PER_MODULE, 0, pwm_value) == 0;
  }
}

// Moves a servo to its own calibrated end position instead of a global one.
bool set_servo_state(uint8_t servo_index, bool is_extended) {
  if (servo_index >= TOTAL_SERVOS) return false;

  const ServoRange &range = servo_range[servo_index];
  return set_servo_from_global_index(servo_index, is_extended ? range.extended : range.retracted);
}

// Removes the pulse entirely. Deliberately bypasses the PWM_MIN/PWM_MAX clamp:
// 4096 is the PCA9685 FULL_OFF flag, not a pulse width, and the clamp would
// turn it into PWM_MAX and slam the servo to its extreme.
bool detach_servo(uint8_t servo_index) {
  if (servo_index >= TOTAL_SERVOS) return false;

  if (servo_index < SERVOS_PER_MODULE) {
    return pwm1.setPWM(servo_index, 0, PWM_FULL_OFF) == 0;
  } else {
    return pwm2.setPWM(servo_index - SERVOS_PER_MODULE, 0, PWM_FULL_OFF) == 0;
  }
}

// Probes an I2C address; true when the device ACKs.
bool i2c_ack(uint8_t addr) {
  Wire.beginTransmission(addr);
  return Wire.endTransmission() == 0;
}

// Configures one PCA9685 for SG90 servos. Returns false if the chip does not answer.
bool init_module(Adafruit_PWMServoDriver &pwm, uint8_t &prescale) {
  if (!pwm.begin()) return false;
  pwm.setOscillatorFrequency(27000000);
  pwm.setPWMFreq(50); // Standard 50Hz for SG90
  prescale = pwm.readPrescale();  // reference for check_pwm_modules()
  return true;
}

// Re-checks one module. A module that stopped answering blocks motion. One that
// (re)appeared, or that lost power and came back at its defaults (asleep, other
// prescale) while still ACKing, is configured again and its dots are marked
// UNKNOWN so the next show/refresh drives them.
void check_module(Adafruit_PWMServoDriver &pwm, uint8_t addr, bool &ok, uint8_t &prescale,
                  uint8_t first, uint8_t last) {
  if (!i2c_ack(addr)) { ok = false; return; }
  if (ok && pwm.readPrescale() == prescale) return;

  ok = init_module(pwm, prescale);
  for (uint8_t i = first; i < last; i++) hold[i] = HOLD_UNKNOWN;
}

// Used by `hello`.
void check_pwm_modules() {
  check_module(pwm1, MODULE_1_I2C_ADDR, pwm1_ok, pwm1_prescale, 0,
               (TOTAL_SERVOS < SERVOS_PER_MODULE) ? TOTAL_SERVOS : SERVOS_PER_MODULE);
  check_module(pwm2, MODULE_2_I2C_ADDR, pwm2_ok, pwm2_prescale, SERVOS_PER_MODULE, TOTAL_SERVOS);
}

// --- 2. Character Translation ---
// Row of braille_alphabet -> 6-bit mask (bit d = dot d+1). 0xFF = not A-Z.
uint8_t letter_mask(char c) {
  c = toupper(c);
  if (c < 'A' || c > 'Z') return 0xFF;

  uint8_t m = 0;
  for (uint8_t d = 0; d < PINS_PER_CELL; d++) {
    if (braille_alphabet[c - 'A'][d]) m |= (1 << d);
  }
  return m;
}

// --- 3. Diff-based cascade (the only path to end positions) ---
// Moves only dots whose target differs from what is physically held.
// Pass 0 retracts, pass 1 extends: fewer servos pull against each other, and in
// slow (anim) mode the learner feels the old letter go down before the new dots
// rise in order 1-6, cell by cell. The step delay is only inserted between real
// moves. Returns the number of servos driven. A failed write leaves the dot
// UNKNOWN (so `refresh` retries it) and is counted in last_fail.
uint8_t apply_masks(const uint8_t target[MAX_CELLS]) {
  uint8_t moved = 0;
  last_fail = 0;
  last_fail_mask = 0;

  for (uint8_t pass = 0; pass < 2; pass++) {
    bool extend_pass = (pass == 1);
    for (uint8_t cell = 0; cell < MAX_CELLS; cell++) {
      for (uint8_t d = 0; d < PINS_PER_CELL; d++) {
        bool want = (target[cell] >> d) & 1;
        if (want != extend_pass) continue;

        uint8_t i = cell * PINS_PER_CELL + d;
        bool have = (cell_mask[cell] >> d) & 1;
        if (want == have && hold[i] != HOLD_UNKNOWN) continue;

        // Module failed earlier in this cascade: skip it instead of timing out per dot.
        if (!module_ok(i)) { hold[i] = HOLD_UNKNOWN; note_fail(i); continue; }

        if (moved) delay(step_delay_ms);
        if (set_servo_state(i, want)) {
          hold[i] = HOLD_POWERED;
        } else {
          hold[i] = HOLD_UNKNOWN;
          note_fail(i);
        }
        moved++;
      }
    }
  }

  memcpy(cell_mask, target, MAX_CELLS);
  if (moved) {
    delay(SETTLE_MS);  // let the last servo reach its position before replying
    last_motion_ms = millis();
  }
  asleep = false;
  return moved;
}

// letter - character to display (e.g., 'A'), ' ' clears the cell
// module_position - which braille cell to display the letter on (from 0 to MAX_CELLS - 1)
// Kept for API compatibility (master's demo loop); other cells are not touched.
void display_letter(char letter, uint8_t module_position) {
  // Protection against exceeding the maximum cell limit
  if (module_position >= MAX_CELLS) return;

  uint8_t m = (letter == ' ') ? 0 : letter_mask(letter);
  if (m == 0xFF) return;

  uint8_t target[MAX_CELLS];
  memcpy(target, cell_mask, MAX_CELLS);
  target[module_position] = m;
  apply_masks(target);
}

// --- 4. Idle handling ---
// Clears the display and switches off every channel. The state stays known
// (all dots down), so the next show only drives the dots that rise.
void go_to_sleep() {
  // A servo left at a raw calibration value can be a full swing away from its
  // stop; SETTLE_MS only covers the normal ~40-tick travel.
  bool unknown = false;
  for (uint8_t i = 0; i < TOTAL_SERVOS; i++) {
    if (hold[i] == HOLD_UNKNOWN) unknown = true;
  }

  // Teaching-mode pace is pointless here and would block loop() for up to a minute.
  uint8_t blank[MAX_CELLS] = {0};
  uint16_t saved_delay = step_delay_ms;
  step_delay_ms = CASCADE_DELAY_MS;
  apply_masks(blank);
  step_delay_ms = saved_delay;
  if (unknown) delay(FULL_TRAVEL_MS);

  for (uint8_t i = 0; i < TOTAL_SERVOS; i++) {
    // A dot whose retract write failed is still UNKNOWN and stays so.
    bool was_driven = (hold[i] != HOLD_UNKNOWN);
    if (module_ok(i) && detach_servo(i)) {
      hold[i] = was_driven ? HOLD_RESTING : HOLD_UNKNOWN;
    } else {
      if (module_ok(i)) note_fail(i);
      hold[i] = HOLD_UNKNOWN;
    }
  }
  asleep = true;
}

void emit_event(const String &evt) {
  Serial.println(evt);
}

// Stage "down": retracted dots rest on their stop, so their PWM can go.
// Extended dots keep PWM - an unpowered SG90 would sink under a reading finger.
// Stage "sleep": no command for idle_sleep_ms -> clear everything, all PWM off.
void idle_tick() {
  uint32_t now = millis();
  if (idle_down_ms && now - last_motion_ms >= idle_down_ms) {
    // Per servo: a working module still rests its dots when the other one is missing.
    for (uint8_t i = 0; i < TOTAL_SERVOS; i++) {
      bool up = (cell_mask[i / PINS_PER_CELL] >> (i % PINS_PER_CELL)) & 1;
      if (hold[i] != HOLD_POWERED || up || !module_ok(i)) continue;
      if (detach_servo(i)) {
        hold[i] = HOLD_RESTING;
      } else {
        hold[i] = HOLD_UNKNOWN;  // not retried every loop; the next show re-drives it
        note_fail(i);
      }
    }
  }

  // Sleep runs apply_masks, which may touch any servo: both modules are needed.
  if (pwm1_ok && pwm2_ok && idle_sleep_ms && !asleep && now - last_cmd_ms >= idle_sleep_ms) {
    go_to_sleep();
    emit_event("EVT sleep");
  }
}

// --- 5. Replies ---
// Every command ends with exactly one terminal line: "OK <verb> ..." or
// "ERR <code> ...". Human-readable info lines may come before it.
struct Reply {
  Print &out;
  String tag;  // optional "#<id>" echoed back in the terminal line

  void info(const String &s) { out.println(s); }

  void ok(const String &verb, const String &data = "") {
    out.print("OK ");
    out.print(verb);
    if (data.length()) { out.print(' '); out.print(data); }
    if (tag.length()) { out.print(' '); out.print(tag); }
    out.println();
  }

  void err(const char *code, const String &detail = "") {
    out.print("ERR ");
    out.print(code);
    if (detail.length()) { out.print(' '); out.print(detail); }
    if (tag.length()) { out.print(' '); out.print(tag); }
    out.println();
  }
};

String motion_data(uint8_t moved, uint32_t t0) {
  return "moved=" + String(moved) + " ms=" + String(millis() - t0);
}

// Replies "ERR hw ..." when a servo write of the last motion did not reach its PCA9685.
bool motion_failed(Reply &r) {
  if (!last_fail) return false;
  r.err("hw", String((last_fail_mask & 1) ? "pwm1" : "pwm2") + " fail=" + String(last_fail));
  return true;
}

// Terminal line after apply_masks(): OK only when every servo write succeeded.
void finish_motion(Reply &r, const String &verb, const String &prefix, uint8_t moved, uint32_t t0) {
  if (motion_failed(r)) return;
  r.ok(verb, prefix + motion_data(moved, t0));
}

// Prints the calibration table so the current values can be copied back into the source.
void dump_calibration(Print &out) {
  out.println("index,cell,dot,retracted,extended");
  for (uint8_t i = 0; i < TOTAL_SERVOS; i++) {
    out.print(i);
    out.print(',');
    out.print(i / PINS_PER_CELL);
    out.print(',');
    out.print(i % PINS_PER_CELL + 1);
    out.print(',');
    out.print(servo_range[i].retracted);
    out.print(',');
    out.println(servo_range[i].extended);
  }
}

void print_help(Print &out) {
  out.println("Braille device ready (fw " FW_VERSION ", protocol 1).");
  out.println("  hello                  - handshake, firmware and PCA9685 status");
  out.println("  ping                   - keepalive, resets the sleep timer");
  out.println("  show[,<m0>,...,<m4>]   - set every cell; mask 0-63, bit0 = dot 1 ... bit5 = dot 6");
  out.println("                           '-' keeps a cell, missing cells are cleared,");
  out.println("                           also show,xHHHH... (hex) or show,<braille chars>");
  out.println("  cell,<i>,<mask>        - set one cell (0-4), others untouched");
  out.println("  text,<chars>           - up to 5 of A-Z, '_' or space = blank cell");
  out.println("  clear | space          - retract every cell (braille space)");
  out.println("  clear,<i>              - retract one cell");
  out.println("  get                    - current masks of all cells");
  out.println("  anim[,<ms>]            - step delay between dots: 0 = normal, 20-2000 = slow");
  out.println("  idle[,<down_s>,<sleep_s>] - idle policy, 0 disables a stage (default 2,300)");
  out.println("  refresh                - re-drive every dot to match the current masks");
  out.println("  sleep                  - clear the display and switch off all PWM");
  out.println("  <letter>               - show an A-Z letter on every cell");
  out.println("  min | max              - all pins down / up, one by one (also all,min / all,max)");
  out.println("  <index>,<pwm>          - raw PWM value 90-520 on one servo (calibration)");
  out.println("  <index>,min | max      - one servo to its calibrated retracted / extended position");
  out.println("  dump                   - print the calibration table");
  out.println("  help | ?               - this text");
  out.println("Append \" #<tag>\" to any command to get the tag echoed in its OK/ERR line.");
}

// --- 6. Argument parsing ---
// True when s is a non-empty run of decimal digits.
bool is_uint(const String &s) {
  if (s.length() == 0) return false;
  for (unsigned k = 0; k < s.length(); k++) {
    if (!isDigit(s[k])) return false;
  }
  return true;
}

// Parses a decimal token into [0, max_value].
// Returns 1 = ok, 0 = not a number, -1 = out of range.
int parse_uint(const String &s, long max_value, long &out) {
  if (!is_uint(s)) return 0;
  if (s.length() > 9) return -1;  // would overflow toInt()
  out = s.toInt();
  return (out <= max_value) ? 1 : -1;
}

int hex_nibble(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  c |= 0x20;
  return (c >= 'a' && c <= 'f') ? c - 'a' + 10 : -1;
}

// Parses <cells> into target (pre-filled with 0 = blank). Accepts a decimal
// list ("1,3,-,0"), hex ("x010309") or UTF-8 braille characters.
// Returns the number of cells given, or -1 after replying ERR itself.
int parse_cells(String a, uint8_t target[MAX_CELLS], Reply &r) {
  a.trim();
  if (a.length() == 0) return 0;  // "show" == clear all

  if (a[0] == 'x' || a[0] == 'X') {  // hex: x0103091911
    unsigned n = a.length() - 1;
    // A bare "x" is a broken frame, not "clear all".
    if (n == 0 || n % 2 || n / 2 > MAX_CELLS) { r.err("badarg", "hex"); return -1; }
    for (unsigned c = 0; c < n / 2; c++) {
      int hi = hex_nibble(a[1 + 2 * c]);
      int lo = hex_nibble(a[2 + 2 * c]);
      if (hi < 0 || lo < 0) { r.err("badarg", "hex"); return -1; }
      int v = hi * 16 + lo;
      if (v > 63) { r.err("range", "cell " + String(c)); return -1; }
      target[c] = v;
    }
    return n / 2;
  }

  if ((uint8_t)a[0] == 0xE2) {  // U+2800..U+283F = E2 A0 80..BF
    if (a.length() % 3 || a.length() / 3 > MAX_CELLS) { r.err("badarg", "utf8"); return -1; }
    for (unsigned c = 0; c < a.length() / 3; c++) {
      uint8_t b0 = a[3 * c], b1 = a[3 * c + 1], b2 = a[3 * c + 2];
      if (b0 != 0xE2 || b1 != 0xA0 || b2 < 0x80 || b2 > 0xBF) {
        r.err("badarg", "not 6-dot braille");
        return -1;
      }
      target[c] = b2 - 0x80;
    }
    return a.length() / 3;
  }

  unsigned start = 0;  // decimal: 1,3,-,0
  uint8_t c = 0;
  while (true) {
    int end = a.indexOf(',', start);
    String tok = a.substring(start, end < 0 ? a.length() : end);
    tok.trim();
    if (c >= MAX_CELLS) { r.err("range", "max 5 cells"); return -1; }

    long m;
    int p = parse_uint(tok, 63, m);
    if (tok == "-") target[c] = cell_mask[c];
    else if (p > 0) target[c] = m;
    else if (p < 0) { r.err("range", "cell " + String(c) + " 0-63"); return -1; }
    else { r.err("badarg", "cell " + String(c) + " '" + tok + "'"); return -1; }

    c++;
    if (end < 0) break;
    start = end + 1;
  }
  return c;
}

// Motion needs both PCA9685s: a mask can touch any of the 30 servos.
bool motion_allowed(Reply &r) {
  if (pwm1_ok && pwm2_ok) return true;
  r.err("hw", pwm1_ok ? "pwm2" : "pwm1");
  return false;
}

// --- 7. Command handlers ---
// Legacy "<index>,<pwm|min|max>" - now validated (digits only, no silent 0).
void cmd_servo(const String &target, String value, Reply &r) {
  long index;
  if (parse_uint(target, TOTAL_SERVOS - 1, index) <= 0) {
    r.err("range", "servo '" + target + "'");
    return;
  }
  uint8_t i = index;

  value.trim();
  uint16_t pwm_value;
  String shown;
  if (value.equalsIgnoreCase("min")) {
    pwm_value = servo_range[i].retracted;
    shown = "min";
  } else if (value.equalsIgnoreCase("max")) {
    pwm_value = servo_range[i].extended;
    shown = "max";
  } else {
    // Reject instead of silently clamping: "5,45" (typo for 450) must not
    // drive a mirrored servo to 90 and report success.
    long v;
    int p = parse_uint(value, PWM_MAX, v);
    if (p == 0) { r.err("badarg", "pwm '" + value + "'"); return; }
    if (p < 0 || v < PWM_MIN) { r.err("range", "pwm " + String(PWM_MIN) + "-" + String(PWM_MAX)); return; }
    pwm_value = v;
    shown = String(pwm_value);
  }

  // Only the module that drives this servo has to be present (calibration).
  const char *module = (i < SERVOS_PER_MODULE) ? "pwm1" : "pwm2";
  if (!module_ok(i)) {
    r.err("hw", module);
    return;
  }

  r.info("Setting servo " + String(i) + " to PWM " + String(pwm_value));
  hold[i] = HOLD_UNKNOWN;  // next show/refresh re-drives it
  if (!set_servo_from_global_index(i, pwm_value)) {
    note_fail(i);
    r.err("hw", module);
    return;
  }
  asleep = false;
  delay(SETTLE_MS);
  last_motion_ms = millis();
  r.ok("servo", String(i) + " " + shown);
}

// The single command handler: one line in, info lines plus exactly one
// OK/ERR terminal line out.
void handle_command(String line, Print &out) {
  line.trim();
  if (line.length() == 0) return;  // unreachable: serial_poll() drops blank lines

  // Optional " #<tag>" suffix, echoed in the terminal line.
  String tag;
  int h = line.lastIndexOf(" #");
  if (h >= 0 && (unsigned)h + 2 < line.length() && line.indexOf(' ', h + 1) < 0) {
    tag = line.substring(h + 1);
    line = line.substring(0, h);
    line.trim();
  }
  Reply r{out, tag};

  int comma = line.indexOf(',');
  String verb = (comma < 0) ? line : line.substring(0, comma);
  String args = (comma < 0) ? String("") : line.substring(comma + 1);  // NOT trimmed (text, AB)
  verb.trim();
  String v = verb;
  v.toLowerCase();
  uint8_t t[MAX_CELLS] = {0};
  uint32_t t0 = millis();

  if (verb.length() == 0) { r.err("badcmd", line); return; }  // e.g. ",5"

  // 1. Legacy raw servo - only an all-digit target followed by a value.
  if (isDigit(verb[0])) {
    if (comma < 0 || !is_uint(verb)) { r.err("badcmd", line); return; }
    cmd_servo(verb, args, r);
    return;
  }

  // Verbs without arguments reject a stray ",..." instead of running anyway:
  // "refresh,2" or "sleep,2" must not act on the whole device.
  if (comma >= 0 && (v == "hello" || v == "ping" || v == "get" || v == "refresh" ||
                     v == "sleep" || v == "dump" || v == "help" || v == "?")) {
    r.err("badarg", v + " takes no args");
    return;
  }

  // 2. New verbs (>= 2 letters, never numeric).
  if (v == "hello") {
    check_pwm_modules();
    r.ok("hello", String("fw=" FW_VERSION " proto=") + PROTO_VERSION +
         " cells=" + MAX_CELLS + " dots=" + PINS_PER_CELL +
         " pwm1=" + (pwm1_ok ? "ok" : "fail") + " pwm2=" + (pwm2_ok ? "ok" : "fail"));
    return;
  }

  if (v == "ping") { r.ok("ping"); return; }

  if (v == "get") {
    String s;
    for (uint8_t c = 0; c < MAX_CELLS; c++) {
      if (c) s += ',';
      s += String((int)cell_mask[c]);
    }
    r.ok("get", s);
    return;
  }

  if (v == "show") {
    if (!motion_allowed(r) || parse_cells(args, t, r) < 0) return;
    finish_motion(r, "show", "", apply_masks(t), t0);
    return;
  }

  if (v == "cell") {  // cell,<i>,<mask>
    int c2 = args.indexOf(',');
    String si = args.substring(0, c2 < 0 ? args.length() : c2);
    si.trim();
    long ci;
    int p = parse_uint(si, MAX_CELLS - 1, ci);
    if (c2 < 0 || p == 0) { r.err("badarg", "cell,<0-4>,<mask>"); return; }
    if (p < 0) { r.err("range", "cell 0-4"); return; }

    String sm = args.substring(c2 + 1);
    sm.trim();
    memcpy(t, cell_mask, MAX_CELLS);
    if (sm != "-") {  // "-" keeps the cell as it is
      if (sm.indexOf(',') >= 0) { r.err("badarg", "one mask"); return; }
      long m;
      int pm = parse_uint(sm, 63, m);
      if (pm > 0) {
        t[ci] = m;  // decimal parsed here, so errors name the mask, not "cell 0"
      } else if (pm < 0) {
        r.err("range", "mask 0-63");
        return;
      } else if (sm.length() && (sm[0] == 'x' || sm[0] == 'X' || (uint8_t)sm[0] == 0xE2)) {
        uint8_t one[MAX_CELLS] = {0};
        int n = parse_cells(sm, one, r);
        if (n < 0) return;
        if (n != 1) { r.err("badarg", "one mask"); return; }
        t[ci] = one[0];
      } else {
        r.err("badarg", "mask '" + sm + "'");
        return;
      }
    }
    if (!motion_allowed(r)) return;
    finish_motion(r, "cell", si + " ", apply_masks(t), t0);
    return;
  }

  if (v == "text") {  // text,<chars> - not trimmed, so "text, AB" keeps its blank
    // Characters first: "text,żółw" needs masks, it is not "too long".
    for (unsigned c = 0; c < args.length(); c++) {
      char ch = args[c];
      if (ch != ' ' && ch != '_' && letter_mask(ch) == 0xFF) { r.err("badarg", "use masks"); return; }
    }
    if (args.length() > MAX_CELLS) { r.err("range", "max 5 cells"); return; }
    for (unsigned c = 0; c < args.length(); c++) {
      char ch = args[c];
      t[c] = (ch == ' ' || ch == '_') ? 0 : letter_mask(ch);
    }
    if (!motion_allowed(r)) return;
    finish_motion(r, "text", "", apply_masks(t), t0);
    return;
  }

  if (v == "clear" || v == "space") {
    if (comma >= 0) {  // clear,<cell>
      args.trim();
      long ci;
      int p = parse_uint(args, MAX_CELLS - 1, ci);
      if (p == 0) { r.err("badarg", "clear,<0-4>"); return; }
      if (p < 0) { r.err("range", "cell 0-4"); return; }
      if (!motion_allowed(r)) return;
      memcpy(t, cell_mask, MAX_CELLS);
      t[ci] = 0;
      finish_motion(r, "clear", String(ci) + " ", apply_masks(t), t0);
      return;
    }
    if (!motion_allowed(r)) return;
    r.info("Clearing all cells");
    finish_motion(r, "clear", "", apply_masks(t), t0);
    return;
  }

  if (v == "anim") {  // anim[,<ms>]
    args.trim();
    if (args.length()) {
      long ms;
      int p = parse_uint(args, ANIM_MAX_MS, ms);
      if (p == 0) { r.err("badarg", "anim,<ms>"); return; }
      if (p < 0 || (ms > 0 && ms < CASCADE_DELAY_MS)) { r.err("range", "0 or 20-2000"); return; }
      step_delay_ms = (ms == 0) ? CASCADE_DELAY_MS : ms;
    }
    r.ok("anim", String(step_delay_ms));
    return;
  }

  if (v == "idle") {  // idle[,<down_s>,<sleep_s>]
    args.trim();
    if (args.length()) {
      int c2 = args.indexOf(',');
      if (c2 < 0) { r.err("badarg", "idle,<down_s>,<sleep_s>"); return; }
      String sd = args.substring(0, c2);
      String ss = args.substring(c2 + 1);
      sd.trim();
      ss.trim();
      long down_s, sleep_s;
      int pd = parse_uint(sd, IDLE_MAX_S, down_s);
      int ps = parse_uint(ss, IDLE_MAX_S, sleep_s);
      if (pd == 0 || ps == 0) { r.err("badarg", "idle,<down_s>,<sleep_s>"); return; }
      if (pd < 0 || ps < 0) { r.err("range", "0-86400"); return; }
      idle_down_ms = down_s * 1000UL;
      idle_sleep_ms = sleep_s * 1000UL;
    }
    r.ok("idle", String(idle_down_ms / 1000) + "," + String(idle_sleep_ms / 1000));
    return;
  }

  if (v == "refresh") {
    if (!motion_allowed(r)) return;
    for (uint8_t i = 0; i < TOTAL_SERVOS; i++) hold[i] = HOLD_UNKNOWN;
    memcpy(t, cell_mask, MAX_CELLS);
    finish_motion(r, "refresh", "", apply_masks(t), t0);
    return;
  }

  if (v == "sleep") {
    if (!motion_allowed(r)) return;
    go_to_sleep();
    if (motion_failed(r)) return;
    r.ok("sleep");
    return;
  }

  // 3. Legacy words - human text kept, terminal line added.
  if (v == "dump") {
    dump_calibration(out);
    r.ok("dump", String(TOTAL_SERVOS));
    return;
  }

  if (v == "help" || v == "?") {
    print_help(out);
    r.ok("help");
    return;
  }

  // Whole device: "min" / "max" (also accepted as "all,min" / "all,max").
  bool whole = (v == "all");
  String endstop = whole ? args : verb;
  endstop.trim();
  if ((whole || comma < 0) && (endstop.equalsIgnoreCase("min") || endstop.equalsIgnoreCase("max"))) {
    if (!motion_allowed(r)) return;
    bool up = endstop.equalsIgnoreCase("max");
    r.info(String("Setting all servos to ") + (up ? "max" : "min"));
    for (uint8_t i = 0; i < TOTAL_SERVOS; i++) hold[i] = HOLD_UNKNOWN;  // full cascade, as before
    memset(t, up ? 0x3F : 0x00, MAX_CELLS);
    finish_motion(r, up ? "max" : "min", "", apply_masks(t), t0);
    return;
  }

  // A single letter shows that character on every cell at once.
  if (comma < 0 && verb.length() == 1 && letter_mask(verb[0]) != 0xFF) {
    if (!motion_allowed(r)) return;
    char letter = toupper(verb[0]);
    r.info(String("Displaying '") + letter + "' on all cells");
    memset(t, letter_mask(letter), MAX_CELLS);
    finish_motion(r, "letter", String(letter) + " ", apply_masks(t), t0);
    return;
  }

  r.err("badcmd", line);  // never falls into servo 0 any more
}

// --- 8. Serial transport ---
// Non-blocking line reader; replaces readStringUntil() and its 1 s timeout.
// Accepts \n, \r or \r\n (Arduino IDE / pio monitor / terminals all differ).
char rx_buf[CMD_MAX_LEN + 1];
uint8_t rx_len = 0;
bool rx_overflow = false;
bool rx_bad = false;       // control byte seen in this line
bool rx_nonblank = false;  // line has something other than spaces/tabs

void serial_poll() {
  while (Serial.available() > 0) {
    char c = (char)Serial.read();

    if (c == '\r' || c == '\n') {
      bool too_long = rx_overflow;
      bool bad = rx_bad;
      bool have_line = rx_nonblank;  // blank lines are ignored like empty ones
      rx_buf[rx_len] = '\0';
      rx_len = 0;
      rx_overflow = false;
      rx_bad = false;
      rx_nonblank = false;

      if (too_long) {
        Serial.println("ERR range line too long");
      } else if (bad) {
        Serial.println("ERR badarg control byte");
      } else if (have_line) {
        last_cmd_ms = millis();
        handle_command(String(rx_buf), Serial);
      }
      continue;
    }

    // A NUL would silently cut the line short ("12,4<NUL>30" -> "12,4"), so any
    // control byte rejects the whole line instead of being stored.
    if (((uint8_t)c < 0x20 && c != '\t') || c == 0x7F) { rx_bad = true; continue; }
    if (c != ' ' && c != '\t') rx_nonblank = true;

    if (rx_len < CMD_MAX_LEN) rx_buf[rx_len++] = c;
    else rx_overflow = true;
  }
}

const char *reset_reason_str(esp_reset_reason_t reason) {
  switch (reason) {
    case ESP_RST_POWERON:   return "poweron";
    case ESP_RST_EXT:       return "ext";
    case ESP_RST_SW:        return "sw";
    case ESP_RST_PANIC:     return "panic";
    case ESP_RST_INT_WDT:   return "int_wdt";
    case ESP_RST_TASK_WDT:  return "task_wdt";
    case ESP_RST_WDT:       return "wdt";
    case ESP_RST_DEEPSLEEP: return "deepsleep";
    case ESP_RST_BROWNOUT:  return "brownout";
    case ESP_RST_SDIO:      return "sdio";
    default:                return "unknown";
  }
}

void setup() {
  Serial.setRxBufferSize(RX_BUFFER_SIZE);  // must precede begin()
  Serial.begin(115200);

  pwm1_ok = init_module(pwm1, pwm1_prescale);
  pwm2_ok = init_module(pwm2, pwm2_prescale);

  delay(100);

  // Known state at boot: the PCA9685 outputs start off, so every servo is limp
  // at an unknown position. Retract everything (full 30-servo cascade, ~0.7 s).
  for (uint8_t i = 0; i < TOTAL_SERVOS; i++) hold[i] = HOLD_UNKNOWN;
  if (pwm1_ok && pwm2_ok) {
    uint8_t blank[MAX_CELLS] = {0};
    apply_masks(blank);
  }

  print_help(Serial);
  if (!pwm1_ok) Serial.println("PCA9685 #1 (0x40) not found - motion disabled");
  if (!pwm2_ok) Serial.println("PCA9685 #2 (0x41) not found - motion disabled");

  emit_event(String("EVT boot fw=" FW_VERSION " proto=") + PROTO_VERSION +
             " reason=" + reset_reason_str(esp_reset_reason()));
  last_cmd_ms = millis();
}

void loop() {
  serial_poll();
  idle_tick();
  delay(1);  // yield; the loop otherwise spins
}
