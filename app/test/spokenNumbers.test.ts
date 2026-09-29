import { describe, expect, it } from 'vitest';
import { numberWords, speechText } from '../src/audio/spokenNumbers';

describe('numberWords', () => {
  it('nominative', () => {
    expect([0, 1, 4, 6, 10, 12, 20, 21, 45, 100, 115, 999].map((n) => numberWords(n))).toEqual([
      'zero',
      'jeden',
      'cztery',
      'sześć',
      'dziesięć',
      'dwanaście',
      'dwadzieścia',
      'dwadzieścia jeden',
      'czterdzieści pięć',
      'sto',
      'sto piętnaście',
      'dziewięćset dziewięćdziesiąt dziewięć',
    ]);
  });

  it('genitive', () => {
    expect([1, 2, 5, 10, 14, 20, 23, 200, 500].map((n) => numberWords(n, 'gen'))).toEqual([
      'jednego',
      'dwóch',
      'pięciu',
      'dziesięciu',
      'czternastu',
      'dwudziestu',
      'dwudziestu trzech',
      'dwustu',
      'pięciuset',
    ]);
  });

  it('leaves numbers it cannot say as digits', () => {
    expect(numberWords(1000)).toBe('1000');
    expect(numberWords(-1)).toBe('-1');
    expect(numberWords(1.5)).toBe('1.5');
  });
});

describe('speechText', () => {
  it('the contrast message: cells and dots by name, no ordinal before the full stop', () => {
    expect(
      speechText(
        'Dobrze, to litera e. Na komórce 1 litera e, na komórce 3 litera de — Twoja wcześniejsza odpowiedź. ' +
          'Różnią się punktem 4: tylko litera de ma punkt 4. Gdy skończysz, zdejmij palce i naciśnij Enter albo Dalej.',
      ),
    ).toBe(
      'Dobrze, to litera e. Na komórce jeden litera e, na komórce trzy litera de — Twoja wcześniejsza odpowiedź. ' +
        'Różnią się punktem cztery: tylko litera de ma punkt cztery. Gdy skończysz, zdejmij palce i naciśnij Enter albo Dalej.',
    );
  });

  it('lists of dots and cells, in every inflection', () => {
    expect(speechText('To jest em. Punkty 1, 3, 4.')).toBe('To jest em. Punkty jeden, trzy, cztery.');
    expect(speechText('Różnią się punktami 3 i 6: tylko litera en ma punkty 3 i 6.')).toBe(
      'Różnią się punktami trzy i sześć: tylko litera en ma punkty trzy i sześć.',
    );
    expect(speechText('Ka to a z dodanym punktem 3.')).toBe('Ka to a z dodanym punktem trzy.');
    expect(speechText('Pokazuję porównanie na komórkach 1 i 3.')).toBe('Pokazuję porównanie na komórkach jeden i trzy.');
    expect(speechText('Jaki to znak? Dotknij komórki 2 i wpisz odpowiedź.')).toBe(
      'Jaki to znak? Dotknij komórki dwa i wpisz odpowiedź.',
    );
    expect(speechText('punkt 5')).toBe('punkt pięć');
    expect(speechText('Znak wielkiej litery (punkty 4-6).')).toBe('Znak wielkiej litery (punkty cztery-sześć).');
  });

  it('boxes, hints and lesson ids', () => {
    expect(speechText('Do wyższego pudełka przeszło: 2, do pudełka 1 wróciło: 0.')).toBe(
      'Do wyższego pudełka przeszło: 2, do pudełka jeden wróciło: zero.',
    );
    expect(speechText('Podpowiedź 3: litery po kolei.')).toBe('Podpowiedź trzy: litery po kolei.');
    expect(speechText('Lekcja L3 zaliczona! Odblokowano lekcję L4, litery: ka, el.')).toBe(
      'Lekcja L trzy zaliczona! Odblokowano lekcję L cztery, litery: ka, el.',
    );
    expect(speechText('Wybrana lekcja: L0.')).toBe('Wybrana lekcja: L zero.');
  });

  it('a count before a full stop: nominative, genitive after z / do / od / bez', () => {
    expect(speechText('Koniec sesji. Poprawnie 5 z 10.')).toBe('Koniec sesji. Poprawnie 5 z dziesięciu.');
    expect(speechText('Wpisz numer punktu od 1 do 6.')).toBe('Wpisz numer punktu od 1 do sześciu.');
    expect(speechText('Na następną sesję czeka: 4. Dalej.')).toBe('Na następną sesję czeka: cztery. Dalej.');
    expect(speechText('Zaległe: 12, z bieżącej lekcji: 6, nowe: 2.')).toBe(
      'Zaległe: 12, z bieżącej lekcji: 6, nowe: dwa.',
    );
    expect(speechText('Razem 21.')).toBe('Razem dwadzieścia jeden.');
  });

  it('leaves other numbers alone', () => {
    for (const text of [
      'Ten znak ma 3 punkty.',
      'Do zaliczenia potrzeba 20 prób.',
      'Wersja 0.4.0.',
      'Średnio 1.5 s na odpowiedź.',
      'Moduł PWM 2 nie odpowiada.',
      '80% poprawnych.',
      'Bez liczb.',
    ]) {
      expect(speechText(text)).toBe(text);
    }
    expect(speechText('Litera em ma 3 punkty: punkty 1, 3 i 4.')).toBe('Litera em ma 3 punkty: punkty jeden, trzy i cztery.');
  });
});
