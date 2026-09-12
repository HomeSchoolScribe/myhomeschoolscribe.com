# www.myhomeschoolscribe.com

The public site for HomeSchool Scribe. Plain HTML and CSS, no build step, hosted on GitHub Pages.

## Pages

| File | What it is |
|---|---|
| `index.html` | Home: the launch intro, how it works, records, state picker, Student Mode, pricing, privacy summary. |
| `privacy.html` | The privacy policy. Generated from `../docs/PRIVACY.md` by `design/_tools/build_website.py` (which writes every page); edit the Markdown, then re-run it. App Store Connect links here. |
| `support.html` | Support address and common questions. App Store Connect links here. |
| `404.html` | GitHub Pages serves this for unknown addresses. |
| `assets/site.css` | All styles. Tokens follow `design/homeschool-scribe-identity`. |
| `assets/fonts/` | Bitter, Source Sans 3, IBM Plex Mono (self-hosted, OFL licensed; licenses alongside). |
| `assets/img/` | Logo SVGs, screenshots cropped to the phone, app icon. |
| `assets/press/` | Press assets. Kept, but nothing links to them: the press page is not published (see below). |
| `CNAME` | Tells GitHub Pages the custom domain. Keep it. |
| `.nojekyll` | Turns Jekyll off so files are served exactly as they are. |

## Publishing

The site is served from the public repository `homeschoolscribe/myhomeschoolscribe.com` (branch `main`, root folder). To publish a new version, copy **everything in this folder** (including `CNAME` and `.nojekyll`) to the root of that repository, replacing what is there, and commit. GitHub Pages redeploys in about twenty seconds.

From a terminal, with that repository cloned next to this one:

```bash
rsync -av --delete --exclude .git --exclude .DS_Store \
      --exclude 'assets/social/packets/' website/ ../myhomeschoolscribe.com/
```

**Keep the `assets/social/packets/` exclusion.** Daily social packets are copied straight into the
live repository and deliberately never live in this folder (see
`design/13-AppStore-Marketing/social/packets/*/README.md`). Without the exclusion, `--delete` removes
every packet already published, breaking any post that links to one. This was found on 10 September
2026, one dry run before it happened.

then `git add -A && git commit -m "Update site" && git push` inside that clone.

## The press kit is not published

`press.html` is deliberately absent. Josh, 10 September 2026: it should be "hidden and not accessible
through a link. Not published at all, if possible." The page's source is still in
`design/_tools/build_website.py` with its writer commented out, so bringing it back at launch is one
line; until then nothing generates it, nothing links to it, and it is not in `sitemap.xml`. The files
under `assets/press/` are still there and still reachable by direct URL — delete that folder too if
that matters.

## Before launch

- Replace the "Tell me when it launches" button in `index.html` with the App Store link (there is a comment next to it).
- Update the date line in `privacy.html` whenever the policy changes.
- The screenshots in `assets/img` and `assets/press` come from `design/13-AppStore-Marketing/screenshots`; regenerate them after the next round of UI changes.
