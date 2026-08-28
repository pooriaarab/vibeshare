import { VIEWER_HEAD, VIEWER_TAIL } from './shell.js';
import { VIEWER_JS_PART_1 } from './js1.js';
import { VIEWER_JS_PART_2 } from './js2.js';
import { VIEWER_JS_PART_3 } from './js3.js';
import { VIEWER_JS_PART_4 } from './js4.js';
import { VIEWER_JS_PART_5 } from './js5.js';

/** Assemble the page from the verbatim slices of the original literal. */
export function viewerPage(): string {
  return `${VIEWER_HEAD}\n${VIEWER_JS_PART_1}
${VIEWER_JS_PART_2}
${VIEWER_JS_PART_3}
${VIEWER_JS_PART_4}
${VIEWER_JS_PART_5}\n${VIEWER_TAIL}`;
}
