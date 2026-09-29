# BrailleLab — aplikacja (Etap 1: USB serial)

Vite + TypeScript (strict), bez frameworka UI. Łączy się z ESP32 przez Web Serial
(Chrome/Edge, https lub localhost) albo z wbudowanym symulatorem firmware'u.

```
npm install
npm run dev        # http://localhost:5173
npm run typecheck
npm test           # Vitest: tabela, translator, protokół, DeviceLink + MockDevice, UI (happy-dom)
npm run build      # dist/ (ścieżki względne, działa z GitHub Pages)
```

| Plik | Rola |
|---|---|
| `src/braille/pl-braille.json` | Tabela polskiego brajla: kropki + maska (`mask = Σ 2^(punkt−1)`), pole `verified` |
| `src/braille/translator.ts` | NFC, małe litery, znak liczby, opcjonalny znak wielkiej litery, nieznane znaki, `paginate(cells, 5)` |
| `src/device/protocol.ts` | Dzielenie linii, `OK`/`ERR`/`EVT`/info, parsery odpowiedzi, budowanie komend (docs/PROTOCOL.md §4) |
| `src/device/DeviceLink.ts` | Bramka `hello`, stop-and-wait, zastępowanie `show`, timeout → `get`, `ping` co 60 s |
| `src/device/WebSerialDevice.ts` | Transport USB (115200, `TextDecoderStream`, auto-połączenie przez `getPorts()`) |
| `src/device/MockDevice.ts` | Symulator tego samego protokołu (te same odpowiedzi, `moved=` z różnic, czasy kaskady) |
| `src/modes/` | Tryby ćwiczeń (`Mode`): Kurs, Poznaj znak, Rozpoznawanie (zapisuje próby i odblokowuje lekcje), Słowa, Wyświetl tekst |
| `src/ui/` | Panel połączenia, podgląd SVG 5×6 (stan potwierdzony), dziennik protokołu |

Aplikacja nie wysyła żadnej komendy ruchu, dopóki urządzenie nie odpowie `OK hello … proto=1`,
więc stary firmware (bez protokołu v1) jest bezpieczny: nic się nie rusza, a status mówi, że trzeba wgrać firmware 0.4.
