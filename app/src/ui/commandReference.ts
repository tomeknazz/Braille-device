// Reference of every firmware command (protocol v1), shown in the service
// section next to the raw command console. Mirrors print_help() in
// src/main.cpp and docs/PROTOCOL.md §4 — keep them in sync.

export interface CommandInfo {
  /** Syntax as typed on the serial line. */
  syntax: string;
  /** What the command does (Polish, for the service UI). */
  description: string;
  /** A safe, ready-to-send example. */
  example: string;
  /** Moves servos — worth knowing before sending it to the device. */
  moves: boolean;
}

export interface CommandGroup {
  title: string;
  commands: CommandInfo[];
}

export const COMMAND_GROUPS: CommandGroup[] = [
  {
    title: 'Wyświetlanie (protokół v1)',
    commands: [
      {
        syntax: 'show[,m0,m1,m2,m3,m4]',
        description:
          'Ustawia cały wyświetlacz. Maska 0–63: bit0 = punkt 1 … bit5 = punkt 6. „-” zostawia komórkę bez zmian, brakujące komórki są czyszczone, samo „show” czyści wszystko. Przyjmuje też hex (show,x05151E) i znaki brajla (show,⠅⠕⠞).',
        example: 'show,5,21,30',
        moves: true,
      },
      {
        syntax: 'cell,<i>,<maska>',
        description: 'Ustawia jedną komórkę (0–4), pozostałe zostają bez zmian.',
        example: 'cell,2,13',
        moves: true,
      },
      {
        syntax: 'text,<znaki>',
        description: 'Skrót testowy: do 5 znaków A–Z; „_” lub spacja = pusta komórka. Polskie litery tylko przez maski.',
        example: 'text,KOT',
        moves: true,
      },
      {
        syntax: 'clear,<i>',
        description: 'Chowa punkty jednej komórki (0–4).',
        example: 'clear,1',
        moves: true,
      },
      {
        syntax: 'clear | space',
        description: 'Chowa wszystkie punkty (spacja brajlowska).',
        example: 'clear',
        moves: true,
      },
      {
        syntax: 'get',
        description: 'Zwraca aktualne maski wszystkich komórek, bez ruchu: OK get a,b,c,d,e.',
        example: 'get',
        moves: false,
      },
      {
        syntax: 'refresh',
        description: 'Ponownie dociska wszystkie punkty do bieżących masek (np. po ręcznym wciśnięciu punktu).',
        example: 'refresh',
        moves: true,
      },
    ],
  },
  {
    title: 'Ustawienia i stan',
    commands: [
      {
        syntax: 'hello',
        description: 'Przywitanie: wersja firmware, protokołu i stan obu modułów PCA9685. Bez ruchu.',
        example: 'hello',
        moves: false,
      },
      {
        syntax: 'ping',
        description: 'Podtrzymanie połączenia, zeruje licznik uśpienia. Bez ruchu.',
        example: 'ping',
        moves: false,
      },
      {
        syntax: 'anim[,<ms>]',
        description:
          'Opóźnienie między kolejnymi punktami: 0 = normalne (20 ms), 20–2000 = powolne wysuwanie do nauki. Bez argumentu podaje bieżącą wartość.',
        example: 'anim,300',
        moves: false,
      },
      {
        syntax: 'idle[,<down_s>,<sleep_s>]',
        description:
          'Bezczynność: po down_s s schowane punkty tracą PWM, po sleep_s s bez komend wyświetlacz się czyści. 0 wyłącza etap (domyślnie 2,300). Na czas kalibracji: idle,2,0.',
        example: 'idle,2,0',
        moves: false,
      },
      {
        syntax: 'sleep',
        description: 'Czyści wyświetlacz i wyłącza PWM wszystkich serw.',
        example: 'sleep',
        moves: true,
      },
    ],
  },
  {
    title: 'Kalibracja i testy serw',
    commands: [
      {
        syntax: '<indeks>,<pwm>',
        description: 'Surowy PWM (90–520) na jedno serwo 0–29. Indeks = komórka × 6 + (punkt − 1).',
        example: '7,430',
        moves: true,
      },
      {
        syntax: '<indeks>,min | max',
        description: 'Jedno serwo do skalibrowanej pozycji schowanej / wysuniętej.',
        example: '7,max',
        moves: true,
      },
      {
        syntax: 'min | max',
        description: 'Wszystkie 30 punktów w dół / w górę, pełną kaskadą (także all,min / all,max).',
        example: 'min',
        moves: true,
      },
      {
        syntax: '<litera>',
        description: 'Litera A–Z na wszystkich pięciu komórkach.',
        example: 'A',
        moves: true,
      },
      {
        syntax: 'dump',
        description: 'Tabela kalibracji jako CSV: index,cell,dot,retracted,extended.',
        example: 'dump',
        moves: false,
      },
      {
        syntax: 'help | ?',
        description: 'Lista komend wypisana przez firmware.',
        example: 'help',
        moves: false,
      },
    ],
  },
];

/**
 * Renders the command reference as collapsible tables. `onPick` receives the
 * example of the chosen row; the caller decides what to do with it (the log
 * console puts it in its input — it never sends anything by itself).
 */
export function renderCommandReference(onPick: (example: string) => void): HTMLElement {
  const details = document.createElement('details');
  details.className = 'command-reference';
  const summary = document.createElement('summary');
  summary.textContent = 'Dostępne komendy';
  details.append(summary);

  const intro = document.createElement('p');
  intro.className = 'hint';
  intro.textContent =
    'Przycisk „Wstaw” kopiuje przykład do pola komendy — wysyłasz go dopiero przyciskiem „Wyślij”. ' +
    'Do każdej komendy można dopisać „ #znacznik”, który wróci w odpowiedzi OK/ERR.';
  details.append(intro);

  for (const group of COMMAND_GROUPS) {
    const table = document.createElement('table');
    table.className = 'command-table';
    const caption = document.createElement('caption');
    caption.textContent = group.title;
    table.append(caption);

    const head = table.createTHead().insertRow();
    for (const text of ['Komenda', 'Opis', 'Przykład']) {
      const th = document.createElement('th');
      th.scope = 'col';
      th.textContent = text;
      head.append(th);
    }

    const body = table.createTBody();
    for (const cmd of group.commands) {
      const row = body.insertRow();
      const syntax = document.createElement('th');
      syntax.scope = 'row';
      const code = document.createElement('code');
      code.textContent = cmd.syntax;
      syntax.append(code);
      row.append(syntax);

      const desc = row.insertCell();
      desc.textContent = cmd.description;
      if (cmd.moves) {
        const tag = document.createElement('span');
        tag.className = 'moves-tag';
        tag.textContent = ' Rusza serwami.';
        desc.append(tag);
      }

      const ex = row.insertCell();
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'insert-example';
      const exCode = document.createElement('code');
      exCode.textContent = cmd.example;
      button.append('Wstaw ', exCode);
      button.setAttribute('aria-label', `Wstaw przykład: ${cmd.example}`);
      button.addEventListener('click', () => onPick(cmd.example));
      ex.append(button);
    }
    details.append(table);
  }
  return details;
}
