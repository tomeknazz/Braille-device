# Aplikacja do nauki alfabetu Braille'a na urządzeniu 5-komórkowym: treść dydaktyczna i UX

> Dokument opisuje, czego i w jakiej kolejności uczyć, jakie ćwiczenia robić i jak zbierać odpowiedzi. Nie zależy od transportu (USB serial, WiFi czy BLE). Zakłada tylko minimalny kontrakt z firmware, opisany w §9.
> Punkt wyjścia: `src/main.cpp` na `master`. Jest tam 30 serw (5 komórek × 6 punktów), tablica `braille_alphabet[26][6]` (A–Z, punkty 1–6) i komenda `<litera>`, która pokazuje tę samą literę na wszystkich komórkach.

---

## 0. Założenia i jak ustawić urządzenie w pracy

- **To nie jest monitor brajlowski, tylko elektroniczny „sześciopunkt".** Serwa SG90 mają ok. 23×12 mm, więc punkty są dużo dalej od siebie niż w standardowym piśmie (ok. 2,5 mm). Urządzenie jest więc powiększonym modelem komórki. W polskiej tyflopedagogice na pierwszym etapie nauki używa się właśnie takich pomocy (sześciopunkt, duże klocki brajlowskie). Nowością jest to, że model **sam się układa, ma 5 komórek i jest sterowany przez aplikację**. Tak warto to przedstawić w pracy. Trzeba też uczciwie opisać ograniczenie: urządzenie uczy rozpoznawania układów punktów, a nie płynnego czytania palcem. Przejście na zwykły brajl papierowy to osobny etap (§8).
- **Użytkownicy:** (a) osoby niewidome i słabowidzące, najczęściej dorośli, którzy stracili wzrok w późniejszym wieku; (b) osoby widzące, czyli nauczyciele, rodzice i opiekunowie. Dlatego **domyślnie aplikacja działa dźwiękiem**, a widok graficzny jest dodatkiem, który można wyłączyć (§6).
- **Umowa o bitach (wspólna dla całego projektu):** `mask` to 6 bitów, **bit k = punkt k+1** (bit0 = punkt 1 … bit5 = punkt 6). Jest to dokładnie:
  - kolejność wiersza w `braille_alphabet` i `dot_index` w firmware (`servo = cell*6 + k`);
  - przesunięcie w Unicode: znak = `U+2800 + mask`, np. `0x0D` → `⠍` (m).
  Tablica znaków (§1) może więc być zapisana w aplikacji jako znaki Unicode. Ten sam zapis służy do wysłania maski na urządzenie i do narysowania komórki na ekranie.
- ⚠ **Do sprawdzenia na sprzęcie:** czy fizyczny układ serw odpowiada układowi brajlowskiemu. Lewa kolumna od góry to punkty 1-2-3, prawa kolumna od góry to 4-5-6, patrząc od strony czytającego. Jeśli jakaś komórka jest zamontowana w lustrzanym odbiciu, poprawkę trzeba zrobić w firmware (mapowanie `dot_index → kanał`), a nie w aplikacji.

---

## 1. Polski alfabet Braille'a: tablica znaków

Numery punktów: lewa kolumna 1-2-3 (od góry), prawa kolumna 4-5-6. `hex` = maska według umowy z §0.

### 1.1 Litery łacińskie (zgodne z tablicą w `main.cpp`, sprawdzone programowo)

| Znak | Punkty | hex | | Znak | Punkty | hex | | Znak | Punkty | hex |
|---|---|---|---|---|---|---|---|---|---|---|
| a ⠁ | 1 | 01 | | k ⠅ | 13 | 05 | | u ⠥ | 136 | 25 |
| b ⠃ | 12 | 03 | | l ⠇ | 123 | 07 | | v ⠧ | 1236 | 27 |
| c ⠉ | 14 | 09 | | m ⠍ | 134 | 0D | | w ⠺ | 2456 | 3A |
| d ⠙ | 145 | 19 | | n ⠝ | 1345 | 1D | | x ⠭ | 1346 | 2D |
| e ⠑ | 15 | 11 | | o ⠕ | 135 | 15 | | y ⠽ | 13456 | 3D |
| f ⠋ | 124 | 0B | | p ⠏ | 1234 | 0F | | z ⠵ | 1356 | 35 |
| g ⠛ | 1245 | 1B | | q ⠟ | 12345 | 1F | | | | |
| h ⠓ | 125 | 13 | | r ⠗ | 1235 | 17 | | | | |
| i ⠊ | 24 | 0A | | s ⠎ | 234 | 0E | | | | |
| j ⠚ | 245 | 1A | | t ⠞ | 2345 | 1E | | | | |

Budowa systemu, którą wykorzystuje nauka:
- **a–j:** „pierwsza dekada", używa tylko górnych punktów 1, 2, 4, 5.
- **k–t:** to a–j z dodanym punktem 3.
- **u, v, x, y, z:** to a, b, c, d, e z dodanymi punktami 3 i 6.
- **w** jest wyjątkiem (2456, w oryginalnym systemie francuskim nie było tej litery).
- **q, v, x** są w polskim alfabecie obce, ale należą do standardu.

### 1.2 Polskie litery diakrytyczne

| Znak | Punkty | hex | Skojarzenie (do nauki) |
|---|---|---|---|
| ą ⠡ | 16 | 21 | **a + 6** |
| ć ⠩ | 146 | 29 | **c + 6** |
| ę ⠱ | 156 | 31 | **e + 6** |
| ł ⠣ | 126 | 23 | b + 6 (nie l!) |
| ń ⠹ | 1456 | 39 | d + 6 |
| ó ⠬ | 346 | 2C | brak prostego skojarzenia |
| ś ⠪ | 246 | 2A | i + 6 |
| ź ⠮ | 2346 | 2E | s + 6 |
| ż ⠯ | 12346 | 2F | p + 6 |

Pewność: wysoka. Są to standardowe przypisania polskiego brajla i wszystkie maski są różne (sprawdzone skryptem). **„Punkt 6 = ogonek/kreska"** to bardzo dobre skojarzenie dla ą, ć i ę. Przy ł, ń, ś, ź i ż aplikacja **nie powinna** sugerować, że bazą jest litera o tym samym dźwięku (np. ł ≠ l + 6).

### 1.3 Znaki specjalne, cyfry, interpunkcja

| Znak | Punkty | hex | Pewność |
|---|---|---|---|
| Znak liczby ⠼ | 3456 | 3C | wysoka |
| Cyfry 1–9, 0 | ⠼ + a…j (1=a, 2=b … 9=i, 0=j) | — | wysoka |
| Znak wielkiej litery ⠨ | 46 | 28 | ⚠ wysoka, ale sprawdzić: w konwencji polskiej/niemieckiej to 46, **nie** punkt 6 jak w angielskim brajlu. Podwójny ⠨⠨ oznacza słowo pisane wielkimi literami. |
| kropka . ⠄ | 3 | 04 | średnia, sprawdzić |
| przecinek , ⠂ | 2 | 02 | średnia, sprawdzić |
| średnik ; ⠆ | 23 | 06 | średnia, sprawdzić |
| dwukropek : ⠒ | 25 | 12 | średnia, sprawdzić |
| pytajnik ? ⠢ | 26 | 22 | średnia, sprawdzić |
| wykrzyknik ! ⠖ | 235 | 16 | średnia, sprawdzić |
| łącznik - ⠤ | 36 | 24 | średnia; ⚠ myślnik zapisuje się inaczej (spacje, możliwe podwojenie), sprawdzić |
| nawias okrągły ( ) ⠶ | 2356 (ten sam znak na otwarcie i zamknięcie) | 36 | ⚠ niska–średnia, w angielskim są inne znaki (126/345) |
| cudzysłów „ ⠦ / ” ⠴ | 236 / 356 | 26 / 34 | ⚠ niska–średnia |
| apostrof | pominąć w MVP | — | ⚠ w wielu tablicach to 3, czyli koliduje z kropką |

⚠ **Litera a–j tuż po cyfrze** (np. „5a") wymaga w polskim brajlu znaku rozdzielającego, prawdopodobnie ⠰ (56). Sprawdzić przed użyciem. W MVP można takich napisów po prostu nie generować.

**Zalecenie:** interpunkcję, znak wielkiej litery i reguły liczb sprawdzić w oficjalnym opracowaniu polskiej komisji brajlowskiej przy PZN (tablice polskiego systemu Braille'a) albo z tyflopedagogiem ze szkoły, z którą współpracujesz. W pracy dobrze jest napisać, że tablica znaków jest danymi (JSON), więc poprawka nie wymaga zmian w firmware.

### 1.4 Znaki łatwe do pomylenia (podstawa ćwiczeń kontrastowych)

| Rodzaj pomyłki | Pary / grupy |
|---|---|
| Lustro lewo↔prawo | **e/i** (15/24), **d/f** (145/124), **h/j** (125/245), **r/w** (1235/2456), n/t, o/s |
| Ta sama rodzina, różnica 1 punktu | d/g/h/f/j; n/q/r/p/t; a/b/k/l; c/d/m/n |
| Różnica tylko punktu 3 lub 6 | a/k/u/ą, b/l/ł, c/m/ć/x, e/o/ę, i/s/ś |
| Znak zawiera się w innym | ⠨ (46) ⊂ ś (246) ⊂ ź (2346) ⊂ ż (12346); ⠼ (3456) ~ y (13456) |
| Ta sama litera, inny ciąg ruchów | każda para, gdzie jeden znak jest podzbiorem drugiego (patrz §4.3) |

W aplikacji jest to lista `confusion_groups` w JSON. Dopisują się do niej automatycznie pary z macierzy pomyłek ucznia (§5).

---

## 2. Kolejność nauki

### 2.1 Zalecenie: kolejność dekadowa w paczkach po 5 liter (= 5 komórek)

Uzasadnienie:
1. **Wynika z budowy systemu.** Kto zna a–j, poznaje k–t jako „te same + punkt 3". Uczymy więc 10 kształtów i 2 reguły zamiast 35 osobnych znaków.
2. **Na urządzeniu widać to dosłownie.** Na 5 komórkach pokazujemy `a b c d e`, a potem kaskadą wysuwamy punkt 3 na wszystkich komórkach i uczeń czuje, jak powstaje `k l m n o`. Takiej animacji papier nie da, a na obronie dobrze się prezentuje.
3. **Paczka = 5 liter = jeden rząd urządzenia.** Każdą lekcję można w całości położyć pod palcami.
4. Jest zgodna z tradycyjnymi elementarzami, więc łatwo ją powiązać z tym, czego uczy szkoła ucznia.

| Lekcja | Nowe znaki | Uwaga dydaktyczna |
|---|---|---|
| L0 | Orientacja: punkty 1–6 pojedynczo, pusta komórka, pełna ⠿ | „Który punkt jest wysunięty?" Uczy numeracji, bez której reszta nie działa |
| L1 | a b c d e | Tylko górne 4 punkty |
| L2 | f g h i j | Wprowadzamy pary lustrzane d/f, e/i, h/j **jawnie**, jako pary kontrastowe |
| L3 | k l m n o | Reguła „+3": animacja a→k na wszystkich komórkach |
| L4 | p q r s t | q oznaczone jako „obca" |
| L5 | u v x y z | Reguła „+3 i 6" (a b c d e → u v x y z) |
| L6 | w, ą, ć, ę, ł | w jako wyjątek; ą/ć/ę jako „punkt 6 = ogonek" |
| L7 | ń, ó, ś, ź, ż | Bez skojarzeń fonetycznych, osobne powtórki |
| L8 | ⠼ + cyfry, ⠨, kropka, przecinek, pytajnik | Znak liczby i znak wielkiej litery zajmują komórkę (§4.6) |

Warunek odblokowania następnej lekcji (konfigurowalny): **co najmniej 80% poprawnych** w ostatnich 20 próbach z bieżącej lekcji **i** mediana czasu rozpoznania poniżej progu (np. 6 s, ustawiany w profilu).

### 2.2 Alternatywa: najpierw kształty najłatwiejsze dotykowo, rzadziej mylone

Chodzi o kolejność według łatwości dotykowej: mało punktów, charakterystyczne kształty, pary lustrzane rozdzielone w czasie, częste polskie litery wcześnie, żeby szybko składać słowa. Przykład: `a b l k o` → `e m t d r` → `i s n p z` → …

**Dlaczego nie domyślnie:** gubi regułę dekad, która jest głównym atutem 5-komórkowego urządzenia. Trudniej też ją powiązać z elementarzem. **Kolejność jest jednak danymi** (`curriculum.json`), więc tyflopedagog może ją zmienić. W pracy można wspomnieć porównanie obu kolejności jako możliwy dalszy rozwój.

---

## 3. Materiał słowny (maks. 5 znaków)

**Ograniczenia generatora słów:**
1. Liczba **komórek**, a nie liter, wynosi najwyżej 5. ⠨ i ⠼ też zajmują komórkę.
2. Słowo może zawierać **tylko litery już poznane** (odblokowane w profilu).
3. Źródło: lista frekwencyjna polszczyzny, odfiltrowana skryptem. ⚠ Sprawdzić licencję listy, np. słowniki frekwencyjne lub listy z korpusów. Można też zacząć od ręcznie przygotowanej listy 100–200 słów, co na pracę inżynierską w zupełności wystarczy.
4. Filtr słów niecenzuralnych i drażliwych (lista odrzuconych).

Przykładowe słowa na kolejnych etapach (każde sprawdzone pod kątem liter i długości):

| Po lekcji | Przykładowe słowa |
|---|---|
| L2 (a–j) | baba, dach, gad, jad, hej, ich, figa, idea, chce, biega |
| L4 (a–t) | dom, kot, mama, lato, okno, pies, rok, sok, nos, park, list |
| L5/L6 (+u–z, w) | dym, zupa, ryby, kawa, woda, zima, wujek |
| L7 (+diakrytyki) | ząb, żaba, ręka, mąka, ćma, źle, koń, gęś, sól, stół, łódka, łóżko, łyżka |
| L8 | ⠨ala (4 komórki), ⠼⠁⠃ = 12, ⠼⠃⠚⠃⠋ = 2026 (5 komórek) |

Dłuższy tekst dzielimy na **strony po 5 komórek** z granicą na spacji. Słowo dłuższe niż 5 znaków dzielimy tak, żeby na końcu strony została pusta komórka jako sygnał „ciąg dalszy". Przejście do następnej strony: klawisz albo przycisk (§4.8).

---

## 4. Tryby nauki i ćwiczenia (wykorzystanie 5 komórek)

Oznaczenia: `[_]` to pusta komórka, T to prompt TTS.

### 4.1 Poznaj znak (prezentacja)
- Znak na **środkowej komórce (2)**, pozostałe puste. Łatwo ją znaleźć, bo jest otoczona pustymi.
- T: „To jest **em**. Punkty jeden, trzy, cztery."
- Warianty:
  - **Ten sam znak na wszystkich 5 komórkach** (utrwalanie; istniejąca komenda `<litera>`).
  - **Budowanie punkt po punkcie:** firmware wysuwa punkty wolno (400–800 ms), zgodnie z TTS („punkt jeden… punkt trzy… punkt cztery"). Potrzebny jest parametr opóźnienia kaskady albo kolejne maski z potwierdzeniem (§9).

### 4.2 Rząd rodziny / reguła
- `a b c d e`, potem na wszystkich komórkach wysuwa się punkt 3 → `k l m n o`, potem dodatkowo punkt 6 → `u v x y z`.
- T objaśnia regułę. Uczeń może przełączać strzałkami „przed" i „po".

### 4.3 Para kontrastowa
- `e [_] i [_] [_]`: puste komórki oddzielają znaki, żeby palec nie „przeskoczył".
- T: „Po lewej e, po prawej i. Czym się różnią?" Potem quiz: „Który to i: pierwszy czy trzeci?"
- Pary pochodzą z §1.4 i z macierzy pomyłek ucznia (§5).

### 4.4 Rozpoznawanie (podstawowy quiz)
- Jeden znak na komórce 2 (albo na losowej komórce, co dodatkowo ćwiczy szukanie).
- T: „Jaka to litera?" Uczeń odpowiada (§4.9, §5).
- Czas rozpoznania = moment odpowiedzi − moment potwierdzenia `ok` z firmware (nie moment wysłania komendy).

### 4.5 Znajdź inny (odd-one-out)
- 4 takie same znaki i 1 różny, zwykle z pary łatwej do pomylenia: `e e i e e`.
- Odpowiedź to **numer komórki 1–5**. Klawisze 1–5 na klawiaturze, a w wersji sprzętowej 5 przycisków pod komórkami.
- Ćwiczenie z czystą dyskryminacją dotykową, bez nazywania liter. Nadaje się dla początkujących i wykorzystuje wszystkie 5 komórek.
- Wariant „znajdź literę": T mówi „Gdzie jest m?", a na komórkach jest `k l m n o` w losowej kolejności.

### 4.6 Słowa i liczby
- Słowo do 5 komórek (§3). T: „Przeczytaj słowo". Uczeń wpisuje całe słowo.
- Wynik liczony **per znak** do statystyk: błędna litera w słowie trafia do macierzy pomyłek.
- Liczby: ⠼ zajmuje komórkę, więc mieszczą się najwyżej 4 cyfry. Znak wielkiej litery ⠨ też zajmuje komórkę, więc słowo pisane wielką literą ma najwyżej 4 litery.

### 4.7 Dyktando i pisanie (odwrotny kierunek)
- T mówi literę (albo słowo), a uczeń **układa punkty** klawiszami w stylu brajlowskiej maszyny Perkinsa:

| Klawisz | F | D | S | J | K | L |
|---|---|---|---|---|---|---|
| Punkt | 1 | 2 | 3 | 4 | 5 | 6 |

  Klawisze wciskamy razem, a Spacja zatwierdza. To standard w oprogramowaniu brajlowskim i zapisie brajla w NVDA.
- **Urządzenie od razu pokazuje to, co uczeń ułożył.** Uczeń czuje własny wynik, potem aplikacja pokazuje poprawny wzór obok: `[ułożony] [_] [poprawny]`.
- Zalety: działa niezależnie od układu klawiatury (polskie znaki bez AltGr), łączy czytanie z pisaniem i przygotowuje do maszyny Perkinsa.

### 4.8 Czytanie stron i gry (opcjonalnie)
- Krótkie zdania stronicowane po 5 komórek.
- „Wisielec" dotykowy: słowo odsłaniane litera po literze.
- „Wyścig" na czas, tylko dla chętnych. U dorosłych nie przesadzać z grywalizacją.

### 4.9 Higiena prób (ważne dla poprawności pomiaru)

1. **Każda nowa próba to: wyczyść → ok. 300 ms przerwy → pokaż.** To celowy wyjątek od zasady „ruszaj tylko zmienionymi punktami". Bez tego litera, która dzieli punkty z poprzednią, prawie nic nie poruszy i uczeń nie wie, że pojawiła się nowa próba. Wewnątrz jednego ćwiczenia (np. animacja z §4.2) ruszamy tylko zmienionymi punktami.
2. **Sygnał gotowości.** Krótki dźwięk (earcon) po potwierdzeniu `ok` z firmware. Wcześniej prosimy: „zdejmij palce", bo palce na ruszających się pinach przeszkadzają, a nacisk zakłóca serwo.
3. **⚠ Dźwięk serw zdradza odpowiedź.** Liczba kliknięć serw w kaskadzie ≈ liczba wysuwanych punktów, a uczeń niewidomy z dobrym słuchem to wyłapie. Sposoby zaradcze:
   - stała sekwencja „wyczyść, potem pokaż" (ujawnia najwyżej liczbę punktów);
   - odtwarzanie promptu TTS albo cichego szumu w trakcie ruchu;
   - opcjonalnie „ruchy pozorne" (np. każdy punkt drgnie).
   
   W pracy warto opisać to jako znane ograniczenie i ewentualnie zmierzyć.
4. Opcja w profilu: tempo kaskady (np. 20 / 60 / 150 ms), bo szybsze nie zawsze jest lepsze do nauki.

---

## 5. Odpowiedzi i informacja zwrotna (urządzenie nie ma wejścia)

### 5.1 Sposoby odpowiadania (priorytet w MVP)
| Kanał | Rola | Uwagi |
|---|---|---|
| **Klawiatura: litera** | Podstawowy | Naturalny dla niewidomych. Polskie znaki przez AltGr (można przyjmować też np. „a," jako ą). Pole odpowiedzi to zwykły `<input>`, więc NVDA działa w trybie formularza i nie przejmuje klawiszy. |
| **Klawiatura: 6 klawiszy (FDS JKL)** | Tryb pisania, alternatywa przy polskich znakach | §4.7 |
| **Klawisze 1–5** | Odpowiedzi „która komórka" | §4.3, §4.5 |
| Dotyk / lista wyboru na ekranie | Tylko tryb dla widzących / dziecięcy | 4 opcje, z których 1 jest z tej samej grupy łatwo mylonych znaków. Bez podglądu wzoru. |
| Głos (rozpoznawanie mowy) | Opcjonalnie, eksperymentalnie | Rozpoznawanie pojedynczych liter po polsku jest zawodne („be/de/pe", „u/ó", „ż/rz"). Przyjmować nazwy liter i słowa, a przy wątpliwości dopytać. Nie opierać na tym ewaluacji. |

### 5.2 Rozszerzenie sprzętowe (propozycja, mały koszt)
- **Wariant A:** 5 przycisków (po jednym pod komórką) + „Dalej"/„Powtórz". Obsługuje znajdź inny i nawigację po stronach, a urządzenie może działać bez komputera w prostych trybach.
- **Wariant B (dydaktycznie najmocniejszy):** klawiatura 6+2 (punkty 1–6, spacja, enter) jak w maszynie Perkinsa na GPIO ESP32. Uczeń pisze na urządzeniu i czuje wynik na komórkach.
- **Wariant C (prawie za darmo):** pola dotykowe przy komórkach. ESP32 ma wbudowane pojemnościowe wejścia dotykowe (m.in. GPIO 4, 13, 14, 15, 27, 32, 33; nie kolidują z I2C na 21/22). Do każdej komórki wystarczy pad z folii miedzianej. Daje **czas od gotowości do dotknięcia** i od dotknięcia do odpowiedzi, czyli rozdziela czas szukania od czasu rozpoznania. To dobra metryka do pracy.

Zdarzenia z urządzenia wracają do aplikacji jako osobne linie (§9).

### 5.3 Pętla informacji zwrotnej i drabina podpowiedzi
- **Dobrze:** krótki earcon + „Dobrze, em." Przy znakach jeszcze niepewnych można dodać „punkty 1, 3, 4". Automatycznie następna próba (tempo w profilu).
- **Źle, 1. raz:** earcon „nie" + „Spróbuj jeszcze raz." **Znak zostaje na urządzeniu**, uczeń może macać dalej.
- **Podpowiedzi** (klawisz H albo automatycznie po drugim błędzie). Każda obniża wynik próby:
  1. **Mrugnięcie dotykowe:** znak chowa się i wysuwa ponownie.
  2. **Liczba punktów:** „Ta litera ma 3 punkty."
  3. **Które punkty:** „Punkty 1, 3, 4." Na tym etapie ćwiczenie staje się ćwiczeniem nazywania.
  4. **Odpowiedź + budowanie punkt po punkcie.** Znak zostaje, dopóki uczeń nie naciśnie „Dalej", żeby dotyk i słowo zdążyły się skojarzyć.
- Po pomyłce X→Y (np. pokazano e, uczeń odpowiedział i) aplikacja od razu pokazuje kontrast `e [_] i` z objaśnieniem, a parę zapisuje do macierzy pomyłek.

---

## 6. Powtórki rozłożone w czasie, adaptacja, profile

### 6.1 Pudełka Leitnera (proste i łatwe do opisania w pracy)
- **Element** = (znak, rodzaj umiejętności). Umiejętności: `recognize` (urządzenie → nazwa), `write` (nazwa → punkty), `discriminate` (znajdź inny / para kontrastowa). Każda para ma osobny stan.
- 5 pudełek. Odstępy: pudełko 1 w każdej sesji, 2 co 2 sesje, 3 co 4, 4 co 8, 5 = opanowane (kontrola rzadko). Można liczyć w dniach, jeśli użytkownik ćwiczy regularnie.
- **Awans:** odpowiedź poprawna **bez podpowiedzi** i szybka (czas poniżej progu, np. 1,5× mediana ucznia albo 6 s).
  - Poprawna, ale wolna albo z podpowiedzią: element zostaje w tym samym pudełku.
  - Błędna: wraca do pudełka 1.
- **Skład sesji** (np. 15 min): ok. 60% zaległych powtórek, 30% bieżąca lekcja, 10% nowe znaki (tylko przy spełnionym warunku z §2.1). Ćwiczenia kontrastowe dobierane z górnej części macierzy pomyłek.
- Świadomie **bez SM-2/FSRS**: za dużo parametrów jak na jeden semestr. Leitner jest przejrzysty i łatwo go uzasadnić.

### 6.2 Macierz pomyłek i adaptacja
- `M[pokazany][odpowiedziany]` per profil. Pary z największą liczbą pomyłek trafiają do `discriminate` z podwyższonym priorytetem.
- Automatyczne ustawienia per profil: tempo kaskady, liczba podpowiedzi przed ujawnieniem odpowiedzi, próg czasu.

### 6.3 Profile i dane
- Profil: nazwa lub pseudonim, tryb (niewidomy / słabowidzący / widzący / nauczyciel), TTS (głos, tempo), tempo kaskady, **aktywne komórki** (jeśli jedno serwo nawali, aplikacja omija tę komórkę; ważne przy demo na obronie), stan Leitnera, macierz pomyłek.
- Dane lokalnie (plik JSON / SQLite / IndexedDB, zależnie od platformy).
- **Log prób do CSV** (potrzebny do ewaluacji):

```
timestamp,profile_id,session_id,mode,skill,item,cells_mask_hex,answer,correct,hints_used,rt_ready_to_answer_ms,rt_touch_to_answer_ms,attempt_no
```

- Statystyki dla ucznia (podawane głosem): „Dziś 42 próby, 88% poprawnych, najczęściej mylisz e z i."
- Statystyki dla nauczyciela (na ekranie): krzywa poprawności per lekcja, mapa ciepła macierzy pomyłek, znaki per pudełko.

---

## 7. UX nastawiony na dźwięk i widok dla widzących

### 7.1 Dla niewidomych (tryb domyślny)
- **TTS pl-PL.** Web Speech API: na Windows głos „Paulina" pl-PL, na Androidzie Google TTS pl. Syntezatory źle czytają pojedyncze litery („ą", „ż", „b"). Dlatego:
  - aplikacja ma **słownik nazw liter**: a, be, ce, de, e, ef, gie, ha, i, jot, ka, el, em, en, o, pe, ku, er, es, te, u, fał, wu, iks, igrek, zet;
  - polskie litery: „a z ogonkiem", „ce z kreską", „e z ogonkiem", „eł", „en z kreską", „o z kreską", „es z kreską", „zet z kreską", „zet z kropką";
  - odróżnianie pisowni: „u otwarte / o z kreską", „żet / er-zet", „ha / ce-ha";
  - najlepiej **nagrać 35 nazw liter i kilka komunikatów**, bo są pewniejsze od TTS. TTS zostaje do słów i zdań.
- **Czytnik ekranu: punkt odniesienia to NVDA** (darmowy, najpopularniejszy w Polsce), dodatkowo sprawdzić JAWS lub Narratora.
  - Semantyczny HTML, prompty w regionie `aria-live="polite"`, wynik w `aria-live="assertive"`.
  - **Przełącznik „własny głos aplikacji / czytnik ekranu"** przy pierwszym uruchomieniu, podany głosem. Inaczej komunikaty będą czytane podwójnie. Przeglądarka nie wykrywa czytnika ekranu wiarygodnie, więc musi to być jawna opcja.
- **Obsługa tylko z klawiatury.** Obszar ćwiczenia to pole tekstowe z fokusem (tryb formularza NVDA). Polecenia na klawiszach, które nie kolidują z odpowiedziami:

| Klawisz | Działanie |
|---|---|
| Enter | zatwierdź |
| F1 / Ctrl+R | powtórz polecenie |
| F2 / Ctrl+H | podpowiedź |
| F3 / Ctrl+B | mrugnij znakiem |
| Esc | menu |

  Litery i cyfry są zarezerwowane na odpowiedzi.
- **Earcony:** gotowe / dobrze / źle / koniec sesji. Informacja nigdy nie jest przekazywana tylko kolorem.
- **Słabowidzący:** wysoki kontrast, duża czcionka, możliwość powiększenia do 200% bez przewijania w poziomie, tryb ciemny.

### 7.2 Dla widzących i nauczycieli
- **Podgląd urządzenia:** 5 komórek × 6 punktów w SVG, z numerami punktów. Stan zawsze odpowiada temu, co potwierdziło urządzenie.
- **„Tryb z zasłoniętymi oczami":** podgląd ukryty w trakcie próby i pokazywany po odpowiedzi, żeby widzący nie odczytywał odpowiedzi z ekranu.
- **Panel nauczyciela:** wybór profilu, ręczne ułożenie dowolnego wzoru (klikanie punktów, co przy okazji testuje kalibrację), podgląd postępów, eksport CSV.
- **Tryb prezentacji na obronę:** duży podgląd na projektorze zsynchronizowany z urządzeniem.

---

## 8. Plan ewaluacji (do pracy inżynierskiej)

### 8.1 Pytania badawcze
1. **Techniczne:** czy urządzenie wyświetla wzory niezawodnie i wystarczająco szybko?
2. **Dydaktyczne:** czy po krótkim treningu z aplikacją rośnie poprawność i szybkość rozpoznawania liter?
3. **Użyteczność:** czy osoby niewidome i widzące mogą samodzielnie obsługiwać aplikację?

### 8.2 Testy techniczne (sprzęt, w pełni w zasięgu pracy inżynierskiej)
- **Niezawodność:** 1000 losowych wzorów × 5 komórek. Sprawdzanie zdjęciem z kamery z prostym progowaniem albo ręcznie na próbce. Metryka: % punktów w złej pozycji, per serwo. Wyniki porównać z tablicą kalibracji.
- **Opóźnienie:** komenda → `ok` oraz komenda → stan ustalony (nagranie wideo 60–240 fps). Dla 1 komórki, 5 komórek i animacji.
- **Pobór prądu:** szczytowy prąd przy kaskadzie (20 ms) i przy ruchu wszystkich serw naraz. Uzasadnia decyzję z firmware.
- **Hałas:** poziom dźwięku przy ruchu. Wiąże się z kwestią zdradzania odpowiedzi (§4.9).
- **Odporność na nacisk:** czy punkt wysunięty ugina się pod typowym naciskiem palca.

### 8.3 Pilotażowe badanie z użytkownikami
- **Uczestnicy:** 6–10 osób widzących z zasłoniętymi oczami (łatwo ich zebrać wśród studentów, nie znają brajla) + **2–3 osoby niewidome lub słabowidzące** albo przegląd ekspercki tyflopedagoga (np. ośrodek szkolno-wychowawczy dla niewidomych, koło PZN). Preferować **dorosłych**, bo przy nieletnich zgody i procedury są trudniejsze.
- **Etyka i RODO:** świadoma zgoda, pseudonimy w logach, możliwość rezygnacji. Sprawdzić, czy uczelnia wymaga opinii komisji etycznej, nawet przy małym pilotażu.
- **Przebieg:**
  1. Pre-test: rozpoznawanie 10 znaków a–j na urządzeniu, kolejność losowa, bez podpowiedzi.
  2. 3 sesje × 15–20 min w ciągu tygodnia (L0–L2, Leitner).
  3. Post-test: ten sam format, inna kolejność.
  4. Test odroczony po ok. 7 dniach (utrwalenie).
  5. **Test przeniesienia:** te same litery na **zwykłej kartce brajlowskiej** (drukarka brajlowska albo wypukłe naklejki). Uczciwie pokazuje ograniczenie powiększonej komórki.
- **Porównanie (opcjonalnie, jeśli starczy czasu):** połowa liter ćwiczona na urządzeniu, połowa na kartach papierowych, z przeplotem liter i kolejności. Porównanie w obrębie tych samych osób daje sensowny wynik nawet przy małej liczbie uczestników.
- **Metryki:**
  - poprawność per litera i średnia;
  - **czas rozpoznania** (mediana, od `ok`/gotowości do odpowiedzi; z padami dotykowymi rozbity na szukanie i rozpoznanie);
  - krzywa uczenia (poprawność w blokach po 10 prób);
  - macierz pomyłek (czy zgadza się z przewidywanymi parami z §1.4?);
  - liczba podpowiedzi;
  - **SUS** (System Usability Scale, polska wersja);
  - krótki wywiad jakościowy.
- **Analiza:** statystyki opisowe + test Wilcoxona dla par (pre vs post). Wykresy: krzywa uczenia, mapa ciepła pomyłek. Wszystko wprost z CSV z §6.3.
- **Ograniczenia do opisania:** mała próba; osoby widzące z zasłoniętymi oczami zastępują docelowych użytkowników; powiększona komórka ≠ standardowy brajl; możliwe podpowiedzi słuchowe od serw.

---

## 9. Czego ten projekt wymaga od firmware

Treść i UX z tego dokumentu zakładają następujące możliwości firmware:

1. **Wzór per komórka jako maska:** jedna linia ustawia 1–5 komórek maskami 6-bitowymi w hex, np. `show 01 03 09 00 00`. Tablica znaków żyje w aplikacji (§1), więc polskie znaki, cyfry i interpunkcja nie wymagają zmian firmware. Komenda `<litera>` zostaje do kalibracji.
2. **Potwierdzenie po ustaleniu pozycji:** `ok` (albo `ok <id>`) dopiero po kaskadzie i krótkim czasie na ustalenie. Aplikacja nie wysyła następnej komendy przed potwierdzeniem, a czas rozpoznania liczy się od `ok`.
3. **Ruch tylko zmienionych punktów** wewnątrz ćwiczenia, oraz jawne `clear` do rozpoczęcia nowej próby (§4.9).
4. **Opóźnienie kaskady per komenda** (np. `show@400 …`) do animacji punkt po punkcie. Alternatywa: aplikacja wysyła kolejne maski i czeka na `ok`.
5. **Opcjonalnie zdarzenia wejścia:** `btn <n>`, `touch <cell>`, `chord <mask>`, jeśli powstanie rozszerzenie sprzętowe z §5.2.
6. **Kolizja z obecnym parserem:**
   - W `loop()` każde `<coś>,<coś>`, którego nie rozpozna wcześniejsza gałąź, trafia do `target.toInt()`. `String::toInt()` zwraca 0 dla tekstu nienumerycznego, więc np. `p,1,3,9,0,0` albo `cells,…` ustawi **serwo 0 na surowy PWM** (wartość przycięta do `PWM_MIN`).
   - Poprawka po stronie firmware: nowe komendy sprawdzać przed gałęzią numeryczną, a `target` przed `toInt()` sprawdzać, czy to same cyfry.
   - Na nowe komendy nie używać pojedynczej litery (koliduje z `<litera>`); lepiej słowo, np. `show`.

---

## 10. Zakres na jeden semestr (MoSCoW)

| Priorytet | Zakres |
|---|---|
| **Must** | Polecenie `show` + `ok` w firmware; tablica z §1 w JSON; kolejność dekadowa L0–L5; tryby: poznaj znak, rozpoznawanie, słowa ≤5; odpowiedź z klawiatury; TTS z nagranymi nazwami liter; Leitner; log CSV; podgląd SVG dla widzących |
| **Should** | Znajdź inny, pary kontrastowe, macierz pomyłek, budowanie punkt po punkcie, pisanie klawiszami FDS JKL, L6–L8 (polskie znaki, liczby, ⠨), profile, przełącznik własny głos / czytnik ekranu |
| **Could** | Pady dotykowe ESP32 (czas szukania vs rozpoznania), 5 przycisków / klawiatura Perkinsa, rozpoznawanie mowy, gry, stronicowanie dłuższych tekstów |
| **Won't (teraz)** | Skróty brajlowskie (brajl ortograficzny zwarty), notacja matematyczna, aplikacja mobilna z synchronizacją w chmurze |

**Scenariusz demo na obronę (ok. 5 min):**
1. Rząd `a b c d e` → animacja „+ punkt 3" → `k l m n o` na projektorze i urządzeniu.
2. Znajdź inny `e e i e e` z odpowiedzią klawiszem 1–5.
3. Słowo `żaba` z polskimi znakami.
4. Pisanie FDS JKL i porównanie `[ułożony] [_] [wzór]`.
5. Wykresy z pilotażu (krzywa uczenia, macierz pomyłek, SUS).