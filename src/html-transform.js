const localDesignAssets =
  '<link rel="stylesheet" href="/design/daisyui.css" data-lavish-design><script src="/design/tailwindcss-browser.js" data-lavish-design></script><link rel="stylesheet" href="/design/daisyui-themes.css" data-lavish-design>';
const publicDesignAssets =
  '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/daisyui@5.5.19/daisyui.css" data-lavish-design><script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4.2.4/dist/index.global.js" data-lavish-design></script><link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/daisyui@5.5.19/themes.css" data-lavish-design>';

export function injectLavishSdk(html, key) {
  const script = `<script src="/sdk.js?key=${encodeURIComponent(key)}"></script>`;
  const design = shouldInjectDesign(html) ? localDesignAssets : "";
  const withDesign = injectDesignAssets(html, design);
  if (/<\/body\s*>/i.test(withDesign)) {
    return withDesign.replace(/<\/body\s*>/i, `${script}</body>`);
  }
  return `${withDesign}\n${script}`;
}

export function injectPublicDesignAssets(html) {
  return injectDesignAssets(html, shouldInjectDesign(html) ? publicDesignAssets : "");
}

function shouldInjectDesign(html) {
  if (/data-lavish-design/i.test(html)) return false;
  return !/<meta\b(?=[^>]*name=["']lavish-design["'])(?=[^>]*content=["']off["'])[^>]*>/i.test(html);
}

function injectDesignAssets(html, design) {
  if (!design) return html;
  if (/<head\b[^>]*>/i.test(html)) {
    return html.replace(/<head\b[^>]*>/i, (match) => `${match}${design}`);
  }
  return `${html}\n${design}`;
}
