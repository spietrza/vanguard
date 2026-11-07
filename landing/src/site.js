// taskcell.dev page script: entrance reveals, and the factory scene loaded after first paint.
// Phones get the poster and a button; reduced motion gets one still frame; no WebGL keeps the poster.
const root = document.documentElement;
const phone = matchMedia('(max-width: 640px)').matches;
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------- entrance reveals (site.css hides [data-reveal] only while this runs) ----------
root.classList.add('js');
const items = document.querySelectorAll('[data-reveal]');
if ('IntersectionObserver' in window) {
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.classList.add('in');
      io.unobserve(e.target);
    }
  }, { rootMargin: '0px 0px -8% 0px' });
  items.forEach((el) => io.observe(el));
} else {
  items.forEach((el) => el.classList.add('in'));
}

// ---------- the scene: palette a (Sodium) of proposal D2, locked ----------
const SCENE = {
  fit: 9.8, target: [-1.2, 0.4], transparent: true, grid: true, bloom: true, edgeLabels: true, modules: true,
  monoFont: '"IBM Plex Mono", ui-monospace, monospace',
  ground: 0x0d1013, floor: 0x141a1f, body: 0x232b32, bodyLight: 0x2e3841, glass: 0xa9c6c9, card: 0xe6eaed, idle: 0x33404a,
  conduit: 0x1b2228, dark: 0x161b20, sky: 0xc9d6e2, accent: 0xf99a2c, accent2: 0x79a9ad, fail: 0xff4a3d,
};

let scene = null;
/** The floor captions are drawn into canvases in the mono face, so it must be loaded first. */
const loadScene = async () => {
  scene ??= import('./scene/factory-scene.js');
  await document.fonts.load('500 40px "IBM Plex Mono"').catch(() => null);
  return scene;
};

const afterPaint = (fn) =>
  requestAnimationFrame(() =>
    requestAnimationFrame(() => ('requestIdleCallback' in window ? requestIdleCallback(fn, { timeout: 1200 }) : setTimeout(fn, 200))),
  );

function webgl() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

/** Builds the scene into a .floor host; `run` animates it, otherwise it renders one still frame. */
async function mount(host, options, run) {
  if (!webgl()) return null;
  try {
    const { createFactoryScene } = await loadScene();
    const floor = createFactoryScene(host.querySelector('.stage'), { ...SCENE, ...options });
    if (run && !reduced) floor.start();
    else floor.still();
    requestAnimationFrame(() => host.classList.add('live'));
    return floor;
  } catch (err) {
    console.warn('factory scene unavailable', err);
    return null;
  }
}

// ---------- hero ----------
const heroHost = document.getElementById('floor-hero');
const chip = document.getElementById('follow');
const chipText = chip.querySelector('span');
let hero = null;
const onFollow = (info) => {
  chip.hidden = !info;
  if (info) chipText.textContent = 'Following ' + info;
};
const mountHero = async () => {
  hero = await mount(heroHost, { mode: 'hero', onFollow }, true);
  // The card in the logo breathes while the hero factory runs (site.css turns it off for reduced motion).
  if (hero && !reduced) root.classList.add('factory-on');
};
chip.querySelector('button').addEventListener('click', () => hero && hero.follow(null));

const play = document.getElementById('play');
if (phone) {
  play.hidden = false;
  play.addEventListener('click', async () => {
    play.disabled = true;
    await mountHero();
    play.hidden = true;
  });
} else {
  afterPaint(mountHero);
}

// ---------- Hub preview panel: built when it comes near the screen; phones keep the poster ----------
const panelHost = document.getElementById('floor-panel');
if (!phone) {
  const near = new IntersectionObserver(
    (entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      near.disconnect();
      afterPaint(() => mount(panelHost, { mode: 'panel' }, true));
    },
    { rootMargin: '300px 0px' },
  );
  near.observe(panelHost);
}
