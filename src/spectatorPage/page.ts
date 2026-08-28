import { spectatorShell, SPECTATOR_TAIL, type ShellCtx } from './shell.js';
import { SPECTATOR_JS_CONFIG, SPECTATOR_JS_PART_1 } from './js1.js';
import { SPECTATOR_JS_PART_2 } from './js2.js';
import { SPECTATOR_JS_PART_3 } from './js3.js';
import { SPECTATOR_JS_PART_4 } from './js4.js';

/** Assemble the page from the verbatim slices of the original literal. */
export function spectatorBody(ctx: ShellCtx, config: string): string {
  return `${spectatorShell(ctx)}\n${SPECTATOR_JS_CONFIG(config)}
${SPECTATOR_JS_PART_1}
${SPECTATOR_JS_PART_2}
${SPECTATOR_JS_PART_3}
${SPECTATOR_JS_PART_4}\n${SPECTATOR_TAIL}`;
}
