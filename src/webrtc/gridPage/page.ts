import { gridHtmlHead, gridHtmlBody } from './html.js';
import { GRID_JS_PART_1 } from './js1.js';
import { GRID_JS_PART_2 } from './js2.js';
import { GRID_JS_PART_3 } from './js3.js';
import { xtermScriptTags, XTERM_BOOT_JS } from '../../xtermClient.js';

export function gridPage(): string {
  return `${gridHtmlHead()}
${gridHtmlBody()}

${xtermScriptTags()}
<script>
${XTERM_BOOT_JS}
${GRID_JS_PART_1}
${GRID_JS_PART_2}
${GRID_JS_PART_3}</script>
</body>
</html>`;
}