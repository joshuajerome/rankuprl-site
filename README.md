# rankuprl-site

Public landing page + privacy policy + terms of use for the
[RankupRL](https://github.com/joshuajerome/RankupRL) desktop app.
Lives in its own repo so the app's source code can stay private
while still satisfying the public-URL requirements of OAuth
provider portals (Epic Account Services, Steam Web API).

**Live site:** <https://joshuajerome.github.io/rankuprl-site/>

## Files

| File | Purpose |
|---|---|
| `index.html` | Landing page — describes the app, links to legal pages |
| `privacy.html` | Privacy policy |
| `terms.html` | Terms of use |
| `style.css` | Shared styling (Russo One + Chakra Petch, dark theme to match the app) |

## Local preview

No build step — open `index.html` in a browser or serve the dir
statically:

```bash
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Deployment

GitHub Pages serves the `main` branch root automatically. Push
to `main` and the live site updates within a minute or two.

## Future work

A richer immersive version (Three.js scene, scroll-triggered
animations, possibly a small interactive demo) is tracked in the
main RankupRL repo's `docs/dev/next-actions.md` as a polish-phase
item. This minimal version is intentionally stripped down so it
ships in 5 minutes and clears OAuth-portal review without any
extra moving parts.
