import { canvasHtmlHead, canvasHtmlBody } from './html.js';
import { CANVAS_JS_PART_1 } from './js1.js';
import { CANVAS_JS_PART_2 } from './js2.js';
import { CANVAS_JS_PART_3 } from './js3.js';
import { xtermScriptTags, XTERM_BOOT_JS } from '../../xtermClient.js';

export function canvasPage(): string {
  return `${canvasHtmlHead()}
${canvasHtmlBody()}

${xtermScriptTags()}
<script>
${XTERM_BOOT_JS}
${CANVAS_JS_PART_1}
${CANVAS_JS_PART_2}
${CANVAS_JS_PART_3}</script>
</body>
</html>`;
}
