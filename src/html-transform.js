export function injectLavishSdk(html, key, whiteboardEditingEnabled = false) {
  const script = `<script src="/sdk.js?key=${encodeURIComponent(key)}${whiteboardEditingEnabled ? "&whiteboard=1" : ""}"></script>`;
  if (/<\/body\s*>/i.test(html)) {
    return html.replace(/<\/body\s*>/i, `${script}</body>`);
  }
  return `${html}\n${script}`;
}
