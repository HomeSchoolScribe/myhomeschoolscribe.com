# www.myhomeschoolscribe.com

The public site for HomeSchool Scribe. Plain HTML and CSS, no build step, hosted on GitHub Pages.

## Pages

| File | What it is |
|---|---|
| `index.html` | Home: the launch intro, how it works, records, state picker, Student Mode, pricing, privacy summary. |
| `privacy.html` | The privacy policy. Generated from `../docs/PRIVACY.md` by `design/_tools/build_website.py` (which writes every page); edit the Markdown, then re-run it. App Store Connect links here. |
| `support.html` | Support address and common questions. App Store Connect links here. |
| `press.html` | Boilerplate, logo files, colors, screenshots. |
| `404.html` | GitHub Pages serves this for unknown addresses. |
| `assets/site.css` | All styles. Tokens follow `design/homeschool-scribe-identity`. |
| `assets/fonts/` | Bitter, Source Sans 3, IBM Plex Mono (self-hosted, OFL licensed; licenses alongside). |
| `assets/img/` | Logo SVGs, screenshots cropped to the phone, app icon. |
| `assets/press/` | The downloadable press assets. |
| `CNAME` | Tells GitHub Pages the custom domain. Keep it. |
| `.nojekyll` | Turns Jekyll off so files are served exactly as they are. |

## Publishing

The site is served from the public repository `homeschoolscribe/myhomeschoolscribe.com` (branch `main`, root folder). To publish a new version, copy **everything in this folder** (including `CNAME` and `.nojekyll`) to the root of that repository, replacing what is there, and commit. GitHub Pages redeploys in about twenty seconds.

From a terminal, with that repository cloned next to this one:

```bash
rsync -av --delete --exclude .git website/ ../myhomeschoolscribe.com/
```

then `git add -A && git commit -m "Update site" && git push` inside that clone.

## Before launch

- Replace the "Tell me when it launches" button in `index.html` with the App Store link (there is a comment next to it).
- Update the date line in `privacy.html` whenever the policy changes.
- The screenshots in `assets/img` and `assets/press` come from `design/13-AppStore-Marketing/screenshots`; regenerate them after the next round of UI changes.
