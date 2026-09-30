# Braille device

Urządzenie do nauki alfabetu Braille'a — projekt dyplomowy (inżynierka). Firmware ESP32
steruje 30 mikroserwami (5 komórek brajlowskich × 6 punktów) przez dwa moduły PCA9685
na I2C. Aplikacja przeglądarkowa (`app/`) łączy się z urządzeniem przez USB (Web Serial)
i prowadzi naukę.

Podział odpowiedzialności: **firmware = „głupi wyświetlacz”** (przyjmuje 6-bitowe maski
punktów dla każdej komórki), **aplikacja = znaczenie** (alfabet, polskie znaki, cyfry,
tryby nauki, dźwięk, postępy). Nowe znaki dodaje się w JSON-ie aplikacji, nie w firmware.

## Stan prac i następne kroki (aktualizuj na koniec każdej sesji)

Wszystko jest na **`master`** (PR #2 z `etap1-protocol-v1` scalony przed audytem dostępności
i testem z użytkownikiem). Uruchomienie na nowym komputerze: `README.md`.

**Zrobione:**
- Firmware 0.4.0, protokół v1 (poprawiony parser, `show`/`cell`/`get`/…, OK/ERR po ruchu,
  stan wyświetlacza, idle). Firmware 0.4.1 działa na ESP32: aplikacja łączy się przez USB,
  `show` odpowiada (np. `OK show moved=6 ms=221`), kalibracja poprawiona po pierwszych testach.
- Aplikacja: Kurs L0–L7 z odblokowaniem, Poznaj znak, Rozpoznawanie, Powtórki (Leitner),
  Słowa, Wyświetl tekst, mowa/sygnały/tryb czytnika ekranu, lista komend w sekcji serwisowej.
- Testy: 495 (Vitest), typecheck i build zielone.

**Najpierw przy urządzeniu — test sprzętowy firmware** (lista z opisu PR #2):
`EVT boot` → `hello` (oba PCA9685 `ok`) → `7,430`, `7,min`, `dump` (kalibracja jak dawniej)
→ `show,5,21,30` („kot”) → `7,mni` daje `ERR` i serwo się nie rusza → aplikacja łączy się
przez USB. Zapisać wartości `ms=` z odpowiedzi (pomiary do pracy). Zwrócić uwagę, czy
wyłączanie PWM schowanych punktów po 2 s nie powoduje problemów.

**Dalej wg planu (`docs/PROPOZYCJA.md` §6, tydzień 7+):**
1. Profile uczniów (IndexedDB), macierz pomyłek (`M[pokazany][odpowiedziany]`),
   ekran „Postępy” dla nauczyciela, eksport CSV prób — dane do rozdziału ewaluacji.
2. Pisanie akordami F D S J K L (umiejętność `write` w Leitnerze) + test ghostingu klawiatury;
   „Znajdź inny” / „Porównaj” (`discriminate`).
3. Nagrane MP3 nazw liter (syntezator źle czyta pojedyncze litery), testy z NVDA,
   przegląd dostępności (axe-core, WCAG 2.2 AA).
4. Opcjonalnie: minimum odpowiedzi, żeby przerwana sesja Powtórek się liczyła (dziś wystarczy 1).

**Decyzje autora (nie zmieniać bez pytania):** odstępy Leitnera w sesjach (nie dniach);
Powtórki liczą się do zaliczenia tylko dla bieżącej lekcji; podpowiedź z punktami (krok ≥ 2)
= próba niepoprawna (`REVEALING_HINT`); znak wielkiej litery = punkty 4-6; znak ćwiczenia na
komórce 3 (`QUIZ_CELL`/`ITEM_CELL` = 2); reguła dekad w Poznaj znak na dwa naciśnięcia.

## Jak pracować w tym repo

- **Windows / PowerShell:** `npm.ps1` jest blokowany przez politykę skryptów — używaj
  `npm.cmd …` (albo Git Bash / cmd). Komendy aplikacji uruchamiaj w `app/`.
- **Przed commitem** w `app/`: `npm.cmd run typecheck`, `npx vitest run`, `npm.cmd run build`;
  zmiana w `src/main.cpp` → `pio run`. Raportuj faktyczne wyniki.
- **Sprawdzenie w przeglądarce:** `npx vite --port 5199` w `app/`, Chrome → „Tryb symulacji”.
  Po teście zatrzymaj serwer (proces `node … vite … 5199`).
- Firmware i `MockDevice` muszą odpowiadać identycznie — zmiana protokołu = zmiana w obu,
  w `docs/PROTOCOL.md` i w liście komend (`app/src/ui/commandReference.ts`; test porównuje
  ją z `print_help()` w firmware).
- Nie commituj ani nie pushuj bez prośby autora; commity po angielsku, rozmowa po polsku.
- **Bez `Co-Authored-By: Claude`** (ani innych dopisków o AI) w commitach i opisach PR — decyzja autora.

## Dokumentacja projektowa (`docs/`)

| Plik | Zawartość |
|---|---|
| `docs/PROPOZYCJA.md` | Architektura, rekomendacja (USB + Web Serial), tryby nauki, tabela polskiego brajla (§5), plan etapowy, ryzyka, plan ewaluacji |
| `docs/PROTOCOL.md` | **Źródło prawdy protokołu v1** — składnia komend, formaty odpowiedzi, model stanu, idle, szkice kodu |
| `docs/DYDAKTYKA.md` | Kolejność nauki, ćwiczenia, dostępność (NVDA, TTS), badanie pilotażowe |

Przy rozbieżności kod ↔ `docs/PROTOCOL.md` — popraw jedno albo drugie, nie zostawiaj dryfu.
Firmware i `app/src/device/MockDevice.ts` muszą wypisywać **identyczne** linie odpowiedzi.

## Stack

### Firmware (`src/main.cpp`)
- **Platforma:** PlatformIO, `board = denky32` (ESP32, mostek USB-UART), framework Arduino
- **Biblioteka:** `adafruit/Adafruit PWM Servo Driver Library@^3.0.3`
- **Build:** `pio run` · **Upload:** `pio run -t upload` · **Monitor:** `pio device monitor -b 115200`
  - Na komputerze domowym `pio` jest w `~/.platformio/penv/Scripts/pio.exe` (Git Bash).
  - Na komputerze w pracy `pio` nie jest w PATH (zainstalowany `pip install --user platformio`):
    `$APPDATA/Python/Python314/Scripts/pio.exe` (Git Bash). Na innym komputerze sprawdź
    `pio --version` / `python -m platformio --version`; brak → `pip install --user platformio`.
    Pierwszy `pio run` pobiera toolchain ESP32 (kilka minut).
- `platformio.ini` **jest w gicie** (`.gitignore` ma `*.ini` + wyjątek `!platformio.ini`).

### Aplikacja (`app/`)
- Vite + TypeScript (strict) + Vitest, czysty DOM (bez frameworka UI), docelowo PWA.
- `npm.cmd install` · `npm.cmd run dev` (localhost — Web Serial działa bez HTTPS)
  · `npm.cmd test` · `npm.cmd run typecheck` · `npm.cmd run build` (Node 24)
- Web Serial działa tylko w **Chrome/Edge na desktopie**. Bez urządzenia: „Tryb symulacji”
  (`MockDevice`).
- Struktura: `src/braille/` (tabela `pl-braille.json` + translator + paginacja po 5
  komórek), `src/device/` (protokół, `DeviceLink`, `WebSerialDevice`, `MockDevice`),
  `src/learn/` (kurs, postępy, słowa), `src/modes/` (tryby), `src/audio/` (mowa, sygnały),
  `src/settings.ts`, `src/ui/`.
- **Tryby:** Kurs (lista lekcji), Poznaj znak (znak na komórce 3, punkt po punkcie, reguły
  dekad), Rozpoznawanie (quiz — zapisuje próby kursu; liczy się pierwsza odpowiedź,
  podpowiedź z punktami = próba niepoprawna, stała `REVEALING_HINT`), Słowa
  (`src/learn/words.json`, ≤ 5 komórek, tylko z odblokowanych liter), Wyświetl tekst,
  Powtórki (ten sam przebieg próby co Rozpoznawanie — `createRecognizeMode({ variant: 'review' })`).
- **Powtórki Leitnera** (`src/learn/leitner.ts`, stan w `braillelab.leitner.v1`): 5 pudełek,
  odstępy w **sesjach powtórek** (1, 2, 4, 8, 16). Awans tylko karty zaległej (lub nowej)
  przy odpowiedzi poprawnej, bez odkrywającej podpowiedzi i szybkiej (≤ min(6 s, 1,5 × mediana
  ucznia)); wolna/z podpowiedzią — zostaje; błąd — pudełko 1. Ćwiczenie przed terminem nie
  przesuwa terminu. Sesja: ~60% zaległe, ~30% bieżąca lekcja, ~10% nowe, 20 prób; pomyłka
  wraca raz w tej samej sesji. Oba quizy aktualizują pudełka; Powtórki zapisują próby kursu
  tylko dla bieżącej lekcji. Licznik sesji rośnie po zakończeniu Powtórek (także przerwanych
  — zamykane przy następnym Starcie).
- **Informacja zwrotna:** tryby mówią przez `ctx.say()` (aria-live + synteza pl-PL, a przy
  włączonej opcji „Używam czytnika ekranu” tylko aria-live) i `ctx.tone()`. Przed wypowiedzeniem
  `speechText()` (`src/audio/spokenNumbers.ts`) zamienia cyfry na słowa: numery punktów/komórek/
  pudełek w mianowniku („punktem cztery”, „na komórce jeden”), liczba przed kropką słownie
  (inaczej syntezator czyta „4.” jako „czwartego”). Tekst na ekranie zostaje z cyframi. Polecenie
  „dotknij” pada dopiero po `OK` z urządzenia. Skróty: F1 powtórz, F2 podpowiedź,
  F3 mrugnij, Esc wróć do wyboru ćwiczenia (`ctx.setKeys()`). Bez limitów czasu.
- **Kurs:** `src/learn/curriculum.json` — lekcje L0 (punkty 1–6) i L1–L7 (po 5 liter,
  kolejność dekadowa). Reguły dekad (`rule`: L3 = L1 + punkt 3 itd.) są sprawdzane przy
  ładowaniu. Odblokowanie: ≥ 80% poprawnych w ostatnich 20 próbach (`unlock` w JSON;
  opcjonalny limit mediany czasu). Zaliczenie jest trwałe. Postępy w `localStorage`
  (`braillelab.progress.v1`); próby zapisuje `recordAttempt()` z `src/learn/session.ts`.

## Sprzęt

| Element | Wartość |
|---|---|
| Moduł PWM #1 | I2C `0x40`, kanały 0–15 → serwa 0–15 |
| Moduł PWM #2 | I2C `0x41`, kanały 0–15 → serwa 16–29 |
| Serwa | SG90, PWM 50 Hz, oscylator 27 MHz |
| Komórki | 5 (`MAX_CELLS`), po 6 punktów (`PINS_PER_CELL`) = 30 serw |
| Zasilanie serw | osobne 5 V ≥ 3 A, wspólna masa, ≥ 1000 µF na V+ każdego PCA9685 |

Indeks globalny serwa: `cell * 6 + dot_index`, gdzie `dot_index` 0–5 odpowiada
punktom brajlowskim 1–6. `set_servo_from_global_index()` sam wybiera moduł.

Urządzenie **nie ma wejścia** (przycisków) — odpowiedzi ucznia idą przez aplikację.
Zdarzenia `EVT key` są zarezerwowane w protokole na przyszłe przyciski.

## Struktura repo

Śledzone: `.gitignore`, `README.md`, `CLAUDE.md`, `platformio.ini`, `src/main.cpp`, `docs/`, `app/`
(bez `node_modules/`, `app/dist/`). Ignorowane: `/include`, `/lib`, `/test` (zakotwiczone
do korzenia, żeby nie łapały katalogów w `app/`), `.vscode/`, `.cache/`, `.pio/`.

Branche: `master` (główny; scalone PR #1 z `tester` i PR #2 z `etap1-protocol-v1`).

## Protokół v1 (skrót — szczegóły w `docs/PROTOCOL.md`)

Linia tekstu = komenda, 115200 8N1, max 96 B, `\n` / `\r\n` / `\r`.
Każda komenda kończy się **dokładnie jedną** linią `OK <verb> …` lub `ERR <kod> …`,
wysłaną **po** kaskadzie i `SETTLE_MS` (120 ms) — aplikacja działa stop-and-wait.
Zdarzenia spontaniczne: `EVT boot fw=… proto=1 reason=…`, `EVT sleep`.
Linie niezaczynające się od `OK `/`ERR `/`EVT ` to informacje dla człowieka.

Maska komórki: bit0 = punkt 1 … bit5 = punkt 6 (znak Unicode = `U+2800 + maska`).

| Komenda | Działanie |
|---|---|
| `hello` | Handshake, bez ruchu → `OK hello fw=… proto=1 cells=5 dots=6 pwm1=ok pwm2=ok` |
| `show[,m0,…,m4]` | Cały wyświetlacz; `-` = bez zmian, brakujące = puste → `OK show moved=N ms=T` |
| `cell,<i>,<mask>` | Jedna komórka |
| `text,<≤5 znaków A–Z _>` | Skrót testowy (ASCII) |
| `clear,<i>` / `get` | Czyszczenie komórki / odczyt stanu `OK get a,b,c,d,e` |
| `anim[,<ms>]` | Krok kaskady (0 = `CASCADE_DELAY_MS`, 20–2000 = nauka punkt po punkcie) |
| `idle[,<down_s>,<sleep_s>]` | Polityka bezczynności (domyślnie 2 s / 300 s) |
| `ping` / `refresh` / `sleep` | Keepalive / dociśnięcie wszystkich punktów / wyczyść i wyłącz PWM |

Kody błędów: `badcmd`, `badarg`, `range`, `hw` (`busy` zarezerwowany na kolejkę z etapu 3 — firmware Etap 1 nie ma kolejki). Opcjonalny sufiks ` #<tag>`
jest odsyłany w odpowiedzi.

**Zasady nazw komend:** nowa komenda ma ≥ 2 znaki, nie zaczyna się od cyfry
(pojedyncza litera = „pokaż literę na wszystkich komórkach”; cyfra = numer serwa).
Gałąź `<index>,<pwm>` przyjmuje tylko cyfry — wszystko inne → `ERR badcmd`
(dawniej nieznane komendy z przecinkiem trafiały w serwo 0 z PWM 90).

**Aplikacja nie wysyła komend ruchu przed `OK hello … proto=1`** — stary firmware
odpowie na `hello` „Unknown command” i nic nie ruszy. Otwarcie portu resetuje ESP32,
więc aplikacja czeka na `EVT boot` / ponawia `hello` przez ~3 s.

## Kalibracja serw (per-servo)

Serwa są zamontowane pod różnymi kątami, część **lustrzanie** — dlatego zakresy
są per-servo, nie globalne. Tablica `servo_range[TOTAL_SERVOS]` w `src/main.cpp`
trzyma parę `{retracted, extended}` (punkt schowany / wysunięty) dla każdego serwa.

Dla serwa lustrzanego `retracted` może być **większe** niż `extended` — to jest
poprawne i obsługiwane; kod nigdzie nie zakłada, że min < max.
**Nie zmieniaj wartości w `servo_range` przy refaktoryzacji** — to dane z fizycznej kalibracji.

- `set_servo_state(index, bool)` — jedyna droga ruchu do pozycji krańcowej; czyta tablicę.
- `set_servo_from_global_index(index, pwm)` — surowy PWM, do kalibracji.
  Ogranicza wartość do `PWM_MIN`/`PWM_MAX` i odrzuca indeksy ≥ 30.
- Wyłączenie PWM (`setPWM(ch, 0, 4096)`, FULL_OFF) idzie **z pominięciem** clampu —
  przez `set_servo_from_global_index(i, 4096)` wartość zostałaby obcięta do 520.
- Po bezczynności PWM traci tylko punkt **schowany**; wysunięty opadłby pod palcem.
- Symulator ma kopię tablicy (dla `dump`) w `app/src/device/MockDevice.ts` — zmiana wiersza
  w `servo_range` wymaga tej samej zmiany tam; test w `app/test/mockDevice.test.ts` porównuje
  obie tablice i nie przejdzie, dopóki się różnią.
- Po 300 s bez komend wyświetlacz się czyści (`EVT sleep`). Na czas ręcznej kalibracji
  wyłącz auto-uśpienie: `idle,2,0`.
- `DEFAULT_RETRACTED` / `DEFAULT_EXTENDED` to tylko wartości startowe wierszy
  tablicy — po skalibrowaniu wpisuj liczby wprost do wiersza danego serwa.

### Procedura kalibracji

1. Wgraj firmware, otwórz monitor szeregowy 115200.
2. `<index>,<pwm>` — np. `7,430`, dobierz wartość aż punkt siedzi jak trzeba.
3. Wpisz znalezione `retracted` i `extended` do wiersza tego serwa w `servo_range`.
4. `<index>,min` / `<index>,max` — weryfikacja zapisanych wartości.
5. `dump` — wypisuje całą tablicę jako CSV (`index,cell,dot,retracted,extended`).

### Komendy kalibracyjne (zachowane, + końcowe `OK`)

| Komenda | Działanie |
|---|---|
| `<index>,<pwm>` | Surowy PWM na jedno serwo (kalibracja); wartość spoza `PWM_MIN`–`PWM_MAX` (90–520) → `ERR range`, nie jest już po cichu obcinana |
| `<index>,min` / `<index>,max` | Jedno serwo do pozycji z tablicy |
| `min` / `max` (lub `all,min` / `all,max`) | Wszystkie 30 pinów, pełną kaskadą |
| `<litera>` | Litera A–Z na **wszystkich** komórkach naraz |
| `clear` / `space` | Chowa wszystkie punkty (spacja brajlowska) |
| `dump` | CSV z tablicą kalibracji |
| `help` / `?` | Lista komend |

Nic nie rusza 30 serw jednocześnie — każdy ruch idzie kaskadą (najpierw chowanie,
potem wysuwanie), ruszane są tylko punkty, które się zmieniają.

## Konwencje

- Kod i komentarze w `src/main.cpp` i `app/src` — po angielsku; tekst UI aplikacji — po polsku.
- Słownik `braille_alphabet[26][6]` w firmware: `1` = punkt wysunięty, `0` = schowany;
  kolejność w wierszu to punkty 1,2,3,4,5,6. Używany tylko przez komendy testowe
  (`<litera>`, `text`) — aplikacja korzysta z `app/src/braille/pl-braille.json`.
- Polski brajl: ą 16, ć 146, ę 156, ł 126, ń 1456, ó 346, ś 246, ź 2346, ż 12346,
  znak liczby 3456, znak wielkiej litery 46 (potwierdzone przez autora; podwójny = cały
  wyraz wielkimi). Interpunkcja ma `"verified": false` — do sprawdzenia z normą PZN.
- `CASCADE_DELAY_MS` (20 ms) między punktami — efekt kaskady, ogranicza też
  szczytowy pobór prądu przy ruchu serw.
