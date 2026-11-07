// Taskcell factory floor: an isometric, procedural three.js scene of the card → cell → gates → PR flow.
// Plain ES module, no framework. Production copy of landing/proposals/d/factory-scene.js: three is imported
// from the vendored file next to it, and the station copy is checked against the README. The page supplies
// the CSS for the label classes (.fs-*). Usage:
//   const floor = createFactoryScene(el, { mode: 'hero' });
//   floor.start(); floor.stop(); floor.still(); floor.destroy();
// Everything shown is the product's real behaviour; the moving cards are a simulation, not live data.
import * as THREE from './three-0.170.0.module.min.js'; // three r170, vendored: no CDN, CSP script-src 'self'

/** Stations, their place on the floor (x, z) and what they really do. Exported for the Hub's own UI. */
export const STATIONS = [
  { id: 'intake', name: 'Intake', x: -9.6, z: 0, detail: 'Issues from GitHub, GitLab or Linear, or cards on a GitHub Projects board. A card too vague to build goes back as needs info.' },
  { id: 'cells', name: 'Sandbox cells', x: -5.6, z: -3.3, detail: 'One Docker container per card. Non-root, no new privileges, minimal capabilities, no repo token inside.' },
  { id: 'egress', name: 'Egress', x: -5.6, z: 3.3, detail: 'With the LLM proxy on: only allowlisted hosts. The model key stays in the proxy; the agent gets a one-run nonce.' },
  { id: 'tests', name: 'Tests', x: -1.8, z: 0, gate: true, detail: "Your verify script runs, or the repo's test scripts. A red gate sends the card back for a repair." },
  { id: 'types', name: 'Types', x: 0.2, z: 0, gate: true, detail: 'Typecheck and lint, when your verify script runs them. A red gate sends the card back for a repair.' },
  { id: 'secrets', name: 'Secrets', x: 2.2, z: 0, gate: true, detail: 'Every diff is scanned for secrets on the host. A hit pushes nothing.' },
  { id: 'spec', name: 'Spec', x: 4.2, z: 0, gate: true, detail: 'The change is checked against the acceptance criteria of the tech spec written before the build.' },
  { id: 'review', name: 'Review', x: 6.6, z: 0, detail: 'A reviewer in a fresh context, on a second model if you pick one. On GitHub, your review comments send it back for a revision.' },
  { id: 'outbound', name: 'PR out', x: 9.4, z: 0, detail: 'The host, not the agent, pushes the branch and opens the PR. CI config edits are dropped. You merge.' },
];

/** Swappable modules, as the product has them: task sources (src/tasks) and coding agents (src/agents). */
export const MODULES = {
  source: ['GitHub', 'GitLab', 'Linear', 'Projects'],
  engine: ['Claude Code', 'Codex', 'Cursor', 'OpenRouter'],
};

const CELL_Z = [-3.3, -1.1, 1.1, 3.3];
const CELL_X = -5.6;

// Seed decisions (see landing/DIRECTION.md): accent hue, camera, tempo and easing.
const DEFAULTS = {
  accent: 0xf99a2c,
  fail: 0xff4a3d,
  ground: 0x0f1215,
  floor: 0x161b20,
  body: 0x252c33,
  bodyLight: 0x313a43,
  edge: 0x56636f,
  glass: 0x9fb3c2,
  glassEdge: 0x8fa6b8,
  card: 0xdfe4e8,
  idle: 0x3a4650, // unlit gate lintels, empty charge tracks
  conduit: 0x20272e, // the gap between flow dashes
  dark: 0x1a1f24, // base under emissive parts
  sky: 0xc9d6e2,
  // Finish. Off by default (direction D); direction D2 turns them on.
  accent2: null, // second accent: glowing glass edges, floor hairlines, rim light, edge labels
  prColor: null, // colour of opened PRs (defaults to accent)
  transparent: false, // let the page's background (e.g. a radial glow) show through
  grid: false, // 1px grid across the floor and a faint one beyond it
  bloom: false, // fake bloom: additive halo sprites on working agents, cards, lit gates, PRs
  edgeLabels: false, // small mono labels lying along the floor's edges
  modules: false, // swappable source and engine modules, with an auto-demo while nobody touches the scene
  demoEvery: 6000, // ms between auto-demo swaps
  monoFont: 'ui-monospace, Menlo, monospace',
  azimuth: 41, // degrees around the vertical axis
  elevation: 35.264, // true isometric
  halfHeight: 4.6, // orthographic zoom: world units from centre to top edge
  fit: 8.4, // hero: world units that must fit across half the width
  target: [0, 0], // floor point (x, z) the camera looks at
  beat: 900, // ms for one stage move
  ease: [0.62, 0, 0.12, 1],
  failRate: 0.14,
};

/** Cubic-bezier easing, solved for x by Newton steps (same curve as CSS). */
function bezier([x1, y1, x2, y2]) {
  const a = (p1, p2) => 1 - 3 * p2 + 3 * p1;
  const b = (p1, p2) => 3 * p2 - 6 * p1;
  const c = (p1) => 3 * p1;
  const at = (t, p1, p2) => ((a(p1, p2) * t + b(p1, p2)) * t + c(p1)) * t;
  const slope = (t, p1, p2) => 3 * a(p1, p2) * t * t + 2 * b(p1, p2) * t + c(p1);
  return (x) => {
    if (x <= 0 || x >= 1) return Math.min(1, Math.max(0, x));
    let t = x;
    for (let i = 0; i < 6; i++) {
      const s = slope(t, x1, x2);
      if (Math.abs(s) < 1e-6) break;
      t -= (at(t, x1, x2) - x) / s;
    }
    return at(t, y1, y2);
  };
}

/** Small deterministic generator, so a still render always shows the same floor. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Dashes on a strip: the flow texture shared by every conduit. */
const hex = (n) => `#${n.toString(16).padStart(6, '0')}`;

function flowTexture(accent, gap) {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 4;
  const g = c.getContext('2d');
  g.fillStyle = hex(gap);
  g.fillRect(0, 0, 64, 4);
  g.fillStyle = hex(accent);
  g.fillRect(0, 0, 18, 4);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** A soft white disc; tinted per sprite and added on top, it reads as bloom without a post pass. */
function haloTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, 'rgba(255,255,255,0.9)');
  r.addColorStop(0.35, 'rgba(255,255,255,0.28)');
  r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

/** A module's top plate: dark face, hairline frame, the name centred in mono. `aspect` is width / depth. */
function plateTexture(text, font, ink, bg, aspect) {
  const c = document.createElement('canvas');
  c.height = 128;
  c.width = Math.round(128 * aspect);
  const g = c.getContext('2d');
  g.fillStyle = hex(bg);
  g.fillRect(0, 0, c.width, c.height);
  g.strokeStyle = hex(ink);
  g.globalAlpha = 0.5;
  g.lineWidth = 3;
  g.strokeRect(6, 6, c.width - 12, c.height - 12);
  g.globalAlpha = 1;
  let size = 64;
  do g.font = `500 ${size--}px ${font}`;
  while (g.measureText(text).width > c.width - 36 && size > 12);
  g.fillStyle = hex(ink);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, c.width / 2, c.height / 2 + 2);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Mono caption drawn to a canvas, for a plane lying on the floor. */
function textTexture(text, font, color) {
  const c = document.createElement('canvas');
  const g = c.getContext('2d');
  const f = `500 40px ${font}`;
  g.font = f;
  c.width = Math.ceil(g.measureText(text).width) + 8;
  c.height = 52;
  g.font = f;
  g.fillStyle = hex(color);
  g.textBaseline = 'middle';
  g.fillText(text, 4, 27);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/**
 * Builds the factory floor inside `container`.
 * @param {HTMLElement} container
 * @param {{ mode?: 'hero' | 'panel', labels?: boolean, seed?: number, onFollow?: (info: string | null) => void } & Partial<typeof DEFAULTS>} options
 */
export function createFactoryScene(container, options = {}) {
  const o = { ...DEFAULTS, mode: 'hero', labels: true, seed: 0x9d93e5f0, ...options };
  const ease = bezier(o.ease);
  const rand = rng(o.seed);
  const panel = o.mode === 'panel';

  // ---------- renderer, camera ----------
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: o.transparent, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, panel ? 1.5 : 2));
  renderer.setClearColor(o.ground, o.transparent ? 0 : 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.domElement.className = 'fs-canvas';
  renderer.domElement.setAttribute('aria-hidden', 'true');
  container.append(renderer.domElement);

  const scene = new THREE.Scene();
  const world = new THREE.Group();
  scene.add(world);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200);
  const view = { az: o.azimuth, el: o.elevation, dAz: 0, dEl: 0, target: new THREE.Vector3(o.target[0], 0, o.target[1]), zoom: 1 };
  const goal = { target: view.target.clone(), zoom: 1 };

  scene.add(new THREE.HemisphereLight(o.sky, 0x0b0d10, 1.1));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(-6, 14, 8);
  scene.add(sun);
  if (o.accent2 !== null) {
    // Rim light from behind in the second accent: lit edges on every box, the "premium" read.
    const rim = new THREE.DirectionalLight(o.accent2, 1.4);
    rim.position.set(9, 5, -12);
    scene.add(rim);
  }

  // ---------- materials ----------
  const lit = o.accent2 !== null;
  const add = { transparent: true, blending: THREE.AdditiveBlending, depthWrite: false };
  const mat = {
    floor: new THREE.MeshStandardMaterial({ color: o.floor, roughness: lit ? 0.55 : 0.95, metalness: lit ? 0.35 : 0 }),
    body: new THREE.MeshStandardMaterial({ color: o.body, roughness: lit ? 0.45 : 0.8, metalness: lit ? 0.4 : 0 }),
    bodyLight: new THREE.MeshStandardMaterial({ color: o.bodyLight, roughness: 0.7 }),
    glass: new THREE.MeshStandardMaterial({ color: o.glass, transparent: true, opacity: lit ? 0.08 : 0.12, roughness: 0.1, depthWrite: false }),
    edge: lit ? new THREE.LineBasicMaterial({ color: o.accent2, ...add, opacity: 0.35 }) : new THREE.LineBasicMaterial({ color: o.edge }),
    edgeGlass: lit ? new THREE.LineBasicMaterial({ color: o.accent2, ...add, opacity: 0.95 }) : new THREE.LineBasicMaterial({ color: o.glassEdge, transparent: true, opacity: 0.7 }),
    card: new THREE.MeshStandardMaterial({ color: o.card, roughness: 0.6 }),
  };
  const prColor = o.prColor ?? o.accent;
  const flow = flowTexture(o.accent, o.conduit);
  const geos = [];
  const keep = (g) => (geos.push(g), g);
  const owned = []; // materials and textures made per part, disposed with the scene
  const own = (x) => (owned.push(x), x);
  const haloTex = o.bloom ? own(haloTexture()) : null;
  /** Additive glow sprite; its opacity is the glow's strength. */
  const halo = (color, size, parent) => {
    const s = new THREE.Sprite(own(new THREE.SpriteMaterial({ map: haloTex, color, ...add, opacity: 0 })));
    s.scale.set(size, size, 1);
    parent.add(s);
    return s;
  };

  const box = (w, h, d, m, x, y, z, parent = world) => {
    const mesh = new THREE.Mesh(keep(new THREE.BoxGeometry(w, h, d)), m);
    mesh.position.set(x, y + h / 2, z);
    parent.add(mesh);
    return mesh;
  };
  const edges = (mesh, m = mat.edge) => {
    const l = new THREE.LineSegments(keep(new THREE.EdgesGeometry(mesh.geometry)), m);
    mesh.add(l);
    return l;
  };
  const glow = (color, intensity = 1) => new THREE.MeshStandardMaterial({ color: o.dark, emissive: color, emissiveIntensity: intensity, roughness: 0.4 });

  // ---------- the floor ----------
  const floorSlab = box(22.5, 0.2, 10.6, mat.floor, -0.1, -0.2, 0);
  if (lit) edges(floorSlab, own(new THREE.LineBasicMaterial({ color: o.accent2, ...add, opacity: 0.7 })));
  if (o.grid) {
    // 1px lines every half unit on the floor, and a wider, fainter grid running off into the dark.
    const gridAt = (w, d, step, y, opacity) => {
      const pts = [];
      for (let x = -w / 2; x <= w / 2 + 1e-6; x += step) pts.push(x, y, -d / 2, x, y, d / 2);
      for (let z = -d / 2; z <= d / 2 + 1e-6; z += step) pts.push(-w / 2, y, z, w / 2, y, z);
      const g = keep(new THREE.BufferGeometry());
      g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      const l = new THREE.LineSegments(g, own(new THREE.LineBasicMaterial({ color: o.accent2 ?? o.edge, ...add, opacity })));
      l.position.x = -0.1;
      world.add(l);
    };
    gridAt(22.5, 10.5, 0.5, 0.003, 0.09);
    gridAt(60, 40, 2, -0.21, 0.05);
  }
  const hits = []; // invisible boxes for hovering stations

  const hit = (st, w, h, d) => {
    const m = new THREE.Mesh(keep(new THREE.BoxGeometry(w, h, d)), new THREE.MeshBasicMaterial({ visible: false }));
    m.position.set(st.x, h / 2, st.z);
    m.userData.station = st.id;
    world.add(m);
    hits.push(m);
  };
  const station = (id) => STATIONS.find((s) => s.id === id);

  // Intake dock: a platform with a short ramp of slats.
  const intake = station('intake');
  edges(box(2.2, 0.35, 3.2, mat.body, intake.x, 0, 0));
  for (let i = 0; i < 4; i++) box(1.8, 0.05, 0.12, mat.bodyLight, intake.x, 0.35, -1.1 + i * 0.72);
  hit(intake, 2.4, 1.2, 3.4);

  // Sandbox cells: glass boxes on plinths, an agent light inside each.
  const cells = CELL_Z.map((z) => {
    const plinth = box(2.0, 0.18, 1.7, mat.body, CELL_X, 0, z);
    edges(plinth);
    const glassBox = box(1.9, 1.35, 1.6, mat.glass, CELL_X, 0.18, z);
    edges(glassBox, mat.edgeGlass);
    const agentMat = glow(o.accent, 0.25);
    const agent = box(0.34, 0.34, 0.34, agentMat, CELL_X - 0.45, 0.2, z - 0.35);
    const aura = o.bloom ? halo(o.accent, 2.2, agent) : null;
    return { z, agent, agentMat, aura, card: null, phase: rand() * Math.PI * 2 };
  });
  hit(station('cells'), 2.2, 1.6, 8.8);
  // Egress: one small vent on each roof, the only way out, and only to allowlisted hosts.
  const egress = station('egress');
  const ventMat = mat.bodyLight;
  CELL_Z.forEach((z) => box(0.5, 0.16, 0.5, ventMat, CELL_X + 0.4, 1.53, z + 0.3));
  {
    const m = new THREE.Mesh(keep(new THREE.BoxGeometry(2.0, 0.6, 8.6)), new THREE.MeshBasicMaterial({ visible: false }));
    m.position.set(CELL_X, 1.75, 0);
    m.userData.station = 'egress';
    world.add(m);
    hits.push(m);
  }

  // Swappable modules (option `modules`): the source module on the intake dock and the engine cartridge on
  // each cell roof. Swapping lifts the module out, drops the next one in, and a lock light blinks.
  const groups = {};
  const plates = new Map();
  /** Top-face texture with the module name, made once per name and size. */
  const plate = (name, w, d) => {
    const key = name + w;
    if (!plates.has(key)) plates.set(key, own(plateTexture(name.toUpperCase(), o.monoFont, o.accent2 ?? o.edge, o.dark, w / d)));
    return plates.get(key);
  };
  if (o.modules) {
    const slot = (x, y, z, w, d) => {
      const frame = new THREE.Mesh(keep(new THREE.BoxGeometry(w + 0.14, 0.02, d + 0.14)), mat.body);
      frame.position.set(x, y + 0.01, z);
      world.add(frame);
      edges(frame, lit ? mat.edgeGlass : mat.edge);
    };
    const unit = (x, y, z, w, h, d, name, lightAt) => {
      const top = own(new THREE.MeshBasicMaterial({ map: plate(name, w, d) }));
      const mesh = new THREE.Mesh(keep(new THREE.BoxGeometry(w, h, d)), [mat.bodyLight, mat.bodyLight, top, mat.body, mat.bodyLight, mat.bodyLight]);
      mesh.position.set(x, y + h / 2, z);
      world.add(mesh);
      edges(mesh, lit ? mat.edgeGlass : mat.edge);
      const lightMat = own(new THREE.MeshBasicMaterial({ color: o.idle }));
      const light = new THREE.Mesh(keep(new THREE.BoxGeometry(0.1, 0.06, 0.1)), lightMat);
      light.position.set(lightAt[0], y + 0.03, lightAt[1]);
      world.add(light);
      return { mesh, top, w, d, baseY: y + h / 2, lightMat };
    };
    slot(intake.x, 0.35, 0.95, 1.5, 0.9);
    groups.source = {
      kind: 'source',
      options: MODULES.source,
      idx: 0,
      units: [unit(intake.x, 0.35, 0.95, 1.5, 0.28, 0.9, MODULES.source[0], [intake.x + 0.9, 0.35])],
    };
    groups.engine = {
      kind: 'engine',
      options: MODULES.engine,
      idx: 0,
      units: CELL_Z.map((z) => {
        slot(CELL_X - 0.3, 1.53, z - 0.4, 1.1, 0.5);
        return unit(CELL_X - 0.3, 1.53, z - 0.4, 1.1, 0.16, 0.5, MODULES.engine[0], [CELL_X + 0.45, z - 0.4]);
      }),
    };
    Object.values(groups).forEach((g) => {
      g.anim = null;
      g.units.forEach((u) => (u.mesh.userData.module = g.kind));
    });
  }
  const moduleHits = Object.values(groups).flatMap((g) => g.units.map((u) => u.mesh));
  // Auto-demo: one swap every `demoEvery` ms, alternating engine and source, until someone touches the scene.
  let demo = o.modules;
  let demoIn = o.demoEvery * 0.6;
  let demoTurn = 0;
  const moduleName = (kind) => groups[kind].options[groups[kind].idx];
  const LIFT = 2.0;
  const SWAP_MS = 1500; // lift 0–380, swap at 380, drop 480–800, settle to 920, lock light to 1500
  /** Starts a tool change on `kind`; without the loop running (still, reduced motion) it applies at once. */
  function swap(kind, to) {
    const g = groups[kind];
    if (!g || g.anim) return;
    const next = to ? Math.max(0, g.options.findIndex((n) => n.toLowerCase() === String(to).toLowerCase())) : (g.idx + 1) % g.options.length;
    if (!running) {
      g.idx = next;
      g.units.forEach((u) => (u.top.map = plate(moduleName(kind), u.w, u.d)));
      draw();
      if (o.onSwap) o.onSwap(kind, moduleName(kind));
      return;
    }
    g.anim = { t: 0, next, swapped: false };
  }
  function updateModules(dt) {
    for (const g of Object.values(groups)) {
      if (!g.anim) continue;
      const a = g.anim;
      a.t += dt;
      g.units.forEach((u, i) => {
        const t = a.t - i * 120; // the cells change one after another
        let y = 0;
        if (t <= 0) y = 0;
        else if (t < 380) y = LIFT * ease(t / 380);
        else if (t < 480) y = LIFT;
        else if (t < 800) y = LIFT * (1 - ((t - 480) / 320) ** 2) - 0.04 * ((t - 480) / 320);
        else if (t < 920) y = -0.04 * (1 - (t - 800) / 120);
        u.mesh.position.y = u.baseY + y;
        if (t >= 380 && !u.swapped) {
          u.swapped = true;
          g.idx = a.next;
          u.top.map = plate(moduleName(g.kind), u.w, u.d);
        }
        const blink = t > 920 && t < SWAP_MS && Math.floor((t - 920) / 100) % 2 === 0;
        u.lightMat.color.setHex(blink ? (o.accent2 ?? o.accent) : o.idle);
      });
      if (a.t >= SWAP_MS + 120 * (g.units.length - 1)) {
        g.units.forEach((u) => (u.swapped = false));
        g.anim = null;
        if (o.onSwap) o.onSwap(g.kind, moduleName(g.kind));
      }
    }
  }

  // Gate line: four arches whose lintels light as a card passes.
  const gates = STATIONS.filter((s) => s.gate).map((st) => {
    const g = new THREE.Group();
    g.position.set(st.x, 0, st.z);
    world.add(g);
    edges(box(0.22, 1.5, 0.22, mat.body, 0, 0, -0.75, g));
    edges(box(0.22, 1.5, 0.22, mat.body, 0, 0, 0.75, g));
    const lintelMat = glow(o.idle, 0.6);
    const lintel = box(0.3, 0.22, 1.75, lintelMat, 0, 1.5, 0, g);
    const aura = o.bloom ? halo(o.accent, 2.6, lintel) : null;
    hit(st, 0.9, 1.9, 2);
    return { id: st.id, lintelMat, aura, flash: 0, color: new THREE.Color(o.accent) };
  });

  // Review station: a tower with a scanning ring.
  const review = station('review');
  edges(box(1.5, 1.9, 1.5, mat.body, review.x, 0, -1.4));
  const ringMat = glow(o.accent, 0.4);
  const ring = new THREE.Mesh(keep(new THREE.TorusGeometry(0.62, 0.05, 6, 32)), ringMat);
  ring.position.set(review.x, 1.1, 0);
  ring.rotation.x = Math.PI / 2;
  world.add(ring);
  edges(box(1.5, 0.12, 1.5, mat.bodyLight, review.x, 0, 0));
  hit(review, 1.8, 2.2, 3.4);

  // Outbound dock: the pull requests stack up here.
  const outbound = station('outbound');
  edges(box(2.0, 0.35, 2.6, mat.body, outbound.x, 0, 0));
  hit(outbound, 2.2, 1.6, 2.8);
  const prs = [];
  const prAura = o.bloom ? halo(prColor, 3, world) : null;
  if (prAura) prAura.position.set(outbound.x, 0.8, 0.5);

  // Mono captions lying along the floor's front and right edges (the camera sits on +x, +z).
  if (o.edgeLabels) {
    const ink = o.accent2 ?? o.edge;
    const caption = (text, x, z, alongZ, h = 0.3) => {
      const t = own(textTexture(text, o.monoFont, ink));
      const w = (h * t.image.width) / t.image.height;
      const m = new THREE.Mesh(keep(new THREE.PlaneGeometry(w, h)), own(new THREE.MeshBasicMaterial({ map: t, transparent: true, opacity: 0.9, depthWrite: false })));
      m.rotation.order = 'YXZ';
      m.rotation.set(-Math.PI / 2, alongZ ? Math.PI / 2 : 0, 0);
      // x, z mark where the text starts; it runs along +x, or along -z on the right edge.
      m.position.set(alongZ ? x : x + w / 2, 0.006, alongZ ? z - w / 2 : z);
      world.add(m);
    };
    if (!o.modules) caption('INTAKE · ISSUES IN', -11.0, 4.86);
    caption('CELLS · ONE CONTAINER PER CARD', -7.1, 4.86);
    caption('GATES · TESTS / TYPES / SECRETS / SPEC', -1.9, 4.86);
    caption('REVIEW · FRESH CONTEXT', 5.6, 4.86);
    caption('PR · OPENED BY THE HOST · YOU MERGE', 10.8, 4.9, true);
    caption('TASKCELL · FACTORY FLOOR', 10.8, -1.6, true);
  }

  // Conduits: flat strips with moving dashes between stations.
  const conduitMats = [];
  const conduit = (x1, z1, x2, z2) => {
    const len = Math.hypot(x2 - x1, z2 - z1);
    const t = flow.clone();
    t.needsUpdate = true;
    t.repeat.set(len / 0.9, 1);
    const m = new THREE.MeshBasicMaterial({ map: t });
    const mesh = new THREE.Mesh(keep(new THREE.PlaneGeometry(len, 0.14)), m);
    mesh.rotation.x = -Math.PI / 2;
    mesh.rotation.z = -Math.atan2(z2 - z1, x2 - x1);
    mesh.position.set((x1 + x2) / 2, 0.012, (z1 + z2) / 2);
    world.add(mesh);
    conduitMats.push(t);
  };
  CELL_Z.forEach((z) => {
    conduit(intake.x + 1.1, 0, CELL_X - 1.6, z);
    conduit(CELL_X + 1.0, z, -3.0, 0);
  });
  conduit(-3.0, 0, outbound.x - 1.0, 0);

  // ---------- cards ----------
  const cardGeo = keep(new THREE.BoxGeometry(0.8, 0.06, 0.56));
  const fillGeo = keep(new THREE.BoxGeometry(0.7, 0.03, 0.12));
  fillGeo.translate(0.35, 0, 0);
  const trackMat = own(new THREE.MeshBasicMaterial({ color: o.idle }));
  let nextId = 41;
  const cards = [];
  let lineBusy = null;
  let opened = 0;

  function makeCard() {
    const g = new THREE.Group();
    const body = new THREE.Mesh(cardGeo, mat.card.clone());
    g.add(body);
    const track = new THREE.Mesh(fillGeo, trackMat);
    track.position.set(-0.35, 0.045, 0.14);
    g.add(track);
    const fillMat = new THREE.MeshBasicMaterial({ color: o.accent });
    const fill = new THREE.Mesh(fillGeo, fillMat);
    fill.position.set(-0.35, 0.05, 0.14);
    fill.scale.x = 0.001;
    g.add(fill);
    // Per-card glow, disposed with the card (not via `own`, which lives as long as the scene).
    const aura = o.bloom ? new THREE.Sprite(new THREE.SpriteMaterial({ map: haloTex, color: o.accent, ...add, opacity: 0 })) : null;
    if (aura) {
      aura.scale.set(1.5, 1.5, 1);
      g.add(aura);
    }
    world.add(g);
    body.userData.card = nextId;
    return { id: nextId++, g, body, fill, fillMat, aura, charge: 0, shown: 0, red: 0, path: [], seg: 0, t: 0, dur: 0, state: 'new', cell: null, wait: 0, fails: 0, stage: 'intake' };
  }

  const at = (x, z, y = 0.38, stage) => ({ p: new THREE.Vector3(x, y, z), stage });
  function routeToCell(c) {
    const z = cells[c.cell].z;
    c.path = [at(intake.x, 0, 0.42, 'intake'), at(CELL_X - 1.7, z, 0.38, 'cell'), at(CELL_X + 0.2, z, 0.3, 'cell')];
  }
  function routeToGates(c) {
    const z = cells[c.cell].z;
    c.path = [at(CELL_X + 0.2, z, 0.3, 'cell'), at(-3.0, 0, 0.38, 'line'), ...gates.map((g) => at(station(g.id).x, 0, 0.38, g.id)), at(review.x, 0, 0.5, 'review'), at(outbound.x, 0, 0.42, 'outbound')];
  }
  function startPath(c) {
    c.seg = 0;
    c.t = 0;
    setDur(c);
  }
  function setDur(c) {
    const a = c.path[c.seg].p;
    const b = c.path[c.seg + 1].p;
    c.dur = o.beat * Math.min(1.6, Math.max(0.6, a.distanceTo(b) / 2));
  }

  function spawn() {
    const free = cells.findIndex((x) => !x.card);
    if (free < 0) return;
    const c = makeCard();
    c.cell = free;
    cells[free].card = c;
    routeToCell(c);
    c.g.position.copy(c.path[0].p);
    c.state = 'toCell';
    startPath(c);
    cards.push(c);
  }

  function arrive(c, node) {
    c.stage = node.stage;
    const gate = gates.find((g) => g.id === node.stage);
    if (gate) {
      const pass = c.fails >= 1 || rand() > o.failRate;
      gate.flash = 1;
      gate.color.set(pass ? o.accent : o.fail);
      if (gate.aura) gate.aura.material.color.copy(gate.color);
      if (pass) {
        c.charge = Math.min(1, c.charge + 0.25);
        return true;
      }
      c.fails += 1;
      c.red = 1;
      c.charge = 0;
      // Back to its cell for a repair.
      const z = cells[c.cell].z;
      c.path = [at(node.p.x, 0, 0.38, node.stage), at(-3.0, 0, 0.38, 'line'), at(CELL_X + 0.2, z, 0.3, 'cell')];
      c.state = 'back';
      startPath(c);
      return false;
    }
    if (node.stage === 'review') c.wait = o.beat * 1.4;
    return true;
  }

  function addPR() {
    const pr = new THREE.Mesh(cardGeo, new THREE.MeshStandardMaterial({ color: o.dark, emissive: prColor, emissiveIntensity: 0.55 }));
    pr.position.set(outbound.x, 0.4 + prs.length * 0.09, 0.5);
    world.add(pr);
    prs.push(pr);
    if (prs.length > 7) {
      const old = prs.shift();
      world.remove(old);
      old.material.dispose();
      prs.forEach((p, i) => (p.position.y = 0.4 + i * 0.09));
    }
  }
  function emitPR(c) {
    opened += 1;
    addPR();
    world.remove(c.g);
    c.body.material.dispose();
    c.fillMat.dispose();
    if (c.aura) c.aura.material.dispose();
    cells[c.cell].card = null;
    cards.splice(cards.indexOf(c), 1);
    if (followId === c.id) follow(null);
  }

  // ---------- simulation step ----------
  const idleLintel = new THREE.Color(o.idle);
  let spawnIn = 300;
  function update(dt, time) {
    updateModules(dt);
    if (demo) {
      demoIn -= dt;
      if (demoIn <= 0) {
        swap(demoTurn++ % 2 ? 'source' : 'engine');
        demoIn = o.demoEvery;
      }
    }
    spawnIn -= dt;
    if (spawnIn <= 0) {
      spawn();
      spawnIn = o.beat * 3.2;
    }
    for (const c of [...cards]) {
      if (c.wait > 0) {
        c.wait -= dt;
      } else if (c.state === 'working') {
        c.work -= dt;
        if (c.work <= 0 && !lineBusy) {
          lineBusy = c;
          routeToGates(c);
          c.state = 'line';
          startPath(c);
        }
      } else if (c.path.length > 1) {
        c.t += dt / c.dur;
        const a = c.path[c.seg].p;
        const b = c.path[c.seg + 1].p;
        c.g.position.lerpVectors(a, b, ease(Math.min(1, c.t)));
        if (c.t >= 1) {
          c.seg += 1;
          c.t = 0;
          const node = c.path[c.seg];
          const ok = c.state === 'line' ? arrive(c, node) : true;
          if (!ok) {
            if (lineBusy === c) lineBusy = null;
          } else if (c.seg >= c.path.length - 1) {
            if (c.state === 'toCell' || c.state === 'back') {
              c.work = o.beat * (c.state === 'back' ? 2 : 2.6 + rand() * 2.4);
              c.state = 'working';
              c.stage = 'cell';
              c.path = [];
            } else if (c.state === 'line') {
              lineBusy = null;
              emitPR(c);
              continue;
            }
          } else {
            setDur(c);
          }
        }
      }
      c.shown += (c.charge - c.shown) * Math.min(1, dt / 220);
      c.fill.scale.x = Math.max(0.001, c.shown);
      c.red = Math.max(0, c.red - dt / 500);
      c.body.material.emissive.setHex(o.fail);
      c.body.material.emissiveIntensity = c.red * 1.4;
      if (c.aura) {
        // Glows while it travels, brighter as it charges; red while a failed gate pulses.
        c.aura.material.color.setHex(c.red > 0.05 ? o.fail : o.accent);
        c.aura.material.opacity = Math.max(c.red * 0.9, c.state === 'working' ? 0 : 0.25 + c.shown * 0.4);
      }
    }
    cells.forEach((cell) => {
      const busy = cell.card && cell.card.state === 'working';
      cell.agentMat.emissiveIntensity = busy ? 0.6 + 0.5 * Math.sin(time / 260 + cell.phase) : 0.15;
      if (cell.aura) cell.aura.material.opacity = busy ? 0.35 + 0.25 * Math.sin(time / 260 + cell.phase) : 0;
    });
    gates.forEach((g) => {
      g.flash = Math.max(0, g.flash - dt / 700);
      g.lintelMat.emissive.copy(g.flash > 0 ? g.color : idleLintel);
      g.lintelMat.emissiveIntensity = 0.6 + g.flash * 1.6;
      if (g.aura) g.aura.material.opacity = g.flash * 0.8;
    });
    if (prAura) prAura.material.opacity = prs.length ? 0.3 : 0;
    ring.rotation.z += dt * (lineBusy && lineBusy.stage === 'review' ? 0.006 : 0.0012);
    conduitMats.forEach((t) => (t.offset.x -= dt / 1400));
  }

  // ---------- still tableau (reduced motion, phones before play) ----------
  function tableau() {
    [0, 1, 2].forEach((i) => {
      const c = makeCard();
      c.cell = i;
      cells[i].card = c;
      c.state = 'working';
      c.work = 1e9;
      c.g.position.set(CELL_X + 0.2, 0.3, cells[i].z);
      cards.push(c);
    });
    const c = makeCard();
    c.cell = 3;
    cells[3].card = c;
    c.charge = c.shown = 0.5;
    c.fill.scale.x = 0.5;
    c.g.position.set(station('secrets').x - 0.9, 0.38, 0);
    cards.push(c);
    gates[0].flash = gates[1].flash = 0.6;
    for (let i = 0; i < 3; i++) addPR();
    update(16, 0);
  }

  // ---------- camera, sizing ----------
  const size = { w: 1, h: 1 };
  function frame() {
    const aspect = size.w / size.h;
    let half = Math.max(o.halfHeight, (panel ? 9.4 : o.fit) / aspect);
    half /= view.zoom;
    camera.left = -half * aspect;
    camera.right = half * aspect;
    camera.top = half;
    camera.bottom = -half;
    const az = THREE.MathUtils.degToRad(view.az + view.dAz);
    const el = THREE.MathUtils.degToRad(view.el + view.dEl);
    const r = 60;
    camera.position.set(view.target.x + r * Math.cos(el) * Math.sin(az), view.target.y + r * Math.sin(el), view.target.z + r * Math.cos(el) * Math.cos(az));
    camera.lookAt(view.target);
    camera.updateProjectionMatrix();
  }
  function resize() {
    const r = container.getBoundingClientRect();
    size.w = Math.max(1, r.width);
    size.h = Math.max(1, r.height);
    renderer.setSize(size.w, size.h, false);
    frame();
    draw();
  }

  // ---------- labels ----------
  const layer = document.createElement('div');
  layer.className = 'fs-labels';
  container.append(layer);
  const tip = document.createElement('p');
  tip.className = 'fs-tip';
  tip.setAttribute('role', 'status');
  tip.hidden = true;
  layer.append(tip);
  const labels = o.labels
    ? STATIONS.map((st) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'fs-label';
        b.dataset.station = st.id;
        const nm = document.createElement('span');
        nm.className = 'fs-name';
        nm.textContent = st.name;
        const stat = document.createElement('span');
        stat.className = 'fs-stat';
        b.append(nm, stat);
        b.setAttribute('aria-describedby', 'fs-tip-' + st.id);
        const d = document.createElement('span');
        d.id = 'fs-tip-' + st.id;
        d.className = 'fs-sr';
        d.textContent = st.detail;
        b.append(d);
        b.addEventListener('mouseenter', () => showTip(st.id));
        b.addEventListener('focus', () => showTip(st.id));
        b.addEventListener('mouseleave', () => showTip(null));
        b.addEventListener('blur', () => showTip(null));
        layer.append(b);
        return { st, el: b, stat: b.querySelector('.fs-stat'), anchor: new THREE.Vector3(st.x, st.gate ? 2.2 : st.id === 'review' ? 2.5 : st.id === 'egress' ? 2.3 : 1.7, st.z), last: '' };
      })
    : [];
  // Module labels: mono captions under the source module and the cells; a click swaps the module.
  const moduleLabels = o.labels
    ? Object.values(groups).map((g) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'fs-module';
        b.addEventListener('click', () => {
          demo = false;
          swap(g.kind);
        });
        layer.append(b);
        const anchor = g.kind === 'source' ? new THREE.Vector3(intake.x - 1.1, 0, 1.6) : new THREE.Vector3(CELL_X, 0.2, CELL_Z[3] + 0.95);
        return { g, el: b, anchor, last: '' };
      })
    : [];

  let tipFor = null;
  function showTip(id) {
    tipFor = id;
    labels.forEach((l) => l.el.classList.toggle('on', l.st.id === id));
    if (!id) {
      tip.hidden = true;
      return;
    }
    tip.textContent = station(id).detail;
    tip.hidden = false;
    placeTip();
  }
  const v = new THREE.Vector3();
  function toScreen(p) {
    v.copy(p).project(camera);
    return [((v.x + 1) / 2) * size.w, ((1 - v.y) / 2) * size.h];
  }
  function placeLabels() {
    for (const m of moduleLabels) {
      const [x, y] = toScreen(m.anchor);
      m.el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) translate(-50%, 6px)`;
      const name = moduleName(m.g.kind);
      const text = `${m.g.kind} · ${name}`.toUpperCase();
      if (text !== m.last) {
        m.el.textContent = text;
        m.el.setAttribute('aria-label', `Swap the ${m.g.kind}, now ${name}`);
        m.last = text;
      }
      m.el.classList.toggle('swapping', !!m.g.anim);
    }
    for (const l of labels) {
      const [x, y] = toScreen(l.anchor);
      l.el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) translate(-50%, -100%)`;
      const s = statFor(l.st.id);
      if (s !== l.last) {
        l.stat.textContent = s;
        l.last = s;
      }
    }
    placeTip();
  }
  function placeTip() {
    if (!tipFor) return;
    const l = labels.find((x) => x.st.id === tipFor);
    const anchor = l ? l.anchor : new THREE.Vector3(station(tipFor).x, 1.6, station(tipFor).z);
    const [x, y] = toScreen(anchor);
    const w = Math.min(280, size.w - 32);
    tip.style.width = w + 'px';
    tip.style.transform = `translate(${Math.round(Math.min(size.w - w - 16, Math.max(16, x - w / 2)))}px, ${Math.round(y + 12)}px)`;
  }
  function statFor(id) {
    if (id === 'cells') return `${cells.filter((c) => c.card).length} of 4 busy`;
    if (id === 'outbound') return opened ? `${opened} opened` : '';
    if (id === 'review') return lineBusy && lineBusy.stage === 'review' ? `TC-${lineBusy.id}` : '';
    const g = gates.find((x) => x.id === id);
    if (g && lineBusy && lineBusy.stage === id) return `TC-${lineBusy.id}`;
    return '';
  }

  // ---------- follow a card ----------
  let followId = null;
  function follow(id) {
    followId = id;
    goal.zoom = id ? 1.7 : 1;
    if (!id) goal.target.set(o.target[0], 0, o.target[1]);
    if (o.onFollow) o.onFollow(id ? `TC-${id}` : null);
  }
  function followInfo() {
    const c = cards.find((x) => x.id === followId);
    if (!c) return null;
    const names = { intake: 'arriving', cell: 'in its cell', line: 'heading to the gates', review: 'in review', outbound: 'opening the PR', tests: 'at tests', types: 'at types', secrets: 'at the secret scan', spec: 'at spec conformance' };
    return `TC-${c.id} · ${names[c.stage] || c.stage} · ${Math.round(c.charge * 100)}% charged`;
  }

  // ---------- pointer: hover, drag to orbit, click to follow ----------
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let drag = null;
  let lastInput = performance.now();
  const canvas = renderer.domElement;
  const pick = (e, list) => {
    const r = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    return ray.intersectObjects(list, false)[0];
  };
  function onDown(e) {
    demo = false;
    drag = { x: e.clientX, y: e.clientY, az: view.dAz, el: view.dEl, moved: false };
    lastInput = performance.now();
  }
  function onMove(e) {
    lastInput = performance.now();
    if (drag && e.buttons) {
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
      view.dAz = Math.max(-12, Math.min(12, drag.az - dx * 0.06));
      view.dEl = Math.max(-6, Math.min(8, drag.el + dy * 0.04));
      frame();
      if (!running) draw();
      return;
    }
    if (e.pointerType !== 'mouse') return;
    if (moduleHits.length && pick(e, moduleHits)) {
      canvas.style.cursor = 'pointer';
      return;
    }
    const h = pick(e, hits);
    const id = h ? h.object.userData.station : null;
    canvas.style.cursor = h ? 'help' : 'grab';
    if (id !== tipFor) showTip(id);
  }
  function onUp(e) {
    if (drag && !drag.moved) {
      const m = moduleHits.length && pick(e, moduleHits);
      if (m) {
        swap(m.object.userData.module);
        drag = null;
        return;
      }
      const h = pick(e, cards.map((c) => c.body));
      follow(h ? h.object.userData.card : null);
    }
    drag = null;
  }
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointerleave', () => {
    drag = null;
    if (tipFor && !layer.contains(document.activeElement)) showTip(null);
  });
  const onKey = (e) => e.key === 'Escape' && followId && follow(null);
  window.addEventListener('keydown', onKey);

  // ---------- loop: 60 fps while used, 30 fps when idle, paused off-screen or hidden ----------
  let running = false;
  let raf = 0;
  let prev = 0;
  let clock = 0;
  function draw() {
    renderer.render(scene, camera);
    placeLabels();
  }
  function tick(now) {
    if (!running) return;
    raf = requestAnimationFrame(tick);
    const idle = now - lastInput > 4000 || !document.hasFocus();
    const min = idle ? 1000 / 30 : 1000 / 60;
    if (now - prev < min - 2) return;
    const dt = Math.min(100, now - prev || 16);
    prev = now;
    clock += dt;
    update(dt, clock);
    const c = followId && cards.find((x) => x.id === followId);
    if (c) goal.target.set(c.g.position.x, 0, c.g.position.z);
    view.target.lerp(goal.target, Math.min(1, dt / 260));
    view.zoom += (goal.zoom - view.zoom) * Math.min(1, dt / 260);
    frame();
    draw();
    if (followId && o.onFollow) o.onFollow(followInfo());
  }
  let visible = true;
  let wanted = false;
  const io = new IntersectionObserver(([e]) => {
    visible = e.isIntersecting;
    sync();
  });
  io.observe(container);
  const onVis = () => sync();
  document.addEventListener('visibilitychange', onVis);
  function sync() {
    const go = wanted && visible && !document.hidden;
    if (go && !running) {
      running = true;
      prev = performance.now();
      raf = requestAnimationFrame(tick);
    } else if (!go && running) {
      running = false;
      cancelAnimationFrame(raf);
    }
  }
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();

  return {
    /** Runs the simulation (paused automatically when off-screen or in a hidden tab). */
    start() {
      wanted = true;
      sync();
    },
    stop() {
      wanted = false;
      sync();
    },
    /** One static frame: cards in the cells, one at the secret scan, three PRs out. */
    still() {
      wanted = false;
      sync();
      if (!cards.length) tableau();
      frame();
      draw();
    },
    /** Swaps a module (`source` or `engine`) to the next option, or to the one named `to`. */
    swap(kind, to) {
      demo = false;
      swap(kind, to);
    },
    /** Draws one frame `ms` into a swap of `kind` to `to`, without running the loop (for stills and posters). */
    swapFrame(kind, to, ms) {
      const g = groups[kind];
      if (!g) return;
      demo = false;
      const next = Math.max(0, g.options.findIndex((n) => n.toLowerCase() === String(to).toLowerCase()));
      g.anim = { t: 0, next };
      updateModules(ms);
      frame();
      draw();
    },
    follow,
    destroy() {
      wanted = false;
      sync();
      io.disconnect();
      ro.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('keydown', onKey);
      geos.forEach((g) => g.dispose());
      owned.forEach((x) => x.dispose());
      cards.forEach((c) => c.aura && c.aura.material.dispose());
      flow.dispose();
      conduitMats.forEach((t) => t.dispose());
      renderer.dispose();
      container.replaceChildren();
    },
  };
}
