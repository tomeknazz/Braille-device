# Braille device — BrailleLab

Urządzenie do nauki alfabetu Braille'a: ESP32 steruje 30 serwami (5 komórek × 6 punktów),
a aplikacja w przeglądarce (`app/`) prowadzi naukę i łączy się z urządzeniem przez USB.

## Uruchomienie na nowym komputerze

Potrzebne: [Git](https://git-scm.com/), [Node.js 24](https://nodejs.org/) oraz Chrome albo Edge
na komputerze stacjonarnym lub laptopie (Web Serial nie działa w Firefoksie, Safari ani na telefonie).

```
git clone https://github.com/tomeknazz/Braille-device.git
cd Braille-device/app
npm install
npm run dev
```

Otwórz w Chrome adres wypisany przez `npm run dev` (zwykle http://localhost:5173).

> **Windows / PowerShell:** jeśli `npm` zgłasza „running scripts is disabled on this system”,
> wpisuj `npm.cmd install` i `npm.cmd run dev` (albo użyj `cmd` lub Git Bash).

### Z urządzeniem

1. Podłącz ESP32 kablem USB i włącz zasilanie serw (osobne 5 V).
2. W aplikacji naciśnij **Połącz z urządzeniem (USB)** i wybierz port ESP32. Otwarcie portu resetuje
   ESP32, więc połączenie trwa kilka sekund.
3. Jeśli port nie pojawia się na liście, zainstaluj sterownik mostka USB-UART (CP210x lub CH340).

### Bez urządzenia

Przycisk **Tryb symulacji** uruchamia wbudowany symulator urządzenia, który odpowiada tak samo
jak firmware. Wszystkie ćwiczenia działają, a stan punktów widać na podglądzie na stronie.
Tryb symulacji działa w każdej przeglądarce, więc wystarczy też do sprawdzania dostępności strony.

## Wgrywanie firmware

Firmware (`src/main.cpp`) buduje się w [PlatformIO](https://platformio.org/)
(rozszerzenie do VS Code albo `pip install --user platformio`):

```
pio run -t upload
pio device monitor -b 115200
```

Po starcie urządzenie wypisuje `EVT boot fw=… proto=1`. Komenda `help` pokazuje listę komend.

## Dokumentacja

- `docs/PROPOZYCJA.md` — architektura, tryby nauki, plan prac i ewaluacji
- `docs/PROTOCOL.md` — protokół komunikacji aplikacja ↔ urządzenie
- `docs/DYDAKTYKA.md` — kolejność nauki, ćwiczenia, dostępność
- `app/README.md` — budowa aplikacji
