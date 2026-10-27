# OpenSlate voter guides: California, November 3, 2026

California's official voter guides for the November 3, 2026 general election,
each mirrored as a signed [OpenSlate](https://github.com/cinderblock/openslate)
*guide* and published to GitHub Pages for the [OpenSlate app](https://openslate.us):

| Guide | Directory | Published at |
| --- | --- | --- |
| California **Official Voter Information Guide** (Secretary of State) | `guide/` | `/guide.jws` |
| **San Francisco** Voter Information Pamphlet (Department of Elections) | `county/sf/` | `/county/sf/guide.jws` |
| **Los Angeles County** candidate statements and local measures (Registrar-Recorder/County Clerk) | `county/la/` | `/county/la/guide.jws` |
| **Orange County** candidate statements and local measures (Registrar of Voters) | `county/oc/` | `/county/oc/guide.jws` |
| **San Diego County** Voter Information Pamphlets: candidate statements and local measures (Registrar of Voters) | `county/sd/` | `/county/sd/guide.jws` |
| **Alameda County** Voter Information Guide: candidate statements (with Berkeley and Oakland photos) and local measures (Registrar of Voters) | `county/alameda/` | `/county/alameda/guide.jws` |
| **Santa Clara County** Voter Information Guide: candidate statements and local measures (Registrar of Voters) | `county/santa-clara/` | `/county/santa-clara/guide.jws` |
| **San Mateo County** local measures' filed documents, linked (County Elections) | `county/san-mateo/` | `/county/san-mateo/guide.jws` |
| **17 more counties** (Contra Costa, Fresno, Kern, Marin, Monterey, Napa, Placer, Riverside, Sacramento, San Bernardino, San Luis Obispo, Santa Barbara, Santa Cruz, Sonoma, Stanislaus, Ventura, Yolo): local measures' official documents, linked (each county's elections office, or the city clerk) | `county/<county>/` | `/county/<county>/guide.jws` |

Each is its own signed manifest, because each is a different authority's
publication; this repo's one key signs them all.

## The state guide

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

## San Francisco's pamphlet

The pamphlet covers what the state guide doesn't: Congress and the State
Assembly districts in San Francisco, and every local race and measure.

- **Candidates** for US House (11, 15), State Assembly (17, 19), BART District 8,
  and every city and school office: each statement of qualifications, and what
  each office does. SF prints no candidate photos.
- **Local measures** (Propositions A–J) and **Regional Measure RTM**: the
  question and vote threshold, how it got on the ballot, the Ballot
  Simplification Council's digest, what a Yes and a No vote mean, the
  Controller's statement (or, for RTM, the impartial analysis), the official
  arguments and rebuttals, and the **paid arguments**, each with who paid for
  it.
- **Legal text** is linked by page in the original PDF, not extracted: the
  pamphlet marks added and deleted law with drawn underlines and strikethroughs,
  which extracted text would silently lose.

The pamphlet is one 252-page, 7.9 MB PDF, so it isn't committed: the scraper
caches it in `.cache/` and commits its URL, SHA-256, size and retrieval time in
`evidence/county/sf/index.json`. Every passage links to its page of the
original. `scripts/lib/pdf-layout.ts` reads the PDF with pdf.js into lines in
reading order (two columns, full-width headings between), with each run's font,
size and weight.

## Los Angeles County

LA publishes its material as data, so nothing is read from a PDF:

- **Candidate statements** for US House, State Senate and State Assembly
  districts in the county, and every local office (Sheriff, Superior Court,
  City of LA, every city, school, college, water and library district), from
  LA's candidate statements API (`apps.lavote.gov/statements-api`). LA prints
  no candidate photos. Statewide offices and justices are left to the state
  guide.
- **Local measures**: the question, the impartial analysis and the full text,
  from LA's interactive sample ballot data (`isb.lavote.gov/parsed`). The full
  text is kept as text (blocks), not mirrored as an HTML file.

Which race or measure each LA contest is comes from the LA ballot source in
the endorsements catalog (`orgs/la-county-registrar/<election>/contest-subjects.json`),
so the guide files everything under the races the app already shows.

LA's servers sit behind a bot wall that blocks bursts (about 700 quick
requests got this scraper a challenge page). `scripts/scrape-la.ts` goes one
request at a time with a pause and stops at the first challenge page. Raw
responses are cached in `.cache/`; the English text of each, with its URL,
retrieval time and the SHA-256 of what LA sent, is kept under
`evidence/county/la/`.

## Orange County

- **Candidate statements** for US House, State Senate and State Assembly
  districts in the county, the Board of Supervisors, and every city, school,
  college, water and special district: one small PDF per candidate, linked from
  OC's candidate filing log. OC prints no candidate photos.
- **Local measures** (A–O): one PDF each, read for the question, what a Yes and
  a No vote mean, the impartial analysis (with who signed it), and the
  arguments and rebuttals (with their signers). The full text is linked by
  page in the measure's PDF: its tables and amendment markup don't survive
  text extraction.

Which race each contest is, and where each statement lives, come from the OC
ballot source in the endorsements catalog (its `contest-subjects.json` and the
filing log saved in its evidence). OC's measure pages set their two columns
close together (about 8 pt apart), so `scripts/lib/pdf-layout.ts` also splits
a line at a narrower gap when the gap straddles the middle of the page.

## San Diego County

San Diego prints one pamphlet per ballot type (654 of them, 9–13 MB each),
each assembled from shared sections whose code is printed at the foot of every
page (`CS-J03030-1-ENG` for a contest's statements, `PR-Q00001-2-ENG` for a
measure's pages):

- `bun scripts/sd-index.ts` reads each pamphlet's bookmarks through HTTP range
  requests (`scripts/lib/pdf-range.ts`, about 0.6 MB a pamphlet) into
  `evidence/county/sd/ballot-types.json`. It's paced, and resumable: an
  unchanged pamphlet isn't read again. The SD ballot source in the endorsements
  catalog takes its list of measures from this index.
- `bun run scrape:sd` picks the fewest pamphlets whose bookmarks cover every
  contest (67), downloads them into `.cache/` (never committed), and reads each
  section once:
  - **candidate statements** for the US House, State Senate and Assembly
    districts in the county and every local office (San Diego prints no
    candidate photos);
  - **local measures**: the question, what a Yes and a No vote mean, the
    impartial analysis, any tax rate statement, the arguments and rebuttals
    with their signers (set one to a row, or two across), and the full text's
    page.

  It also records each measure's short title, where the pamphlet prints one, in
  `evidence/county/sd/measure-titles.json` for the ballot source.

## Alameda County

From Alameda's one Voter Information Guide for the whole county (about 965
pages; `bun run scrape:alameda`):

- **Candidate statements** for US House, State Senate and State Assembly
  districts in the county, and every city, school, college, transit, water,
  park and special district. Berkeley and Oakland print their candidates'
  statements as a numbered declaration with a photo; those photos are the only
  candidate photos in any county guide here.
- **Local measures** (the regional transit measure RTM and I–II): the
  question, what a Yes and a No vote mean, the impartial analysis (with who
  signed it), any tax rate statement, and the arguments and rebuttals with
  their signers (an organization's signer is "by" someone). The full text is
  linked by page.

Each contest's pages carry a code at their foot ("CD10-1", "RTM-2"); a
statement page goes to the race whose candidates it names in the Alameda
ballot source in the endorsements catalog, a measure to the measure its
heading names. The measure pages are set in fonts pdf.js reads as glyph
numbers ("WUD൶F" for "traffic"), so `pdfPages(…, {repairGlyphFonts: true})`
decodes them, putting back the parentheses pdf.js's text layer turns into
spaces. The photos are stored as ink amounts for one separation, so
`scripts/lib/pdf-images.ts` has pdf.js apply the colour space before encoding
JPEGs (passed through as stored, they'd be negatives).

## Santa Clara County

Santa Clara publishes its guide online through Democracy Live's OmniBallot.
The voter-facing pages want a ballot style and a session, but what they show
is published as static JSON with no session: an index
(`ca.omniballot.us/published/06085/1968/vg/lookups.json`) and one file per
statement and per measure, the text as HTML (the county's own extraction from
its printed guide). `bun run scrape:scc` reads them:

- **Candidate statements** for US House, State Senate and State Assembly
  districts in the county, and every city, school, college, water and special
  district. Santa Clara prints no candidate photos. The index files statements
  by contest; a contest's statements go to the race whose candidates they name
  in the Santa Clara ballot source in the endorsements catalog. Where a lone
  name fits several races, the statement's "Occupation:" (the ballot
  designation) decides, or else the race whose title the statement's own words
  share most; the run lists each such call.
- **Local measures** (the regional transit measure RTM and A–S): the question,
  what a Yes and a No vote mean, the impartial analysis (with any tax rate
  statement), the complete text, and the arguments and rebuttals with their
  signers.

Each passage links to the JSON file it came from: OmniBallot's pages can't be
opened at a statement or measure without a session. The HTML keeps the
extraction's slips as published (one paragraph of RTM's argument starts "'s
clear"). Raw responses are cached in `.cache/`; the English HTML of each, with
its URL, retrieval time, OmniBallot's own `updated_at` and the SHA-256 of what
was sent, is kept under `evidence/county/santa-clara/`.

## San Mateo County

San Mateo prints candidate statements and the typeset measure pages only in
each voter's own pamphlet, which its site opens after a lookup by address and
birthdate. What it publishes openly is the election page
(`smcacre.gov/elections/current-election`), which links each local measure's
filed documents: the resolution placing it on the ballot, the impartial
analysis, and the arguments and rebuttals as submitted (with their submission
forms). Most are scans with no text layer. `bun run scrape:smc` lists them
per measure (the regional transit measure RTM and D–EE):

- A document's measure comes from its title ("Measure R - Impartial
  Analysis"), or for the filings titled by contest ("Burlingame School District
  Bond Measure Argument in Favor"), from `BY_NAME` in the script, reviewed by
  hand. Each title is checked against the file name's own word for what it is
  ("Reso", "ArgInFavor", "RebutArgAgainst"). The run stops if a document fits
  no measure, or a measure on the ballot has no impartial analysis.
- The documents are linked, not mirrored: they come to over 500 MB. Each is
  identified by the SHA-256 of what was retrieved; `evidence/county/san-mateo/index.json`
  keeps the URL, the page's title for it, size, hash and retrieval time.

So San Mateo's guide has no statements and no measure text or signers.

## Linked measure documents (17 more counties)

For counties whose pamphlet nobody has scraped, each local measure in the
endorsements catalog gets the official documents its election authority
publishes, linked rather than mirrored: the full text or the resolution
placing it on the ballot, the impartial analysis, the fiscal or tax rate
statement, and the arguments and rebuttals. Most counties link these from
their election page; for a city's measure, some leave them to the city
clerk, whose page is then the source.

- The links are researched by hand into a table per county,
  `linked/<county>.json`. Every document was opened and checked against its
  own text (the measure, the jurisdiction, the Nov 3, 2026 election, the kind
  of document); each entry's `checked` says what was read. Measures with
  nothing official online are listed under `missing`, with what was tried.
- `bun run link-measures [county …]` fetches each document, records its
  SHA-256 (`evidence/county/<county>/index.json`) and writes
  `county/<county>/`. It stops if a title isn't a measure in the catalog for
  the election (so every item lands on a race the app shows), if a catalog
  measure in a table's jurisdictions is neither linked nor listed as missing,
  or if a document isn't what its table says (a PDF starts with `%PDF`).
- A web page (some counties publish the analysis and arguments as HTML) is
  linked without a hash: its markup changes with every visit.
- Some hosts refuse this script's requests (Monterey's, Kern's and Walnut
  Creek's turn away HTTP/1.1 clients). A document there carries a `manual`
  retrieval: its SHA-256, size, time and how it was fetched (PowerShell's
  `Invoke-WebRequest -HttpVersion 2.0`). The script uses it when refused and
  checks it whenever its own request gets through.

## Not endorsements

This is **reference material, not endorsements.** Candidate statements and
ballot arguments are their authors' own words. As the guide itself says, they
"have not been checked for accuracy by any official agency"; each passage keeps
that caveat with it.

## How it works

- `scripts/scrape-ca-vig.ts` reads voterguide.sos.ca.gov and writes `guide/`;
  `scripts/scrape-sf-vip.ts` reads San Francisco's pamphlet and writes
  `county/sf/`.
  Race and measure titles come from the CA Secretary of State *ballot source* in
  the [public endorsements catalog](https://github.com/cinderblock/openslate-public-endorsements),
  so each item lines up with a race the app already shows. Every page it read is
  kept under `evidence/` with when it was fetched (`evidence/index.json`).
- `guide/` is the source of truth: `guide.json` (whose material this is),
  `items/*.json` (one per race or measure), and the photos, figures and PDFs
  they point at, mirrored from the Secretary of State.
- On every push to the default branch, CI hashes every file of each guide
  (`guide/` and every `county/*/`) into its manifest, signs it
  (`openslate guide sign`) with this repo's own key, checks the result against
  `keys/guide-public.json`, and publishes to Pages.
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
bun run scrape:sf            # rebuild county/sf/ (fetches the pamphlet once)
bun run scrape:la            # rebuild county/la/ (paced; about half an hour uncached)
bun run scrape:oc            # rebuild county/oc/ (about 380 PDFs, a few minutes uncached)
bun run scrape:sd            # rebuild county/sd/
bun run scrape:alameda       # rebuild county/alameda/
bun run scrape:scc           # rebuild county/santa-clara/
bun run scrape:smc           # rebuild county/san-mateo/ (about 530 MB of scans, cached)
bun run link-measures        # rebuild the linked counties' guides from linked/*.json
bun run check                # validate every guide's items and the files they name
bun scripts/sync-subjects.ts # match items' subjects to their ballot sources (dry run; add --apply)
```

Then commit `guide/` and `evidence/` and push. The scraper exits non-zero and
lists the problems when a guide page names a candidate or justice the ballot
source doesn't have.

When the endorsements catalog re-files a race (San Diego County's contests
moved from the City of San Diego's `us/ca/san-diego` to
`us/ca/san-diego-county` on 2026-10-25), `bun scripts/sync-subjects.ts --apply`
gives each item the subject its ballot source now names, without scraping
again; `--catalog <checkout>` reads a local catalog checkout instead of the
published one.

## Published URLs

| URL | What it is |
| --- | --- |
| `index.html` | Human-readable list of every item (also under each `county/<name>/`) |
| `guide.jws` | The state guide's signed manifest (`typ: openslate-guide+jws`) |
| `county/<name>/guide.jws` | A county guide's signed manifest |
| `items/<name>.json` | One race or measure |
| `img/…`, `pdf/…` | Mirrored photos, figures and full texts |
| `keys/guide-public.json` | This guide's public signing key |

## Another election

This repo is a GitHub template. For the next California election, create
`openslate-ballot-ca-<election>` from it, change `ELECTION` in the scraper,
generate a new key into the new repo's secret, and add the new guide to the
endorsements catalog's `guides.json` with the jurisdictions it `covers` (each
item's `subject.jurisdiction`; a county guide covers its congressional and
legislative districts too).

## Another county

Write `scripts/scrape-<county>.ts` that writes `county/<county>/` (a
`guide.json` naming the county's election office, and `items/`), reusing
`scripts/lib/`. Subjects must match a ballot source in the endorsements catalog
exactly, or the app won't find them. Then add the county's entry to
`guides.json` there.

## License

Code: MIT. The guides' content is their publishers' (the California Secretary
of State, the San Francisco Department of Elections) and their authors'
(candidates, argument signers, the Attorney General, the Legislative Analyst,
the Controller, the Ballot Simplification Council); it is mirrored verbatim
and credited for voter education.
