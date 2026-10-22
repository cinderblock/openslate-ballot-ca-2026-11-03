# OpenSlate voter guide: California, November 3, 2026

California's **Official Voter Information Guide** for the November 3, 2026
general election, mirrored as a signed [OpenSlate](https://github.com/cinderblock/openslate)
*guide* and published to GitHub Pages for the [OpenSlate app](https://openslate.us).

It holds what the California Secretary of State published about each race and
measure on the statewide ballot:

- **Candidates for statewide office** (Governor through Superintendent of Public
  Instruction, and the Board of Equalization): each candidate's statement and
  photo. Only candidates who accepted the voluntary spending limits could buy a
  statement, and some who could chose not to.
- **Propositions**: the summary, what a Yes and a No vote mean, the Attorney
  General's official title and summary, the Legislative Analyst's analysis, the
  arguments and rebuttals with their signers, and the text of the proposed law
  (the original PDF).
- **Justices up for retention**: each Supreme Court justice's statement of
  qualifications, and each Court of Appeal justice's official biography link.

This is **reference material, not endorsements.** Candidate statements and
ballot arguments are their authors' own words. As the guide itself says, they
"have not been checked for accuracy by any official agency"; each passage keeps
that caveat with it.

## How it works

- `scripts/scrape-ca-vig.ts` reads voterguide.sos.ca.gov and writes `guide/`.
  Race and measure titles come from the CA Secretary of State *ballot source* in
  the [public endorsements catalog](https://github.com/cinderblock/openslate-public-endorsements),
  so each item lines up with a race the app already shows. Every page it read is
  kept under `evidence/` with when it was fetched (`evidence/index.json`).
- `guide/` is the source of truth: `guide.json` (whose material this is),
  `items/*.json` (one per race or measure), and the photos, figures and PDFs
  they point at, mirrored from the Secretary of State.
- On every push to the default branch, CI hashes every file under `guide/`
  into a manifest, signs it (`openslate guide sign`) with this repo's own key,
  checks the result against `keys/guide-public.json`, and publishes to Pages.
  The private key lives only in the `OPENSLATE_GUIDE_SIGNING_KEY` Actions
  secret; it was generated straight into that secret and has never been on disk.
- The app finds this guide through the public endorsements catalog, which lists
  its URL and key. It fetches the manifest, checks the signature and key, then
  fetches only the items and files a race page needs, checking each one's hash.

Why mirror rather than link: the guide's site doesn't allow other sites to read
it from a browser (no CORS), its pages move to an archive after the election,
and linking its images would tell the Secretary of State who is reading what.

## Updating

```sh
bun install
bun run fetch-openslate      # clones OpenSlate at .openslate-version into .openslate/
bun run scrape               # rebuild guide/ from the evidence cache
bun run scrape -- --refresh  # fetch every page and file again
bun run check                # validate every item and the files it names
```

Then commit `guide/` and `evidence/` and push. The scraper exits non-zero and
lists the problems when a guide page names a candidate or justice the ballot
source doesn't have.

## Published URLs

| URL | What it is |
| --- | --- |
| `index.html` | Human-readable list of every item |
| `guide.jws` | The signed manifest (`typ: openslate-guide+jws`) |
| `items/<name>.json` | One race or measure |
| `img/…`, `pdf/…` | Mirrored photos, figures and full texts |
| `keys/guide-public.json` | This guide's public signing key |

## Another election

This repo is a GitHub template. For the next California election, create
`openslate-ballot-ca-<election>` from it, change `ELECTION` in the scraper,
generate a new key into the new repo's secret, and add the new guide to the
endorsements catalog's `guides.json`.

## License

Code: MIT. The guide's content is the California Secretary of State's, and its
authors' (candidates, argument signers, the Attorney General and the
Legislative Analyst); it is mirrored verbatim and credited for voter education.
