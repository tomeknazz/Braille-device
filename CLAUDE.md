# Braille device

Urządzenie do nauki alfabetu Braille'a. Firmware ESP32 sterujący 30 mikroserwami
(5 komórek brajlowskich × 6 punktów) przez dwa moduły PCA9685 na I2C.

## Stack

- **Platforma:** PlatformIO, `board = denky32` (ESP32), framework Arduino
- **Biblioteka:** `adafruit/Adafruit PWM Servo Driver Library@^3.0.3`
- **Build:** `pio run` · **Upload:** `pio run -t upload` · **Monitor:** `pio device monitor -b 115200`
  - `pio` nie jest w PATH; pełna ścieżka: `~/.platformio/penv/Scripts/platformio.exe`

## Sprzęt

| Element | Wartość |
|---|---|
| Moduł PWM #1 | I2C `0x40`, kanały 0–15 → serwa 0–15 |
| Moduł PWM #2 | I2C `0x41`, kanały 0–15 → serwa 16–29 |
| Serwa | SG90, PWM 50 Hz, oscylator 27 MHz |
| Komórki | 5 (`MAX_CELLS`), po 6 punktów (`PINS_PER_CELL`) = 30 serw |

Indeks globalny serwa: `cell * 6 + dot_index`, gdzie `dot_index` 0–5 odpowiada
punktom brajlowskim 1–6. `set_servo_from_global_index()` sam wybiera moduł.

## Struktura repo

Repo jest minimalne — tylko `.gitignore` i `src/main.cpp` są śledzone.
`.gitignore` zawiera `*.ini`, więc **`platformio.ini` nie jest w gicie** (istnieje
lokalnie). Ignorowane są też `include/`, `lib/`, `test/`, `.vscode/`, `.cache/`, `.pio/`.

## Branche

| Branch | Zawartość |
|---|---|
| `master` | Wersja bazowa: `set_servo_from_global_index(index, bool)`, pętla demo A–Z w komentarzu |
| `tester` | **Aktywny.** Program testowy — sterowanie serwami przez Serial, surowe wartości PWM |
| `air/write-me-an-app-...` | Wariant testera wygenerowany przez agenta; funkcjonalnie ≈ `tester`, dodatkowo commituje `.cache/jb/` |

## Kalibracja serw (per-servo)

Serwa są zamontowane pod różnymi kątami, część **lustrzanie** — dlatego zakresy
są per-servo, nie globalne. Tablica `servo_range[TOTAL_SERVOS]` w `src/main.cpp`
trzyma parę `{retracted, extended}` (punkt schowany / wysunięty) dla każdego serwa.

Dla serwa lustrzanego `retracted` może być **większe** niż `extended` — to jest
poprawne i obsługiwane; kod nigdzie nie zakłada, że min < max.

- `set_servo_state(index, bool)` — jedyna droga ruchu do pozycji krańcowej;
  czyta tablicę. `display_letter()` używa wyłącznie tej funkcji.
- `set_servo_from_global_index(index, pwm)` — surowy PWM, do kalibracji.
  Ogranicza wartość do `PWM_MIN`/`PWM_MAX` i odrzuca indeksy ≥ 30.
- `DEFAULT_RETRACTED` / `DEFAULT_EXTENDED` to tylko wartości startowe wierszy
  tablicy — po skalibrowaniu wpisuj liczby wprost do wiersza danego serwa.

### Procedura kalibracji

1. Wgraj firmware, otwórz monitor szeregowy 115200.
2. `<index>,<pwm>` — np. `7,430`, dobierz wartość aż punkt siedzi jak trzeba.
3. Wpisz znalezione `retracted` i `extended` do wiersza tego serwa w `servo_range`.
4. `<index>,min` / `<index>,max` — weryfikacja zapisanych wartości.
5. `dump` — wypisuje całą tablicę jako CSV (`index,cell,dot,retracted,extended`).

### Komendy testera (Serial, 115200)

| Komenda | Działanie |
|---|---|
| `<index>,<pwm>` | Surowy PWM na jedno serwo (kalibracja) |
| `<index>,min` / `<index>,max` | Jedno serwo do pozycji z tablicy |
| `min` / `max` (lub `all,min` / `all,max`) | Wszystkie 30 pinów, kaskadą co `CASCADE_DELAY_MS` |
| `<litera>` | Litera A–Z na **wszystkich** komórkach naraz |
| `clear` / `space` | Chowa wszystkie punkty (spacja brajlowska) |
| `dump` | CSV z tablicą kalibracji |
| `help` / `?` | Lista komend |

Nic nie rusza 30 serw jednocześnie — każdy ruch idzie kaskadą, co ogranicza
szczytowy pobór prądu.

## Konwencje

- Kod i komentarze w `src/main.cpp` — po angielsku.
- Słownik `braille_alphabet[26][6]`: `1` = punkt wysunięty, `0` = schowany;
  kolejność w wierszu to punkty 1,2,3,4,5,6.
- `CASCADE_DELAY_MS` (20 ms) między punktami — efekt kaskady, ogranicza też
  szczytowy pobór prądu przy jednoczesnym ruchu serw.
