# BrailleLab: projekt aplikacji do nauki alfabetu Braille'a na 5-komórkowym urządzeniu

## 1. Rekomendacja

Proponuję aplikację przeglądarkową (PWA w TypeScript) w Chrome lub Edge na laptopie. Łączy się z ESP32 kablem USB przez Web Serial. Firmware zostaje „głupim wyświetlaczem”: dostaje 6-bitowe maski punktów dla każdej komórki. Cała wiedza o alfabecie, w tym polskie znaki, cyfry i znak wielkiej litery, siedzi w aplikacji jako dane JSON. Ten wariant wygrał u wszystkich trzech sędziów: USB+PC dostał 46 / 47,5 / 46 punktów, Wi-Fi hostowane na ESP32 43 / 38 / 39, a BLE z aplikacją Flutter 40 / 36,5 / 37. Powody są trzy: najmniejsze ryzyko dla działającego układu serw (bez radia i bez nowych bibliotek), najdojrzalszy zestaw dla osoby niewidomej w Polsce (NVDA + Chrome) i najwcześniejszy działający pokaz, już po 2 tygodniach. Protokół projektuję tak, żeby nie zależał od transportu. Wi-Fi (WebSocket, telefony i iOS) można więc dodać w etapie 3 bez zmiany ani firmware'owego parsera, ani klienta w aplikacji.

## 2. Architektura

```
 Chrome/Edge (PWA, GitHub Pages, działa offline)
 ┌─────────────────────────────────────────────────────┐
 │ UI: ekrany trybów, podgląd SVG 5×6, aria-live       │
 │ learn/   kurs L0–L8, tryby, Leitner, macierz pomyłek│
 │ braille/ pl-braille.json → maski, strony po 5 kom.  │
 │ audio/   TTS pl-PL + nagrane MP3 nazw liter + tony  │
 │ store/   IndexedDB (profile, próby) → eksport CSV   │
 │ device/  DeviceLink: WebSerial | MockDevice         │
 └──────────────┬──────────────────────────────────────┘
                │ USB (mostek CP210x/CH340), 115200 8N1
                │ jedna linia tekstu = jedna komenda, stop-and-wait
 ┌──────────────▼──────────────────────────────────────┐
 │ ESP32  LineAssembler → xQueue(8) → loop():          │
 │        handle_command(line, Print&)                 │
 │          → apply_masks(target)  [diff + hold[]]     │
 │          → set_servo_state() → PCA9685 0x40 / 0x41  │
 │        OK/ERR po ruchu i czasie ustalenia; EVT boot │
 └─────────────────────────────────────────────────────┘
   (etap 3: WebSocket w AP → ta sama kolejka, ten sam handler)
```

Przepływ jednej próby:
1. Scheduler wybiera znak, np. „ł”.
2. Translator zamienia go na maskę 35.
3. `DeviceLink` wysyła `show,0,0,35`.
4. Firmware rusza tylko zmienione punkty, czeka `SETTLE_MS`, a potem odsyła `OK show moved=3 ms=…`.
5. Aplikacja gra krótki ton „gotowe” i startuje licznik czasu reakcji.
6. Uczeń odpowiada z klawiatury.
7. Aplikacja zapisuje próbę do Leitnera i do logu CSV, a potem daje informację zwrotną głosem i tonem.

`MockDevice` to symulator firmware'u w TS. Pozwala rozwijać aplikację bez sprzętu i jest planem C na obronie.

## 3. Zmiany w firmware (`src/main.cpp`), w tej kolejności

**3.1 Naprawa krytycznego błędu parsera.** Tę zmianę trzeba zrobić, zanim aplikacja wyśle cokolwiek nowego. Dziś każda linia z przecinkiem, której nie złapie wcześniejsza gałąź, trafia do `target.toInt()` w L310. Nieliczbowy tekst daje tam 0, czyli serwo 0. Wartość z `value.toInt()` w L323 jest obcinana do `PWM_MIN=90` w L129. Serwo 0 jest lustrzane i ma zakres `{470,430}`, więc PWM 90 wypycha je daleko za ogranicznik. Przykłady: `p,1,3,9,0,0`, `min,5`, `clear,2` i literówka `7,mni`, która daje serwo 7 na PWM 90.
Poprawka:
- Gałąź numeryczna rusza tylko wtedy, gdy target zaczyna się od cyfry.
- Dodać funkcję `is_uint()`, która sprawdza target i value. Value może być też `min` albo `max`.
- Wszystko inne dostaje `ERR badcmd`.
- Przed odczytem `v[0]` sprawdzić, że nazwa komendy nie jest pusta (np. linia `,5`).

**3.2 Zasady nazw komend.** Nowa komenda ma co najmniej 2 znaki i nigdy nie jest cyfrą ani pojedynczą literą, bo pojedyncza litera już znaczy „pokaż literę na wszystkich komórkach”. Dlatego odrzucam `p,` i `c,` z wariantu USB oraz `s` z wariantu Wi-Fi. Heartbeat `s` wysyłany co 10 s pokazywałby literę S na 30 serwach.

**3.3 Handshake i terminalne odpowiedzi.**
- Każda komenda, także stara, kończy się jedną linią `OK <komenda> …` albo `ERR <kod> …`.
- Odpowiedź przychodzi dopiero po ostatnim ruchu i po `SETTLE_MS` (ok. 120 ms). SG90 potrzebuje 40–100 ms na fizyczny ruch. Bez tej przerwy komunikat „dotknij” przychodziłby do ucznia, zanim punkt się podniesie.
- `hello` nie ma przecinka, więc stary firmware wypisze tylko „Unknown command” i nic się nie ruszy. Aplikacja nie wysyła żadnej komendy ruchu przed odpowiedzią `OK hello … proto=1`.

**3.4 Stan wyświetlacza z flagą dla każdego serwa.**
- Firmware trzyma `uint8_t cell_mask[5]` i `Hold hold[30]` z wartościami `UNKNOWN`, `POWERED` i `RESTING`.
- Punkt jest pomijany tylko wtedy, gdy `want == have && hold != HOLD_UNKNOWN`.
- **Nie** używać znacznika `cell_mask = 0xFF` jako „stan nieznany” (to był błąd w dwóch propozycjach). Porównanie bitowe uzna wtedy, że każdy punkt, który ma być wysunięty, już jest wysunięty, i go nie ruszy.
- Ruch idzie w dwóch przebiegach: najpierw chowanie, potem wysuwanie. `delay(step)` wstawia się tylko między faktycznymi ruchami.
- Po surowym `<i>,<pwm>` serwo dostaje `hold[i]=UNKNOWN`, więc następne `show` albo `refresh` je dociśnie.

**3.5 Znany stan po starcie.** W `setup()` wszystkie serwa dostają `UNKNOWN`, potem idzie `apply_masks({0,0,0,0,0})`. To pełna kaskada chowania, ok. 0,7 s. Dziś serwa nie są inicjalizowane, a wyjścia PCA9685 są po włączeniu wyłączone, więc serwa są luźne. Do tego:
- zapamiętać wynik `pwm.begin()` w `pwm1_ok`/`pwm2_ok`; jeśli moduł się nie zgłosi, komendy ruchu dostają `ERR hw pwm2`;
- wysłać `EVT boot fw=0.4.0 proto=1 reason=<esp_reset_reason>`, co pozwala rozpoznać brownout;
- skrócić lub usunąć `delay(1000)`.

**3.6 Odczyt linii.** `LineAssembler` zastępuje `readStringUntil` (L245), który przy niepełnej linii blokuje się do 1 s i nie ma limitu długości. Nowy odczyt ma limit 96 B i akceptuje `\r`, `\n` oraz `\r\n`. Linie trafiają do `xQueue(8)`, a jedynym miejscem, które dotyka I2C, zostaje `loop()`. Na USB to jeszcze niekonieczne, ale przygotowuje etap 3 z Wi-Fi.

**3.7 Wyłączanie PWM przy bezczynności.**
- `detach_servo(i)` wywołuje `setPWM(ch,0,4096)` (FULL_OFF) **z pominięciem** clampu. `set_servo_from_global_index(i,4096)` obcięłoby wartość do 520 i uderzyło serwem w skrajne położenie.
- Po 2 s bez ruchu wyłączyć PWM **tylko punktom schowanym**. Wysunięte bez sygnału opadłyby pod palcem.
- Po 300 s bez komend: wyczyścić wyświetlacz, wyłączyć wszystko i wysłać `EVT sleep`. Aplikacja wysyła `ping`, dopóki lekcja jest otwarta.

**3.8 Opcjonalnie: kalibracja w NVS.** `servo_range` staje się kopią w RAM, a dochodzą komendy `cal,<i>,<ret>,<ext>`, `save` i `load` przez `Preferences`. Ekran kalibracji w aplikacji wtedy zapisuje wartości bez rekompilacji i eksportuje wiersze C++.

**3.9 Build.** Plik `platformio.ini` **nie istnieje** w katalogu roboczym (sprawdziłem), mimo że CLAUDE.md mówi, że jest lokalnie. Trzeba go odtworzyć, dodać `!platformio.ini` do `.gitignore`, przypiąć wersje platformy i bibliotek i scommitować. Bez tego recenzent nie zbuduje projektu.

**Składnia komend (protokół v1).** Kodowanie maski: bit0 = punkt 1 … bit5 = punkt 6, czyli znak Unicode = `U+2800 + maska`.

| Komenda | Działanie | Odpowiedź |
|---|---|---|
| `hello` | handshake, bez ruchu | `OK hello fw=0.4.0 proto=1 cells=5 dots=6 pwm1=ok pwm2=ok` |
| `ping` | keepalive, zeruje licznik uśpienia | `OK ping` |
| `show[,m0,m1,m2,m3,m4]` | cały wyświetlacz. Maski dziesiętnie, `-` = bez zmian. Brakujące komórki = puste. Formy alternatywne: `show,x05151E` (hex) i `show,⠅⠕⠞` (UTF-8). | `OK show moved=7 ms=312` |
| `cell,<i>,<mask>` | jedna komórka (`13` lub `x0D`) | `OK cell 2 moved=3 ms=…` |
| `text,<A-Z_ >` | skrót do testów, maks. 5 znaków ASCII | `OK text …` / `ERR badarg use masks` |
| `clear[,<i>]` | czyści wszystko albo jedną komórkę | `OK clear moved=…` |
| `get` | stan bez ruchu | `OK get 5,21,30,0,0` |
| `anim[,<ms>]` | krok kaskady: 0 = 20 ms, do nauki 20–500 ms (przy blokującej kaskadzie nie więcej) | `OK anim 300` |
| `idle,<down_s>,<sleep_s>` | polityka bezczynności, domyślnie `2,300` | `OK idle 2,300` |
| `refresh` | dociśnięcie wszystkich punktów do `cell_mask` | `OK refresh moved=30 …` |
| `sleep` | czyści wyświetlacz i wyłącza PWM | `OK sleep` |
| **bez zmian (kalibracja)** `<i>,<pwm>`, `<i>,min`, `<i>,max`, `min`, `max`, `all,min`, `all,max`, `<litera>`, `clear`, `space`, `dump`, `help`, `?` | ten sam tekst co dziś plus terminalne `OK`. `min`/`max` nadal robią pełną kaskadę 30 serw. `dump` wypisuje identyczny CSV. | np. `OK servo 7 430`, `OK dump 30` |
| zdarzenia | `EVT boot …`, `EVT sleep`; zarezerwowane `EVT key <n>` i `EVT keys <mask>` dla przycisków | — |

Kody błędów: `badcmd`, `badarg`, `range`, `busy`, `hw`. Opcjonalny sufiks ` #<tag>` jest odsyłany w odpowiedzi (przyda się przy kilku klientach w etapie 3).

Przykładowa sesja:
```
< EVT boot fw=0.4.0 proto=1 reason=poweron
> hello              < OK hello fw=0.4.0 proto=1 cells=5 dots=6 pwm1=ok pwm2=ok
> show,5,21,30       < OK show moved=9 ms=301        ("kot")
> show,47,1,3,1      < OK show moved=… ms=…          ("żaba")
> 7,mni              < ERR badarg pwm 'mni'          (dziś: serwo 7 → PWM 90)
```

Wzorcowe szkice kodu (`apply_masks`, `handle_command`, `parse_cells`, `LineAssembler`, `detach_servo`) są w specyfikacji protokołu, którą dostałem jako wejście. Są napisane w stylu `main.cpp` i można je przenieść niemal 1:1.

## 4. Aplikacja

**Stack**
- **Vite + TypeScript**, UI w Preact albo lit-html. Bez ciężkich bibliotek komponentów, bo ich dostępność bywa różna.
- **Web Serial**: `port.open({baudRate:115200})`, `TextDecoderStream` i własny dzielnik linii. Po otwarciu portu ESP32 się resetuje, więc aplikacja czeka na `EVT boot` albo ponawia `hello` przez ok. 3 s. Przy kolejnych uruchomieniach łączy się automatycznie przez `getPorts()`.
- **Kolejka komend**: najwyżej 1 komenda w locie i jeden oczekujący slot, w którym nowsza komenda zastępuje starszą. Identyczna ramka nie jest wysyłana ponownie. Timeout wynosi `1500 + 30×(anim+5)` ms, a po nim aplikacja wysyła `get` i synchronizuje stan.
- **PWA** (`vite-plugin-pwa`) na GitHub Pages, czyli HTTPS, a po pierwszym wejściu działa offline.
- **Dane**: IndexedDB przez `idb`, eksport CSV i JSON.
- **Dźwięk**: Web Speech pl-PL (lokalny głos Windows „Paulina”), **nagrane MP3 z 35 nazwami liter** i kluczowymi komunikatami, bo syntezatory źle czytają pojedyncze litery, oraz tony WebAudio dla gotowe/dobrze/źle.
- **Testy**: Vitest (translator, paginacja, Leitner, tabela: każdy wpis porównany z `U+2800+maska`), Playwright + axe-core, MockDevice.

**Tryby nauki.** Kolejność kursu jest dekadowa, w paczkach po 5 liter, żeby każda lekcja mieściła się na jednym rzędzie urządzenia:
- L0: orientacja w punktach;
- L1: a–e;
- L2: f–j;
- L3: k–o (reguła „+3”);
- L4: p–t;
- L5: u v x y z („+3 i 6”);
- L6: w ą ć ę ł;
- L7: ń ó ś ź ż;
- L8: znak liczby i cyfry, znak wielkiej litery, kropka, przecinek, pytajnik.

Następna lekcja odblokowuje się przy co najmniej 80% poprawnych w ostatnich 20 próbach i medianie czasu poniżej 6 s. Kolejność kursu to dane (`curriculum.json`).

| Priorytet | Tryb | Opis |
|---|---|---|
| MVP | **Poznaj znak** | Znak na komórce 2, reszta pusta. TTS: „To jest em. Punkty 1, 3, 4”. Wariant „punkt po punkcie” (`anim,400`). Animacja reguły: `a b c d e`, potem na wszystkich komórkach wysuwa się punkt 3 i powstaje `k l m n o`. |
| MVP | **Rozpoznawanie** | Wzór próby: `clear` → 300 ms → `show` (uczeń czuje, że pojawił się nowy znak). Odpowiedź literą. Przy błędzie drabina podpowiedzi: mrugnięcie znakiem, liczba punktów, numery punktów, odpowiedź. Potem kontrast `[pokazany] [_] [wybrany]`. |
| MVP | **Słowa ≤5 komórek** | Liczone w komórkach po translacji (znaki liczby i wielkiej litery też zajmują komórkę), tylko z liter już poznanych. Na start ręczna lista 100–200 słów. |
| MVP | **Postępy** | Skuteczność i mediana czasu dla każdej litery, macierz pomyłek, podsumowanie czytane głosem, eksport CSV. |
| MVP | **Serwis i kalibracja** | Siatka 30 serw z suwakiem `<i>,<pwm>`, przyciski min/max, `dump` do tabeli i do wierszy C++, test a–z. Za przełącznikiem nauczyciela. |
| Should | **Znajdź inny** | `e e i e e`, odpowiedź klawiszem 1–5. Wariant „Gdzie jest m?”. |
| Should | **Porównaj** | `e [_] i` z par łatwych do pomylenia i z macierzy pomyłek (e/i, d/f, h/j, l/ł, s/ś, o/ó). |
| Should | **Pisanie** | Akordy F D S J K L (= punkty 1–6), zatwierdzane po puszczeniu klawiszy. Urządzenie od razu pokazuje ułożony znak, potem `[ułożony] [_] [wzór]`. |
| Should | **Powtórki Leitnera** | 5 pudełek, element = (znak, umiejętność: rozpoznawanie / pisanie / rozróżnianie). Sesja: ok. 60% zaległych, 30% bieżąca lekcja, 10% nowe. |
| Could | Czytanie stronicowane, gry, rozpoznawanie mowy | — |

**Dostępność: osoba niewidoma (domyślnie)**
- Całą aplikację da się obsłużyć z klawiatury. Pole odpowiedzi to zwykły `<input>`, więc NVDA jest w trybie formularza i nie przechwytuje klawiszy. `role=application` jest tylko w polu pisania akordami.
- Skróty: Enter = zatwierdź, F1 = powtórz, F2 = podpowiedź, F3 = mrugnij, Esc = menu. Litery i cyfry są zarezerwowane na odpowiedzi.
- **Ręczny przełącznik „używam czytnika ekranu”**, ustawiany głosowo przy pierwszym uruchomieniu. Przeglądarka nie potrafi wykryć NVDA (to był błąd w wariancie USB). Gdy przełącznik jest włączony, komunikaty idą przez `aria-live`, a własny TTS milczy. Tony działają zawsze.
- Komunikat „dotknij” pada dopiero po `OK` z urządzenia. Nie ma limitów czasu, czas reakcji jest tylko mierzony.
- **Test ghostingu klawiatury** na laptopie do obrony: ż wymaga 5 klawiszy naraz. Plan zapasowy: wpisanie numerów punktów i Enter (np. `12346`).
- Opcja: fala punktów na komórkach 0→4 po udanym `hello`, czyli dotykowe potwierdzenie połączenia.

**Dostępność: osoby widzące i słabowidzące**
- Podgląd SVG 5×6 z numerami punktów, pokazujący stan potwierdzony przez `OK`.
- Tryb „zasłonięte oczy”: podgląd jest ukryty w trakcie próby.
- Wysoki kontrast, tryb ciemny, powiększenie do 200% bez przewijania w poziomie, informacja nigdy nie tylko kolorem.
- Tryb prezentacji na projektor.

## 5. Polski alfabet Braille'a (maska = suma 2^(punkt−1))

**Litery a–z.** Ta sama tabela co `braille_alphabet` w `main.cpp`, poprawna.

| zn | pkt | mask | zn | pkt | mask | zn | pkt | mask |
|---|---|---|---|---|---|---|---|---|
| a | 1 | 1 | k | 13 | 5 | u | 136 | 37 |
| b | 12 | 3 | l | 123 | 7 | v | 1236 | 39 |
| c | 14 | 9 | m | 134 | 13 | w | 2456 | 58 |
| d | 145 | 25 | n | 1345 | 29 | x | 1346 | 45 |
| e | 15 | 17 | o | 135 | 21 | y | 13456 | 61 |
| f | 124 | 11 | p | 1234 | 15 | z | 1356 | 53 |
| g | 1245 | 27 | q | 12345 | 31 | | | |
| h | 125 | 19 | r | 1235 | 23 | | | |
| i | 24 | 10 | s | 234 | 14 | | | |
| j | 245 | 26 | t | 2345 | 30 | | | |

**Litery diakrytyczne.** Pewność wysoka, maski wzajemnie różne.

| ą | ć | ę | ł | ń | ó | ś | ź | ż |
|---|---|---|---|---|---|---|---|---|
| 16 → 33 | 146 → 41 | 156 → 49 | 126 → 35 | 1456 → 57 | 346 → 44 | 246 → 42 | 2346 → 46 | **12346 → 47** |

Uwaga: w propozycji USB ż miało punkty 1-2-3-4-5-6, czyli pełną komórkę, co jest błędem. Skojarzenie „punkt 6 = ogonek/kreska” pasuje tylko do ą, ć i ę (a/c/e + 6). ł to b + 6, a nie l + 6.

**Znaki specjalne**

| Znak | Punkty | Maska | Pewność |
|---|---|---|---|
| znak liczby ⠼ | 3456 | 60 | wysoka. Cyfry: znak liczby + a…j (1 = a … 0 = j), np. 2026 to `show,60,3,26,3,11` (5 komórek) |
| znak wielkiej litery ⠨ | 46 | 40 | **SPRAWDZIĆ z normą PZN.** Sędziowie nie zgadzają się, co podają źródła (46 czy 6). Podwójny znak = cały wyraz wielkimi literami. |
| kropka / przecinek | 3 / 2 | 4 / 2 | średnia, sprawdzić |
| ; / : | 23 / 25 | 6 / 18 | średnia, sprawdzić |
| ? / ! | 26 / 235 | 34 / 22 | średnia, sprawdzić |
| łącznik - | 36 | 36 | średnia. Myślnik zapisuje się inaczej. |
| nawias, cudzysłów, apostrof | — | — | niska. Poza MVP. |
| litera a–j tuż po cyfrze | znak rozdzielający (prawdopodobnie 56) | — | **SPRAWDZIĆ.** W MVP nie generować takich napisów. |

Źródło do cytowania w pracy: tablice Komisji ds. Brajla przy PZN albo liblouis (tabele polskie, LGPL) i konsultacja z tyflopedagogiem. `pl-braille.json` ma pole `source`, a test jednostkowy sprawdza każdy wpis. Wejście jest normalizowane do NFC. Firmware nie zna UTF-8 liter: `toupper()` na „ą” nie działa, a dziś `ą,1` rusza serwem 0.

## 6. Plan etapowy (ok. 11 tygodni plus bufor)

| Tydz. | Etap | Wynik |
|---|---|---|
| **1–2** | **Etap 1: działająca podstawa do pokazu.** Firmware v0.4 (pkt 3.1–3.7): poprawka parsera, `hello`, `OK/ERR` po ustaleniu pozycji, `cell_mask` + `hold[]`, kaskada chowania przy starcie, `show/cell/get/clear/anim/ping/refresh`, `LineAssembler`, `EVT boot`, `platformio.ini` w repo. Minimalna strona Web Serial: pole tekstowe, translator a–z, `show`, podgląd SVG. | „Wpisuję kot i urządzenie to pokazuje”. Test regresji kalibracji (`7,430`, `dump`, `min/max`). `7,mni` daje `ERR`. Pierwsze pomiary `moved/ms`. |
| 3 | Szkielet aplikacji: PWA, `DeviceLink` (kolejka, timeout, ponowne łączenie), MockDevice, `pl-braille.json` z diakrytykami i cyframi, paginacja, testy Vitest | Tabela sprawdzona ze źródłem, oznaczone „do weryfikacji” |
| 4–6 | Tryby MVP: Poznaj znak (z animacją reguł), Rozpoznawanie z drabiną podpowiedzi, Słowa ≤5. TTS + MP3 + tony, przełącznik czytnika, kurs L0–L7. **Testy z NVDA od tygodnia 4.** | Pełna pętla nauki na sprzęcie, demo dla promotora |
| 7 | Leitner, IndexedDB, profile, macierz pomyłek, Postępy, log CSV | Dane do rozdziału ewaluacji |
| 8 | Znajdź inny, Porównaj, Pisanie FDSJKL (z testem ghostingu), ekran kalibracji. Opcjonalnie `cal/save` w NVS. | Komplet trybów „Should” |
| 9 | Przegląd dostępności: NVDA i Narrator, axe-core, powiększenie 200%, kontrast. Pomiary techniczne (pkt 8). | Lista kontrolna WCAG 2.2 AA |
| 10 | Badanie pilotażowe | Wyniki przed i po, SUS |
| 11 | Bufor, zamrożenie wersji, scenariusz obrony: laptop z zainstalowaną PWA i lokalnym głosem, MockDevice na projektorze, nagranie wideo zapasowe | Gotowość do obrony |
| opcja | **Etap 3**: `-D USE_WIFI=1`, AP, WebSocket do tej samej kolejki, strona z LittleFS (telefony, iOS/VoiceOver). Albo przyciski GPIO (`EVT key`). Nieblokująca maszyna ruchu i komenda `stop`. | Tylko jeśli etapy 1–2 są zamknięte |

Pisanie pracy równolegle od tygodnia 6.

## 7. Ryzyka i jak je ograniczyć

**Ryzyka projektu**

| Ryzyko | Jak ograniczyć |
|---|---|
| Aplikacja podłączona do starego firmware'u rusza serwem 0 (PWM 90) | Poprawka parsera w tygodniu 1. Aplikacja nic nie rusza przed `OK hello proto=1`. |
| Zasilanie: 30× SG90 daje brownout i reset | Osobne 5 V, co najmniej 3 A, wspólna masa, co najmniej 1000 µF na V+ każdego PCA9685. `EVT boot reason=brownout`. Kaskada i ruch tylko różnic. |
| SG90 buczą, grzeją się i tracą kalibrację | Odłączanie PWM tylko dla punktów schowanych, uśpienie po bezczynności, pozycje krańcowe trochę przed ogranicznikiem, kalibracja w NVS |
| Dźwięk serw zdradza odpowiedź (liczba kliknięć ≈ liczba punktów) | Stały wzór `clear` → `show`, TTS albo szum w trakcie ruchu. Opisać i zmierzyć jako ograniczenie. |
| Web Serial działa tylko w Chrome/Edge na komputerze. Na Windows może być potrzebny sterownik CP210x/CH340. | Ustalony laptop na obronę. Sterownik w instrukcji. Etap 3 z Wi-Fi jako droga na telefony. |
| Głos TTS przez sieć milknie bez internetu | Lokalny głos „Paulina” i nagrane MP3 nazw liter |
| Błędy w tabeli polskiego brajla | JSON ze źródłem, test dla każdego znaku, konsultacja z tyflopedagogiem. Znak wielkiej litery i interpunkcja jako „do weryfikacji”. |
| Za szeroki zakres na jeden semestr | Stałe cięcie MVP (pkt 4). Tryby „Should” dopiero od tygodnia 8. |
| Mała próba badawcza, trudny dostęp do osób niewidomych | Kontakt z PZN lub ośrodkiem od tygodnia 3. Minimum: osoby widzące z zasłoniętymi oczami plus przegląd ekspercki. Ograniczenia opisane w pracy. |
| Build nie jest odtwarzalny (`*.ini` w `.gitignore`, brak pliku) | `!platformio.ini`, przypięte wersje, commit |

**Błędy merytoryczne znalezione przez sędziów (już uwzględnione wyżej)**

| Gdzie | Błąd | Poprawnie |
|---|---|---|
| wariant USB | ż = 1-2-3-4-5-6 | 1-2-3-4-6, maska 47 |
| wariant USB i BLE | znacznik `0xFF` jako „stan nieznany” | flaga `hold[]` dla każdego serwa (porównanie bitowe pomija punkty do wysunięcia) |
| wariant USB i Wi-Fi | `ok`/`done` zaraz po `setPWM` | odpowiedź po `SETTLE_MS` ≈ 120 ms |
| wariant USB | „aplikacja wykryje czytnik ekranu” | tylko ręczne ustawienie |
| wariant USB | „USB CDC” | denky32 ma mostek USB-UART (VCP) |
| wariant USB | `setSignals(false,false)` „zwalnia reset” | reset wywołują przejścia DTR/RTS. Rozwiązanie: czekać na `EVT boot` albo ponawiać `hello`. |
| wariant Wi-Fi | komenda `s` (status i heartbeat) | koliduje z komendą `<litera>`. Komendy muszą mieć co najmniej 2 znaki. |
| wariant Wi-Fi | „180 ms na komórkę” | 6 × 20 = 120 ms na komórkę, 600 ms na całe urządzenie |
| wariant Wi-Fi | nieblokujący ruch „konieczny dla Wi-Fi” | `delay()` = `vTaskDelay()`. Zasada brzmi: żadnego I2C w callbackach. |
| wszystkie | brak wzmianki o ghostingu klawiatury przy akordach 5–6 klawiszy | test na laptopie do obrony i wpisywanie numerów punktów jako plan zapasowy |

## 8. Wartość naukowa i inżynierska (plan ewaluacji)

1. **Architektura i protokół.** Podział: firmware wykonuje ruch, aplikacja odpowiada za znaczenie. Diagramy sekwencji, wersjonowanie `proto=1`, stop-and-wait, potwierdzenie po fizycznym ruchu, zgodność wstecz z narzędziem kalibracyjnym. Na obronie można pokazać na żywo dodanie znaku w JSON bez wgrywania firmware'u.
2. **Znaleziony i naprawiony błąd bezpieczeństwa parsera.** Serwo 0 dostawało PWM 90 po nieznanej komendzie. To gotowy materiał na podrozdział o walidacji wejścia.
3. **Pomiary techniczne:**
   - czas i liczba ruchów przy pełnym odświeżeniu kontra ruchu tylko różnic, na realnych sekwencjach słów (z pól `moved=` i `ms=`);
   - szczytowy prąd przy kaskadzie kontra ruchu jednoczesnym (bocznik i oscyloskop);
   - opóźnienie od komendy do stanu ustalonego (wideo 60–240 fps);
   - niezawodność: 1000 losowych wzorów, % błędnych punktów dla każdego serwa;
   - hałas;
   - ugięcie punktu pod naciskiem palca;
   - prąd spoczynkowy z odłączaniem PWM punktów schowanych i bez niego.
4. **Badanie pilotażowe:**
   - uczestnicy: 6–10 osób widzących z zasłoniętymi oczami plus 2–3 osoby niewidome albo przegląd ekspercki tyflopedagoga;
   - przebieg: pre-test na 10 znakach a–j, 3 sesje po 15–20 min, post-test, test odroczony po 7 dniach i **test przeniesienia na papierowy brajl** (uczciwie pokazuje ograniczenie powiększonej komórki);
   - metryki: poprawność, mediana czasu od `OK` do odpowiedzi, krzywa uczenia, liczba podpowiedzi, SUS;
   - analiza: test Wilcoxona przed i po, porównanie macierzy pomyłek z przewidywanymi parami (e/i, d/f, h/j…).
5. **Dydaktyka i koszt.** Kurs dekadowy pokazany animacją reguł, czego papier nie daje. Tryby wykorzystujące 5 komórek (Znajdź inny, Porównaj), których nie mają pomoce jednokomórkowe. Koszt urządzenia to ułamek ceny monitorów piezo.

Etyka: świadoma zgoda, pseudonimy w logach. Sprawdzić, czy uczelnia wymaga opinii komisji etycznej.

## 9. Otwarte decyzje (każda z domyślnym wyborem)

1. **Drugi transport (etap 3).** Domyślnie żaden, dopóki etapy 1–2 nie są gotowe. Potem Wi-Fi w trybie AP z WebSocketem, a nie BLE: daje telefony i iOS/VoiceOver przy tym samym kodzie JS i bez aplikacji do instalowania.
2. **Wejście sprzętowe.** Domyślnie `EVT key` jest zarezerwowane w protokole teraz. Jeśli w tygodniu 8 zostanie czas, dojdą 3 przyciski GPIO z `INPUT_PULLUP` (Dalej / Powtórz / Nie wiem). Klawiatura Perkinsa na urządzeniu to kierunek dalszego rozwoju.
3. **Kalibracja bez rekompilacji (`cal/save` w NVS).** Domyślnie tak, w tygodniu 8. Wcześniej wystarczy `dump` i eksport wierszy C++.
4. **Zakres znaków w MVP.** Domyślnie a–z, polskie diakrytyki, znak liczby i cyfry. Znak wielkiej litery i interpunkcja wchodzą dopiero po sprawdzeniu z normą PZN. Kolejność kursu: dekadowa. Algorytm powtórek: Leitner, nie SM-2 ani FSRS.

Pliki: przeanalizowałem `C:\Users\Admin\PycharmProjects\Braille-device\src\main.cpp` (bez zmian). `C:\Users\Admin\PycharmProjects\Braille-device\platformio.ini` nie istnieje w katalogu roboczym i trzeba go odtworzyć.