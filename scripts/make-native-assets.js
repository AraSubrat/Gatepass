// Regenerates Android/iOS launcher icons and splash screens from resources/icon.svg.
// Usage: node scripts/make-native-assets.js   (needs Playwright's Chromium, used only as an SVG renderer)
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.join(__dirname, '..');
const BRAND = '#0f5b52';
const svg = fs.readFileSync(path.join(root, 'resources/icon.svg'), 'utf8');
const glyph = svg.match(/<g[\s\S]*<\/g>/)[0]; // the white house strokes

// full: rounded/brand square icon; square: full-bleed (iOS masks corners itself);
// fg: glyph only on transparent, scaled into the adaptive-icon safe zone; splash: glyph centred on brand colour.
const art = {
  square: () => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="${BRAND}"/>${glyph}</svg>`,
  round: () => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><circle cx="256" cy="256" r="256" fill="${BRAND}"/><g transform="translate(51 51) scale(.8)">${glyph}</g></svg>`,
  fg: () => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><g transform="translate(128 128) scale(.5)">${glyph}</g></svg>`,
  splash: (w, h) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="${BRAND}"/><g transform="translate(${w / 2 - Math.min(w, h) * 0.12} ${h / 2 - Math.min(w, h) * 0.12}) scale(${(Math.min(w, h) * 0.24) / 512})">${glyph}</g></svg>`,
};

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  async function render(file, w, h, markup, transparent = false) {
    await page.setViewportSize({ width: w, height: h });
    await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${w}px;height:${h}px}</style>${markup}`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    await page.screenshot({ path: file, omitBackground: transparent });
  }
  const res = path.join(root, 'android/app/src/main/res');
  const dens = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
  for (const [d, k] of Object.entries(dens)) {
    await render(`${res}/mipmap-${d}/ic_launcher.png`, 48 * k, 48 * k, art.round(), true);
    await render(`${res}/mipmap-${d}/ic_launcher_round.png`, 48 * k, 48 * k, art.round(), true);
    await render(`${res}/mipmap-${d}/ic_launcher_foreground.png`, 108 * k, 108 * k, art.fg(), true);
    await render(`${res}/drawable-port-${d}/splash.png`, 320 * k, 480 * k, art.splash(320 * k, 480 * k));
    await render(`${res}/drawable-land-${d}/splash.png`, 480 * k, 320 * k, art.splash(480 * k, 320 * k));
  }
  await render(`${res}/drawable/splash.png`, 480, 320, art.splash(480, 320));
  fs.writeFileSync(`${res}/values/ic_launcher_background.xml`,
    `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${BRAND.toUpperCase()}</color>\n</resources>\n`);

  const ios = path.join(root, 'ios/App/App/Assets.xcassets');
  await render(`${ios}/AppIcon.appiconset/AppIcon-512@2x.png`, 1024, 1024, art.square());
  for (const f of ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png']) {
    await render(`${ios}/Splash.imageset/${f}`, 2732, 2732, art.splash(2732, 2732));
  }
  await browser.close();
  console.log('Native icons and splash screens generated.');
})();
