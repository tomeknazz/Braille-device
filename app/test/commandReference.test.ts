// @vitest-environment happy-dom
// The service command reference must list every verb the firmware knows,
// and "Wstaw" must only fill the console input — never send anything.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMMAND_GROUPS, renderCommandReference } from '../src/ui/commandReference';

// vitest runs with the app/ directory as root.
const firmware = readFileSync(resolve(process.cwd(), '../src/main.cpp'), 'utf8');

/** Verbs listed in print_help(): the first word of every `out.println("  <verb>...` line. */
function firmwareHelpVerbs(): string[] {
  const body = /void print_help\(Print &out\) \{([\s\S]*?)\n\}/.exec(firmware)![1]!;
  const verbs = new Set<string>();
  for (const m of body.matchAll(/out\.println\("  ([a-z?]+)/g)) verbs.add(m[1]!);
  return [...verbs];
}

const allSyntax = COMMAND_GROUPS.flatMap((g) => g.commands.map((c) => c.syntax)).join('\n');

describe('command reference', () => {
  it('covers every verb from the firmware help text', () => {
    const verbs = firmwareHelpVerbs();
    expect(verbs.length).toBeGreaterThan(10);
    const tokens = new Set(allSyntax.split(/[\s|,[\]]+/).filter(Boolean));
    for (const verb of verbs) expect(tokens.has(verb), `missing "${verb}"`).toBe(true);
  });

  it('covers the raw servo, min/max and letter forms', () => {
    expect(allSyntax).toContain('<indeks>,<pwm>');
    expect(allSyntax).toContain('<indeks>,min | max');
    expect(allSyntax).toContain('min | max');
    expect(allSyntax).toContain('<litera>');
  });

  it('has a description and an example for every command', () => {
    for (const cmd of COMMAND_GROUPS.flatMap((g) => g.commands)) {
      expect(cmd.description.length, cmd.syntax).toBeGreaterThan(10);
      expect(cmd.example.trim(), cmd.syntax).not.toBe('');
    }
  });

  it('renders accessible tables and "Wstaw" only hands back the example', () => {
    const picked: string[] = [];
    const el = renderCommandReference((ex) => picked.push(ex));
    document.body.append(el);

    const tables = el.querySelectorAll('table');
    expect(tables.length).toBe(COMMAND_GROUPS.length);
    for (const t of tables) expect(t.querySelector('caption')?.textContent).toBeTruthy();

    const button = el.querySelector<HTMLButtonElement>('button[aria-label="Wstaw przykład: show,5,21,30"]');
    expect(button).not.toBeNull();
    button!.click();
    expect(picked).toEqual(['show,5,21,30']);
  });
});
