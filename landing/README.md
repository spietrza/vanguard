# taskcell.dev

The landing page for Taskcell. Static HTML, CSS and a little JavaScript in `src/`, no framework and no dependencies. The factory scene in `src/scene/` is a plain ES module that imports a vendored three.js.

## Build and check

```
node build.mjs
```

This copies `src/` to `dist/` and fails if any local reference in the HTML, CSS or JS points at a missing file. Run it after every change.

To look at the page:

```
node build.mjs && python3 -m http.server 4173 -d dist
```

Check it at 1440 px and at phone width (390 px). There must be no horizontal scroll at any width, and touch targets on phones are at least 44 px high.

## Content rules

- Every claim about Taskcell must be true on `main`. Name the release when a feature is not in the latest tag.
- Security wording must match `docs/security/` and `SECURITY.md`. Do not describe how to exploit anything.
- Keep the existing type (Schibsted Grotesk, Atkinson Hyperlegible, IBM Plex Mono), palette tokens in `src/site.css` and the dark theme.

## Deploy

Deployed by hand by a maintainer, never from CI:

```
pnpm run deploy
```

`wrangler.jsonc` serves `dist/` behind `worker.js`, which only redirects `www` to the apex.
