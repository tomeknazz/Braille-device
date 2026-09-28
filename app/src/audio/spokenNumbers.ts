// Digits as Polish speech engines and screen readers should say them. Left as
// digits, "na komórce 1" comes out as "na komórce jedna" (wrong gender) and a
// number before a full stop as an ordinal ("punkt 4." -> "punkt czwartego"),
// because "4." is how Polish writes "4th". Messages keep digits in the code
// and on screen; speechText() rewrites them just before they are spoken.
//
// Dots, cells, boxes and hints are named by numbers, which Polish says in the
// nominative whatever the case of the noun: "punktem cztery", "na komórce
// jeden" (as in DYDAKTYKA "punkt jeden… punkt trzy"). A count that ends a
// sentence is written out too, in the genitive after z / do / od / bez
// ("5 z 10." -> "5 z dziesięciu.").

const UNITS = ['zero', 'jeden', 'dwa', 'trzy', 'cztery', 'pięć', 'sześć', 'siedem', 'osiem', 'dziewięć'];
const TEENS = [
  'dziesięć', 'jedenaście', 'dwanaście', 'trzynaście', 'czternaście',
  'piętnaście', 'szesnaście', 'siedemnaście', 'osiemnaście', 'dziewiętnaście',
];
const TENS = [
  '', '', 'dwadzieścia', 'trzydzieści', 'czterdzieści',
  'pięćdziesiąt', 'sześćdziesiąt', 'siedemdziesiąt', 'osiemdziesiąt', 'dziewięćdziesiąt',
];
const HUNDREDS = ['', 'sto', 'dwieście', 'trzysta', 'czterysta', 'pięćset', 'sześćset', 'siedemset', 'osiemset', 'dziewięćset'];

const UNITS_GEN = ['zera', 'jednego', 'dwóch', 'trzech', 'czterech', 'pięciu', 'sześciu', 'siedmiu', 'ośmiu', 'dziewięciu'];
const TEENS_GEN = [
  'dziesięciu', 'jedenastu', 'dwunastu', 'trzynastu', 'czternastu',
  'piętnastu', 'szesnastu', 'siedemnastu', 'osiemnastu', 'dziewiętnastu',
];
const TENS_GEN = [
  '', '', 'dwudziestu', 'trzydziestu', 'czterdziestu',
  'pięćdziesięciu', 'sześćdziesięciu', 'siedemdziesięciu', 'osiemdziesięciu', 'dziewięćdziesięciu',
];
const HUNDREDS_GEN = ['', 'stu', 'dwustu', 'trzystu', 'czterystu', 'pięciuset', 'sześciuset', 'siedmiuset', 'ośmiuset', 'dziewięciuset'];

export type NumberCase = 'nom' | 'gen';

/** Cardinal number in words, 0-999 ("cztery", "dwudziestu"); larger numbers stay digits. */
export function numberWords(n: number, grammaticalCase: NumberCase = 'nom'): string {
  if (!Number.isInteger(n) || n < 0 || n > 999) return String(n);
  const gen = grammaticalCase === 'gen';
  const units = gen ? UNITS_GEN : UNITS;
  if (n < 10) return units[n]!;
  const parts: string[] = [];
  const h = Math.floor(n / 100);
  const rest = n % 100;
  if (h) parts.push((gen ? HUNDREDS_GEN : HUNDREDS)[h]!);
  if (rest >= 10 && rest < 20) parts.push((gen ? TEENS_GEN : TEENS)[rest - 10]!);
  else {
    if (rest >= 20) parts.push((gen ? TENS_GEN : TENS)[Math.floor(rest / 10)]!);
    if (rest % 10) parts.push(units[rest % 10]!);
  }
  return parts.join(' ');
}

const word = (digits: string, grammaticalCase: NumberCase = 'nom') => numberWords(Number(digits), grammaticalCase);

/** A noun naming things by number (any inflection), then a list: "punkty 1, 3 i 4", "komórkach 1 i 3". */
const LABELLED =
  /(?<!\p{L})((?:punkt|komór|pudeł|podpowied|numer|nr)\p{L}*\.?\s+)(\d+(?:\s*(?:,|i|oraz|albo|lub|-|–)\s*\d+)*)(?!\p{L}|\d)/giu;
/** Lesson ids: "L3" -> "L trzy". */
const LESSON_ID = /(?<!\p{L}|\d)L(\d)(?!\p{L}|\d)/gu;
/** A number closing a sentence, with the word before it: "z 10." */
const BEFORE_STOP = /(?<!\p{L}|\d|[.,])(?:(z|ze|do|od|bez)\s+)?(\d+)(?=\.(?:\s|$))/giu;
const GENITIVE_PREPOSITIONS = new Set(['z', 'ze', 'do', 'od', 'bez']);

/** Text for the speech channel (speech synthesis and the aria-live region). */
export function speechText(text: string): string {
  return text
    .replace(LABELLED, (_, noun: string, list: string) => noun + list.replace(/\d+/g, (d) => word(d)))
    .replace(LESSON_ID, (_, d: string) => `L ${word(d)}`)
    .replace(BEFORE_STOP, (_, prep: string | undefined, digits: string) =>
      prep ? `${prep} ${word(digits, GENITIVE_PREPOSITIONS.has(prep.toLowerCase()) ? 'gen' : 'nom')}` : word(digits),
    );
}
