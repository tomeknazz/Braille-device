# Braille Device — Firmware Command Protocol v1

This spec extends `src/main.cpp` (master @ `c43969e`). Every existing calibration command keeps working. The same protocol runs over USB serial, WebSocket and BLE.

---

## 0. Summary

- The app sends **6-bit dot masks per cell**. The firmware does not need to know about letters. The bit layout matches Unicode braille (`U+2800 + mask`). Polish diacritics, capital and number signs, and punctuation all live in the app.
- **New verbs are words of 2 or more letters**, dispatched **before** the numeric `<index>,<pwm>` branch. The numeric branch now only accepts a target made of digits.
- Every command, old or new, ends with **exactly one terminal line**: `OK <verb> …` or `ERR <code> …`. It is sent **after the cascade and a settle time**, so the app can use stop-and-wait pacing.
- The firmware keeps **`cell_mask[5]` and a hold state for each servo**. Only dots that changed are moved. Retracted dots lose PWM after 2 s. After a long idle period the display clears and all PWM is switched off.
- There is **one `handle_command()`**. Serial, WebSocket and BLE callbacks only put lines into a FreeRTOS queue. Only `loop()` touches I2C and the servos.

---

## 1. How the current parser works, and where new commands would collide

`loop()` (lines 242–332) splits on the **first comma**. It checks `dump`, `help`, `?`, `all`/`min`/`max`, then single letters, then `clear`/`space`. **Anything else that has a comma** goes to:

```cpp
int servoIndex = target.toInt();   // line 310: toInt() of a non-number is 0
...
pwmValue = value.toInt();          // line 323: non-number becomes 0, clamped to PWM_MIN = 90
```

What the current firmware does with inputs a new app might send:

| Input | Current behaviour |
|---|---|
| `show,1,3,9,0,0` | servo **0** → PWM 1 → clamped to **90** |
| `clear,2` | servo 0 → PWM 90 |
| `min,5` | servo 0 → PWM 90 (the comma skips the whole-device branch) |
| `w,abc` | servo 0 → PWM 90 (the letter branch requires no comma) |
| `7,mni` (typo) | servo 7 → PWM 90 |

Servo 0's range is `{470, 430}` (mirrored), so PWM 90 drives it far past its stop. Servos 5, 11, 12, 17, 18, 23, 24 and 29 (the mirrored ~450–510 servos) are in the same situation.

**Rules that follow from this:**
1. A new verb must never start with a digit. It must be at least 2 characters (single letters already mean "show letter"). It must not be one of `min max all dump help clear space`, except where this spec extends those on purpose.
2. New verbs are dispatched before the numeric branch.
3. The numeric branch checks that the target is **all digits** and the value is **all digits, `min` or `max`**. Anything else gets `ERR`.
4. **Handshake first.** On old firmware, `hello` has no comma, so it prints `Unknown command: hello` and nothing moves. The app must send `hello` and must not send any other new verb until it gets `OK hello … proto=1`. That keeps an old board safe.

---

## 2. Framing

```
request  := <verb>[,<arg>]*[ #<tag>] <EOL>
EOL      := "\n" | "\r" | "\r\n"          (serial/BLE; one WS text message = one line)
reply    := <info-line>* <terminal-line>
terminal := "OK " <verb> [" " <data>] [" #" <tag>]
          | "ERR " <code> [" " <detail>] [" #" <tag>]
event    := "EVT " <name> [" " <data>]    (unsolicited, may arrive at any time)
```

- Verbs are case-insensitive. The maximum line length is **96 bytes** (`CMD_MAX_LEN`); longer lines get `ERR range line too long`.
- **Info lines** are the existing human-readable text (`Setting servo 7 to PWM 430`, the `dump` CSV, help text). They are kept as they are. The app ignores any line that does not start with `OK `, `ERR ` or `EVT `.
- **`#tag`** is optional. If present, it is echoed in the terminal line. It lets WS/BLE clients match replies to requests. Serial monitor users never need it.
- The terminal line is sent **after the last servo has had time to settle** (`SETTLE_MS`). When the app sees `OK show`, the dots are physically up and can be read.
- **App contract:** one outstanding request per client (stop-and-wait). Timeout = `1500 ms + 30 × (anim_ms + 5)`. The firmware queue holds 8 lines; when it is full the reply is `ERR busy`. *(Etap 1 firmware has no queue: `serial_poll()` calls `handle_command()` directly and never sends `ERR busy`; the queue arrives with the WiFi/BLE transports.)*

**Error codes:** `badcmd` (unknown verb), `badarg` (parse error), `range` (value or index out of range, line too long), `busy` (queue full — from Etap 3; Etap 1 firmware never sends it), `hw` (a PCA9685 did not ACK).

---

## 3. Dot-mask encoding

`mask` is 0–63. **bit0 = dot 1, bit1 = dot 2, bit2 = dot 3, bit3 = dot 4, bit4 = dot 5, bit5 = dot 6.** This is the same order as the rows of `braille_alphabet` and the same as `dot_index` in `cell * 6 + dot_index`.

This layout is **identical to Unicode braille**: character = `U+2800 + mask`. The app can store lessons as braille strings (`⠁⠃⠉`), draw them on screen, and send `ch.codePointAt(0) - 0x2800` without a lookup table.

Examples (the full table belongs in the app, not the firmware):

| Char | Dots | Mask | Char | Dots | Mask |
|---|---|---|---|---|---|
| a | 1 | 1 | ą | 1,6 | 33 |
| b | 1,2 | 3 | ł | 1,2,6 | 35 |
| c | 1,4 | 9 | ó | 3,4,6 | 44 |
| d | 1,4,5 | 25 | ż | 1,2,3,4,6 | 47 |
| e | 1,5 | 17 | capital sign (PL) | 4,6 | 40 |
| | | | number sign | 3,4,5,6 | 60 |

So `żaba` is `show,47,1,3,1`. `Ala` with the capital sign is `show,40,1,7,1` and uses 4 of the 5 cells.

**Cell argument forms.** All of them are accepted wherever `<cells>` appears:

| Form | Example | Purpose |
|---|---|---|
| Decimal list | `show,1,3,9,25,17` | Easy to read and type by hand. `-` means "leave this cell as it is". |
| Hex, 2 digits per cell | `show,x010309` | Compact, for BLE (12 bytes fits the 20-byte default ATT payload). |
| Unicode braille (UTF-8) | `show,⠁⠃⠉` | Each character is `E2 A0 80..BF`. Handy in a serial terminal and in demos. |

**If fewer than 5 cells are given, the remaining cells are cleared.** Paging longer text is the app's job: each page is one `show`.

---

## 4. Command reference

### 4.1 New verbs (strict replies)

| Command | Effect | Terminal reply |
|---|---|---|
| `hello` | Handshake, no movement. Also resets the idle timer. | `OK hello fw=0.4.0 proto=1 cells=5 dots=6 pwm1=ok pwm2=ok` |
| `ping` | Keepalive, no movement. Resets the sleep timer. | `OK ping` |
| `show[,<cells>]` | Sets the whole display. No args clears everything. | `OK show moved=7 ms=312` |
| `cell,<i>,<mask>` | Sets one cell (mask as decimal, `xHH` or one braille character). Other cells are not touched. | `OK cell 2 moved=3 ms=150` |
| `text,<chars>` | Convenience: up to 5 of A–Z/a–z, with `_` or space as a blank cell. The argument is **not trimmed**, so `text, AB` keeps its leading blank. Any other byte, including UTF-8 `ą`, gets `ERR badarg use masks`. | `OK text moved=… ms=…` |
| `clear,<i>` | Clears one cell. | `OK clear 1 moved=…` |
| `get` | Current state, no movement. | `OK get 1,3,9,0,0` |
| `anim[,<ms>]` | Sets the step delay between dots: 0 = normal (`CASCADE_DELAY_MS`), otherwise 20–2000 for slow teaching mode. No arg reports the current value. | `OK anim 300` |
| `idle[,<down_s>,<sleep_s>]` | Idle policy (section 6). 0 disables that stage. | `OK idle 2,300` |
| `refresh` | Re-sends PWM to every dot to match `cell_mask`. Use it after a learner may have pushed a pin, or after sleep. | `OK refresh moved=30 ms=…` |
| `sleep` | Clears the display now and switches off all PWM. | `OK sleep` |

### 4.2 Legacy commands (same behaviour and human text, plus one terminal line)

| Command | Now also | Terminal |
|---|---|---|
| `<i>,<pwm>` | Digits-only check on target and value. The servo's hold state becomes `UNKNOWN`. | `OK servo 7 430` / `ERR badarg …` |
| `<i>,min` / `<i>,max` | Same as above. | `OK servo 7 max` |
| `min` / `max` / `all,min` / `all,max` | Routed through `apply_masks()` with every servo set to `UNKNOWN` first, so the cascade is still the full 30 servos (needed for calibration checks). | `OK max moved=30 ms=…` |
| `<letter>` | Routed through `apply_masks()`, so only changed dots move. | `OK letter A moved=…` |
| `clear` / `space` | Same, all cells. | `OK clear moved=…` |
| `dump` | CSV unchanged. | `OK dump 30` (lets the app read the calibration table) |
| `help` / `?` | Help text now lists every verb. | `OK help` |

### 4.3 Events

| Event | When |
|---|---|
| `EVT boot fw=0.4.0 proto=1 reason=poweron\|brownout\|sw\|…` | End of `setup()`, from `esp_reset_reason()`. `brownout` points to the servo power supply. |
| `EVT sleep` | Auto-sleep happened. The app should show "device asleep" and send `show` again when the user returns. |
| `EVT state 1,3,9,0,0 src=ws` | *(optional)* Broadcast to every transport after any change, so a teacher's phone and a PC UI show the same state. |
| `EVT key <n>` / `EVT keys <mask>` | **Reserved** for optional hardware input: 5 buttons (one per cell, "I'm touching this one"), or a 6-key Perkins-style keyboard sending a dot mask. The app handles both like UI answers. |

---

## 5. Display state model

```cpp
enum Hold : uint8_t {
  HOLD_UNKNOWN,   // boot, after a raw-PWM command, after `refresh` is requested
  HOLD_POWERED,   // PWM is actively holding the position recorded in cell_mask
  HOLD_RESTING    // PWM off, dot is RETRACTED and rests on its stop (position trusted)
};
uint8_t cell_mask[MAX_CELLS];      // what the learner should feel
Hold    hold[TOTAL_SERVOS];
```

- A dot is **skipped** when `want == have && hold != HOLD_UNKNOWN`.
- **Two passes: retract first, then extend.** Fewer servos pull against each other. In anim mode the learner feels the old letter disappear, then the new dots rise in order 1→6, cell by cell. That order is the teaching effect.
- The delay is inserted **only between real moves**. Today every letter costs 30 × 20 ms = 600 ms, even for dots that do not change.
- After the last move, `delay(SETTLE_MS)` (default 120 ms; an SG90 at ~60°/0.1 s covers the ~40-tick travel in roughly 40–60 ms). Then the reply is sent. `ms=` in the reply gives real latency numbers you can report in the thesis.
- **Boot:** every servo starts `HOLD_UNKNOWN`, then `apply_masks({0,0,0,0,0})`. This is a full 30-servo retract cascade (~0.7 s), after which the state is known. The PCA9685 outputs are off at power-on, so before this the servos are limp and their positions unknown.
- **Cell order:** cell 0 must be the **leftmost cell from the reader's side**. If the wiring is reversed, fix it with a `CELL_ORDER[]` map in the firmware, never in the app.

---

## 6. Idle, power and safety

**Two-stage idle** (`idle,<down_s>,<sleep_s>`; default `2,300`):

1. **Stage "down"** (2 s after the last motion): switch off PWM on every **retracted** dot (`POWERED → RESTING`). A retracted pin already sits on its stop, and a finger can only push it further down, so nothing is lost. Buzzing and idle current drop by roughly the share of dots that are down, which is most of them.
   **Extended dots keep PWM.** Reading braille means pressing on the dots, and an SG90 without a signal holds only by gear friction, so an extended pin would sink. *Verify on the hardware that retracted pins do not creep up because of linkage springback. If they do, set `idle,0,300`.*
2. **Stage "sleep"** (300 s since the last *command*, not the last motion; the app sends `ping` while a lesson screen is open): run `apply_masks(blank)`, switch off all 30 channels, set every servo to `RESTING`, and emit `EVT sleep`. The state stays known (all down), so the next `show` only drives the dots that rise.

**Switching a channel off:** `setPWM(ch, 0, 4096)`. Bit 12 of the OFF register is the FULL_OFF flag. This **must bypass** `set_servo_from_global_index()`, whose clamp would turn 4096 into `PWM_MAX = 520` and drive the servo to its extreme. Add a separate `detach_servo()` (section 8).

**Other safety items:**
- Reject non-numeric raw PWM values (see section 1). Keep the global 90–520 clamp for the calibration workflow.
- Check that both PCA9685s ACK at boot (`pwm.begin()` returns `false` in library v3.x if the device is missing) and in `hello` (`Wire.beginTransmission(addr); Wire.endTransmission() == 0`). If one is missing, motion commands get `ERR hw pwm2`.
- **Power:** use a separate 5 V supply rated at least 3 A for the servos, with a common GND and a bulk capacitor of at least 1000 µF on each PCA9685 V+. `EVT boot reason=brownout` is the diagnostic for this.
- *(Hardware, optional)* Connect the PCA9685 `OE` pins to an ESP32 GPIO held HIGH until `setup()` has configured the chips. That gives a clean boot with no twitch and an instant all-off switch.
- Calibrated end values should stop slightly short of the mechanical stop. A servo stalled against a stop draws current and heats continuously, which matters most for extended dots, since they stay powered.

---

## 7. Architecture: one handler, many transports

```
 USB serial ──LineAssembler──┐
 WebSocket (AsyncTCP task) ──┼──► xQueue<CmdMsg>(8) ──► loop(): handle_command() ──► I2C / servos
 BLE NUS (NimBLE host task) ─┘                                 │
                                                               └──► send_reply(src, client) / emit_event()
```

- **Only `loop()` touches I2C, the servos and the state arrays.** On ESP32 Arduino, `delay()` is `vTaskDelay()`, so the WiFi and BLE stacks keep running on their own tasks during a 600 ms cascade.
- The real risk is **doing servo work inside an AsyncTCP or NimBLE callback**. That blocks those tasks and leads to WS disconnects, BLE supervision timeouts and watchdog resets. Callbacks copy the line into the queue and return.
- The queue also **serialises all clients**: if serial and WS both send, commands run in arrival order and each client gets its own reply.
- Phase 1 keeps the blocking cascade. With `anim` set to 1000 ms, a full refresh blocks for about 30 s and cannot be interrupted. Limit anim to about 500 ms for now. A later refactor can turn `apply_masks` into a non-blocking step machine (one dot per `loop()` tick), which would also make a `stop` verb possible.
- Build flags `-D USE_WIFI=0/1 -D USE_BLE=0/1` compile the transports in or out. Serial is always on, for calibration.

---

## 8. Code sketches (same style as `main.cpp`)

### 8.1 Constants, state, helpers

```cpp
#define FW_VERSION     "0.4.0"
#define PROTO_VERSION  1
#define CMD_MAX_LEN    96
#define CMD_QUEUE_LEN  8
#define SETTLE_MS      120
#define ANIM_MAX_MS    2000

enum Hold : uint8_t { HOLD_UNKNOWN, HOLD_POWERED, HOLD_RESTING };

uint8_t  cell_mask[MAX_CELLS] = {0};
Hold     hold[TOTAL_SERVOS];                 // zero-init = HOLD_UNKNOWN
uint16_t step_delay_ms  = CASCADE_DELAY_MS;
uint32_t idle_down_ms   = 2000;
uint32_t idle_sleep_ms  = 300000;
uint32_t last_motion_ms = 0;
uint32_t last_cmd_ms    = 0;
bool     asleep = false;
bool     pwm1_ok = false, pwm2_ok = false;

// Row of braille_alphabet -> 6-bit mask (bit d = dot d+1). 0xFF = not A-Z.
uint8_t letter_mask(char c) {
  c = toupper(c);
  if (c < 'A' || c > 'Z') return 0xFF;
  uint8_t m = 0;
  for (uint8_t d = 0; d < PINS_PER_CELL; d++)
    if (braille_alphabet[c - 'A'][d]) m |= (1 << d);
  return m;
}

// Removes the pulse entirely. Deliberately bypasses the PWM_MIN/PWM_MAX clamp:
// 4096 is the PCA9685 FULL_OFF flag, not a pulse width.
void detach_servo(uint8_t i) {
  if (i >= TOTAL_SERVOS) return;
  if (i < SERVOS_PER_MODULE) pwm1.setPWM(i, 0, 4096);
  else                       pwm2.setPWM(i - SERVOS_PER_MODULE, 0, 4096);
}

bool is_uint(const String &s) {
  if (s.length() == 0) return false;
  for (unsigned k = 0; k < s.length(); k++) if (!isDigit(s[k])) return false;
  return true;
}
```

### 8.2 Diff-based cascade (the only path to end positions)

```cpp
// Moves only dots whose target differs from what is physically held.
// Pass 0 retracts, pass 1 extends. Returns number of servos driven.
uint8_t apply_masks(const uint8_t target[MAX_CELLS]) {
  uint8_t moved = 0;
  for (uint8_t pass = 0; pass < 2; pass++) {
    bool extend_pass = (pass == 1);
    for (uint8_t cell = 0; cell < MAX_CELLS; cell++) {
      for (uint8_t d = 0; d < PINS_PER_CELL; d++) {
        bool want = (target[cell] >> d) & 1;
        if (want != extend_pass) continue;
        uint8_t i = cell * PINS_PER_CELL + d;
        bool have = (cell_mask[cell] >> d) & 1;
        if (want == have && hold[i] != HOLD_UNKNOWN) continue;
        if (moved) delay(step_delay_ms);
        set_servo_state(i, want);
        hold[i] = HOLD_POWERED;
        moved++;
      }
    }
  }
  memcpy(cell_mask, target, MAX_CELLS);
  if (moved) { delay(SETTLE_MS); last_motion_ms = millis(); }
  asleep = false;
  return moved;
}

// Kept for API compatibility (master's demo loop).
void display_letter(char letter, uint8_t cell) {
  if (cell >= MAX_CELLS) return;
  uint8_t m = (letter == ' ') ? 0 : letter_mask(letter);
  if (m == 0xFF) return;
  uint8_t t[MAX_CELLS]; memcpy(t, cell_mask, MAX_CELLS);
  t[cell] = m;
  apply_masks(t);
}
```

### 8.3 Reply sink and the single handler

```cpp
class StringPrint : public Print {           // lets the handler write to any transport
 public:
  String buf;
  size_t write(uint8_t c) override { buf += (char)c; return 1; }
};

struct Reply {
  Print &out; String tag;
  void info(const String &s) { out.println(s); }
  void ok(const String &verb, const String &data = "") {
    out.print("OK "); out.print(verb);
    if (data.length()) { out.print(' '); out.print(data); }
    if (tag.length())  { out.print(' '); out.print(tag); }
    out.println();
  }
  void err(const char *code, const String &detail = "") {
    out.print("ERR "); out.print(code);
    if (detail.length()) { out.print(' '); out.print(detail); }
    if (tag.length())    { out.print(' '); out.print(tag); }
    out.println();
  }
};

String motion_data(uint8_t moved, uint32_t t0) {
  return "moved=" + String(moved) + " ms=" + String(millis() - t0);
}

void handle_command(String line, Print &out);   // below

String handle_command(const String &line) {     // transport-agnostic entry point
  StringPrint sp;
  handle_command(line, sp);
  return sp.buf;
}
```

```cpp
int hex_nibble(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  c |= 0x20;
  return (c >= 'a' && c <= 'f') ? c - 'a' + 10 : -1;
}

// Parses <cells> into target (pre-filled with 0 = blank). Replies ERR itself.
bool parse_cells(String a, uint8_t target[MAX_CELLS], Reply &r) {
  a.trim();
  if (a.length() == 0) return true;                          // "show" == clear all

  if (a[0] == 'x' || a[0] == 'X') {                          // hex: x0103091911
    unsigned n = a.length() - 1;
    if (n % 2 || n / 2 > MAX_CELLS) { r.err("badarg", "hex"); return false; }
    for (unsigned c = 0; c < n / 2; c++) {
      int hi = hex_nibble(a[1 + 2 * c]), lo = hex_nibble(a[2 + 2 * c]);
      int v = (hi < 0 || lo < 0) ? -1 : hi * 16 + lo;
      if (v < 0 || v > 63) { r.err("range", "cell " + String(c)); return false; }
      target[c] = v;
    }
    return true;
  }

  if ((uint8_t)a[0] == 0xE2) {                               // U+2800..U+283F = E2 A0 80..BF
    if (a.length() % 3 || a.length() / 3 > MAX_CELLS) { r.err("badarg", "utf8"); return false; }
    for (unsigned c = 0; c < a.length() / 3; c++) {
      uint8_t b0 = a[3 * c], b1 = a[3 * c + 1], b2 = a[3 * c + 2];
      if (b0 != 0xE2 || b1 != 0xA0 || b2 < 0x80 || b2 > 0xBF) { r.err("badarg", "not 6-dot braille"); return false; }
      target[c] = b2 - 0x80;
    }
    return true;
  }

  unsigned start = 0; uint8_t c = 0;                         // decimal: 1,3,-,0
  while (true) {
    int end = a.indexOf(',', start);
    String tok = a.substring(start, end < 0 ? a.length() : end);
    tok.trim();
    if (c >= MAX_CELLS)        { r.err("range", "max 5 cells"); return false; }
    if (tok == "-")            target[c] = cell_mask[c];
    else if (is_uint(tok) && tok.toInt() <= 63) target[c] = tok.toInt();
    else                       { r.err("badarg", "cell " + String(c) + " '" + tok + "'"); return false; }
    c++;
    if (end < 0) break;
    start = end + 1;
  }
  return true;
}
```

```cpp
bool motion_allowed(Reply &r) {
  if (pwm1_ok && pwm2_ok) return true;
  r.err("hw", pwm1_ok ? "pwm2" : "pwm1");
  return false;
}

// Legacy "<index>,<pwm|min|max>" - now validated.
void cmd_servo(const String &target, String value, Reply &r) {
  value.trim();
  if (!is_uint(target) || target.toInt() >= TOTAL_SERVOS) { r.err("range", "servo '" + target + "'"); return; }
  uint8_t i = target.toInt();
  uint16_t pwm;
  if      (value.equalsIgnoreCase("min")) pwm = servo_range[i].retracted;
  else if (value.equalsIgnoreCase("max")) pwm = servo_range[i].extended;
  else if (is_uint(value))                pwm = value.toInt();
  else { r.err("badarg", "pwm '" + value + "'"); return; }
  r.info("Setting servo " + String(i) + " to PWM " + String(pwm));   // unchanged human text
  set_servo_from_global_index(i, pwm);
  hold[i] = HOLD_UNKNOWN;                    // next show/refresh re-drives it
  last_motion_ms = millis();
  r.ok("servo", String(i) + " " + value);
}

void handle_command(String line, Print &out) {
  line.trim();
  if (line.length() == 0) return;

  String tag;                                   // optional " #<id>"
  int h = line.lastIndexOf(" #");
  if (h >= 0) { tag = line.substring(h + 1); line = line.substring(0, h); line.trim(); }
  Reply r{out, tag};

  int comma   = line.indexOf(',');
  String verb = (comma < 0) ? line : line.substring(0, comma);
  String args = (comma < 0) ? String("") : line.substring(comma + 1);  // NOT trimmed (text,)
  verb.trim();
  String v = verb; v.toLowerCase();
  uint8_t t[MAX_CELLS] = {0};
  uint32_t t0 = millis();

  // 1. Legacy raw servo - only when the target STARTS with a digit.
  if (isDigit(v[0])) {
    if (comma < 0) { r.err("badcmd", line); return; }
    if (motion_allowed(r)) cmd_servo(verb, args, r);
    return;
  }

  // 2. New verbs (>= 2 chars, never numeric).
  if (v == "hello") {
    r.ok("hello", String("fw=" FW_VERSION " proto=") + PROTO_VERSION +
         " cells=" + MAX_CELLS + " dots=" + PINS_PER_CELL +
         " pwm1=" + (pwm1_ok ? "ok" : "fail") + " pwm2=" + (pwm2_ok ? "ok" : "fail"));
    return;
  }
  if (v == "ping") { r.ok("ping"); return; }
  if (v == "get") {
    String s;
    for (uint8_t c = 0; c < MAX_CELLS; c++) { if (c) s += ','; s += cell_mask[c]; }
    r.ok("get", s);
    return;
  }
  if (v == "show") {
    if (!motion_allowed(r) || !parse_cells(args, t, r)) return;
    r.ok("show", motion_data(apply_masks(t), t0));
    return;
  }
  if (v == "cell") {                              // cell,<i>,<mask>
    int c2 = args.indexOf(',');
    String si = args.substring(0, c2 < 0 ? args.length() : c2); si.trim();
    if (c2 < 0 || !is_uint(si) || si.toInt() >= MAX_CELLS) { r.err("badarg", "cell,<0-4>,<mask>"); return; }
    uint8_t one[MAX_CELLS] = {0};
    if (!parse_cells(args.substring(c2 + 1), one, r)) return;   // reuse: 1 token = cell 0
    memcpy(t, cell_mask, MAX_CELLS);
    t[si.toInt()] = one[0];
    if (!motion_allowed(r)) return;
    r.ok("cell", si + " " + motion_data(apply_masks(t), t0));
    return;
  }
  if (v == "text") {
    if (args.length() > MAX_CELLS) { r.err("range", "max 5 cells"); return; }
    for (unsigned c = 0; c < args.length(); c++) {
      char ch = args[c];
      uint8_t m = (ch == ' ' || ch == '_') ? 0 : letter_mask(ch);
      if (m == 0xFF) { r.err("badarg", "use masks for non A-Z"); return; }
      t[c] = m;
    }
    if (!motion_allowed(r)) return;
    r.ok("text", motion_data(apply_masks(t), t0));
    return;
  }
  if (v == "anim") {
    if (args.length()) {
      args.trim();
      if (!is_uint(args) || args.toInt() > ANIM_MAX_MS) { r.err("range", "0-2000"); return; }
      step_delay_ms = (args.toInt() == 0) ? CASCADE_DELAY_MS : max<long>(args.toInt(), CASCADE_DELAY_MS);
    }
    r.ok("anim", String(step_delay_ms));
    return;
  }
  if (v == "idle")    { /* parse "<down_s>,<sleep_s>", set idle_down_ms / idle_sleep_ms */ return; }
  if (v == "refresh") {
    for (uint8_t i = 0; i < TOTAL_SERVOS; i++) hold[i] = HOLD_UNKNOWN;
    memcpy(t, cell_mask, MAX_CELLS);
    if (motion_allowed(r)) r.ok("refresh", motion_data(apply_masks(t), t0));
    return;
  }
  if (v == "sleep")   { go_to_sleep(); r.ok("sleep"); return; }

  // 3. Legacy words - human text kept, terminal line added.
  if (v == "dump") { dump_calibration(out); r.ok("dump", String(TOTAL_SERVOS)); return; }
  if (v == "help" || v == "?") { print_help(out); r.ok("help"); return; }

  bool whole = (v == "all");
  String endstop = whole ? args : verb; endstop.trim();
  if ((whole || comma < 0) && (endstop.equalsIgnoreCase("min") || endstop.equalsIgnoreCase("max"))) {
    bool up = endstop.equalsIgnoreCase("max");
    r.info(String("Setting all servos to ") + (up ? "max" : "min"));
    for (uint8_t i = 0; i < TOTAL_SERVOS; i++) hold[i] = HOLD_UNKNOWN;   // full cascade, as before
    memset(t, up ? 0x3F : 0x00, MAX_CELLS);
    if (motion_allowed(r)) r.ok(up ? "max" : "min", motion_data(apply_masks(t), t0));
    return;
  }
  if (v == "clear" || v == "space") {
    if (comma >= 0) {                              // new: clear,<cell>
      args.trim();
      if (!is_uint(args) || args.toInt() >= MAX_CELLS) { r.err("range", "cell"); return; }
      memcpy(t, cell_mask, MAX_CELLS); t[args.toInt()] = 0;
    } else r.info("Clearing all cells");
    if (motion_allowed(r)) r.ok("clear", motion_data(apply_masks(t), t0));
    return;
  }
  if (comma < 0 && verb.length() == 1 && letter_mask(verb[0]) != 0xFF) {
    char L = toupper(verb[0]);
    r.info(String("Displaying '") + L + "' on all cells");
    memset(t, letter_mask(L), MAX_CELLS);
    if (motion_allowed(r)) r.ok("letter", String(L) + " " + motion_data(apply_masks(t), t0));
    return;
  }

  r.err("badcmd", line);                            // never falls into servo 0 any more
}
```

`dump_calibration()` and `print_help()` change from `Serial.print…` to `out.print…` (signature `(Print &out)`). The CSV itself stays byte-for-byte the same.

### 8.4 Idle handling

```cpp
void go_to_sleep() {
  uint8_t blank[MAX_CELLS] = {0};
  apply_masks(blank);
  for (uint8_t i = 0; i < TOTAL_SERVOS; i++) { detach_servo(i); hold[i] = HOLD_RESTING; }
  asleep = true;
}

void idle_tick() {
  uint32_t now = millis();
  if (idle_down_ms && now - last_motion_ms >= idle_down_ms) {
    for (uint8_t i = 0; i < TOTAL_SERVOS; i++) {
      bool up = (cell_mask[i / PINS_PER_CELL] >> (i % PINS_PER_CELL)) & 1;
      if (hold[i] == HOLD_POWERED && !up) { detach_servo(i); hold[i] = HOLD_RESTING; }
    }
  }
  if (idle_sleep_ms && !asleep && now - last_cmd_ms >= idle_sleep_ms) {
    go_to_sleep();
    emit_event("EVT sleep");
  }
}
```

### 8.5 Transports, queue and `loop()`

```cpp
enum Source : uint8_t { SRC_SERIAL, SRC_WS, SRC_BLE };
struct CmdMsg { Source src; uint32_t client; char line[CMD_MAX_LEN]; };
QueueHandle_t cmd_queue;

// Non-blocking line splitter; replaces readStringUntil() and its 1 s timeout.
// Accepts \n, \r or \r\n (Arduino IDE / pio monitor / terminals all differ).
struct LineAssembler {
  char buf[CMD_MAX_LEN]; uint8_t len = 0; bool overflow = false;
  int push(char c) {                       // 1 = line ready in buf, -1 = too long, 0 = more
    if (c == '\r' || c == '\n') {
      int res = overflow ? -1 : (len ? 1 : 0);
      buf[len] = '\0'; len = 0; overflow = false;
      return res;
    }
    if (len < CMD_MAX_LEN - 1) buf[len++] = c; else overflow = true;
    return 0;
  }
};

bool enqueue(Source src, uint32_t client, const char *line) {
  CmdMsg m; m.src = src; m.client = client;
  strlcpy(m.line, line, sizeof(m.line));
  return xQueueSend(cmd_queue, &m, 0) == pdTRUE;   // never block a transport task
}

LineAssembler serial_rx;
void serial_poll() {
  while (Serial.available() > 0) {
    int r = serial_rx.push((char)Serial.read());
    if (r > 0 && !enqueue(SRC_SERIAL, 0, serial_rx.buf)) Serial.println("ERR busy");
    if (r < 0) Serial.println("ERR range line too long");
  }
}

void send_reply(Source src, uint32_t client, const String &reply) {
  switch (src) {
    case SRC_SERIAL: Serial.print(reply); break;
#if USE_WIFI
    case SRC_WS:     ws.text(client, reply); break;        // one WS message per reply
#endif
#if USE_BLE
    case SRC_BLE:    ble_send(client, reply); break;
#endif
    default: break;
  }
}

void emit_event(const String &evt) {
  Serial.println(evt);
#if USE_WIFI
  ws.textAll(evt);
#endif
#if USE_BLE
  ble_send_all(evt + "\n");
#endif
}

void setup() {
  Serial.begin(115200);
  pwm1_ok = pwm1.begin();
  pwm1.setOscillatorFrequency(27000000);
  pwm1.setPWMFreq(50);
  pwm2_ok = pwm2.begin();
  pwm2.setOscillatorFrequency(27000000);
  pwm2.setPWMFreq(50);
  cmd_queue = xQueueCreate(CMD_QUEUE_LEN, sizeof(CmdMsg));

  if (pwm1_ok && pwm2_ok) {                 // known state: every dot down (~0.7 s)
    uint8_t blank[MAX_CELLS] = {0};
    apply_masks(blank);                     // all hold[] are HOLD_UNKNOWN -> full cascade
  }
#if USE_WIFI
  wifi_begin();
#endif
#if USE_BLE
  ble_begin();
#endif
  print_help(Serial);
  emit_event(String("EVT boot fw=" FW_VERSION " proto=") + PROTO_VERSION +
             " reason=" + reset_reason_str(esp_reset_reason()));
  last_cmd_ms = millis();
}

void loop() {
  serial_poll();
  CmdMsg m;
  if (xQueueReceive(cmd_queue, &m, 0) == pdTRUE) {
    last_cmd_ms = millis();
    send_reply(m.src, m.client, handle_command(String(m.line)));
  }
  idle_tick();
#if USE_WIFI
  static uint32_t t_cleanup = 0;
  if (millis() - t_cleanup > 1000) { ws.cleanupClients(); t_cleanup = millis(); }
#endif
  delay(1);                                  // yield; the loop otherwise spins
}
```

**WebSocket** (ESP32 hosts the page from LittleFS; AP mode is the safe choice at the defense because university eduroam is WPA2-Enterprise):

```cpp
#include <WiFi.h>
#include <ESPAsyncWebServer.h>   // maintained fork: ESP32Async/ESPAsyncWebServer + ESP32Async/AsyncTCP
#include <LittleFS.h>
AsyncWebServer http(80);
AsyncWebSocket ws("/ws");

void on_ws(AsyncWebSocket *, AsyncWebSocketClient *c, AwsEventType type,
           void *arg, uint8_t *data, size_t len) {
  if (type != WS_EVT_DATA) return;                 // runs on the AsyncTCP task: NO servo calls here
  AwsFrameInfo *f = (AwsFrameInfo *)arg;
  if (!f->final || f->index != 0 || f->len != len || f->opcode != WS_TEXT) return;
  if (len >= CMD_MAX_LEN) { c->text("ERR range line too long"); return; }
  char line[CMD_MAX_LEN];
  memcpy(line, data, len); line[len] = '\0';
  if (!enqueue(SRC_WS, c->id(), line)) c->text("ERR busy");
}

void wifi_begin() {
  WiFi.softAP("Braille-5", "<password>");          // http://192.168.4.1, ws://192.168.4.1/ws
  LittleFS.begin(true);
  ws.onEvent(on_ws);
  http.addHandler(&ws);
  http.serveStatic("/", LittleFS, "/").setDefaultFile("index.html");
  http.begin();
}
```

**BLE**, using the Nordic UART Service. Generic tools (nRF Connect, "Serial Bluetooth Terminal") and Web Bluetooth in Chrome on Android and desktop work with it out of the box. iOS Safari has no Web Bluetooth.

```cpp
#include <NimBLEDevice.h>           // h2zero/NimBLE-Arduino: far smaller than Bluedroid
#define NUS_SVC "6E400001-B5A3-F393-E0A9-E50E24DCCA9E"
#define NUS_RX  "6E400002-B5A3-F393-E0A9-E50E24DCCA9E"   // app -> device, write
#define NUS_TX  "6E400003-B5A3-F393-E0A9-E50E24DCCA9E"   // device -> app, notify
NimBLEServer *ble_srv; NimBLECharacteristic *ble_tx;
LineAssembler ble_rx;                // only touched on the NimBLE host task

class RxCb : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic *ch, NimBLEConnInfo &info) override {   // 2.x signature
    NimBLEAttValue v = ch->getValue();
    for (size_t k = 0; k < v.length(); k++) {
      int r = ble_rx.push((char)v.data()[k]);
      if (r > 0) enqueue(SRC_BLE, info.getConnHandle(), ble_rx.buf);  // on full queue: app times out
    }
  }
};

// Replies are '\n'-terminated lines, chunked to the negotiated MTU; the app reassembles on '\n'.
void ble_send(uint32_t conn, const String &reply) {
  size_t chunk = ble_srv->getPeerMTU(conn) - 3;
  for (size_t i = 0; i < reply.length(); i += chunk) {
    String part = reply.substring(i, i + chunk);
    ble_tx->setValue((const uint8_t *)part.c_str(), part.length());
    ble_tx->notify();
  }
}
```

---

## 9. Bugs and risks in the current `main.cpp`

| # | Where | Problem | Fix in this spec |
|---|---|---|---|
| 1 | L310 `target.toInt()` | Any comma command with a non-numeric target drives **servo 0** (`show,…`, `clear,2`, `min,5`, `w,x`). Servo 0 is mirrored at 430/470, so the clamped PWM of 90 pushes it far past its stop. | Digit-first dispatch, `is_uint()`, `ERR badcmd` |
| 2 | L323 `value.toInt()` | A typo such as `7,mni` gives 0, clamped to 90. `12,4a0` gives 4, also clamped to 90. All mirrored servos swing their full travel. | `is_uint()` on the value |
| 3 | L10–11 | The global clamp of 90–520 does not protect individual servos. It only protects the PCA/servo absolute range. | Keep it for calibration; the app only uses masks, never raw PWM |
| 4 | L245 `readStringUntil` | Blocks up to 1 s (the `Serial.setTimeout` default) on a partial line. A pause of more than 1 s mid-line splits it into two commands. There is no length cap on the `String` (heap growth). | `LineAssembler`: 96-byte cap, `\r`/`\n` terminators |
| 5 | L164, L178, L205 `delay()` | Harmless with serial only, because `delay()` = `vTaskDelay()`. With WS/BLE, the servo code must never run in their callbacks, and `loop()` cannot service anything during a cascade. | Queue plus a single consumer in `loop()` |
| 6 | No state | Every letter re-drives all 30 servos at 20 ms each (~600 ms), even for unchanged dots, with more noise and current. | `cell_mask` + `hold[]` diff |
| 7 | `setup()` | Servos are never initialised. Their position is unknown until the first command, which then jerks everything. | Boot retract cascade |
| 8 | L170 | `display_letter()` silently ignores non-A–Z characters and leaves the **previous letter** on the cell. The learner feels a stale, wrong character. | `ERR badarg` |
| 9 | L155/L287 `toupper` | UTF-8 `ą` is 2 bytes. On its own it gives "Unknown command". With a comma (`ą,1`) it drives servo 0. | Masks; `text` rejects non-ASCII |
| 10 | — | No ack and no handshake, so the app cannot pace itself or detect old firmware. | `OK/ERR` after settle; `hello` has no comma, so it is safe on old firmware |
| 11 | Hardware and host | Opening the USB serial port toggles DTR/RTS and **resets the ESP32**; `setup()` then waits 1 s. The app must wait for `EVT boot` or retry `hello` for about 3 s. | `EVT boot` |
| 12 | Future `detach` | Calling `set_servo_from_global_index(i, 4096)` would clamp to 520 and slam the servo to its extreme. | Separate `detach_servo()` |
| 13 | L216 `print_help` | Does not mention `help`/`?`, `space`, `all,min`/`all,max`. | Rewrite together with the new verbs |
| 14 | `.gitignore: *.ini` | `platformio.ini` is not in git. New `lib_deps` (AsyncWebServer, NimBLE), `board_build.filesystem = littlefs` and the partition table would not be reproducible for the thesis. | Stop ignoring `platformio.ini` and commit it |
| 15 | Flash budget | WiFi + BLE (Bluedroid) together can exceed the default ~1.3 MB app partition. | NimBLE, and/or `board_build.partitions = huge_app.csv`; pick **one** wireless transport for the thesis |

---

## 10. Implementation order

1. **Firmware v0.4 (serial only, about 1–2 days):** `LineAssembler`, validated legacy parser, `apply_masks` with state, `show`/`cell`/`text`/`get`/`hello`/`anim`/`idle`, terminal lines, boot retract. Test it by hand in `pio device monitor`: `hello`, `show,⠁⠃⠉`, `7,mni` → `ERR`.
2. **App phase 1:** PC app, or a web page using **Web Serial** in Chrome. The same JS client can later switch to WebSocket without protocol changes.
3. **Phase 2:** turn on `USE_WIFI` (ESP32-hosted UI in AP mode, which works on any phone and gives TTS through the Web Speech API) **or** `USE_BLE`. Same `handle_command()`, new transport glue only.
4. **Optional:** buttons for `EVT key`, a non-blocking motion state machine, and a `stop` verb.

Files: `C:\Users\Admin\PycharmProjects\Braille-device\src\main.cpp` (analysed, not modified). `platformio.ini` does not exist in the working tree, so it has to be created or recovered locally before any `lib_deps` are added.