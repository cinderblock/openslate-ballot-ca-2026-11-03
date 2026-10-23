// What every scraper in this repo shares: the guide format's structural types, fetching, the
// ballot source's races, and matching a printed candidate name to the ballot's spelling.

// Structural types of the OpenSlate guide format (`@openslate/core` guide.ts); `openslate guide
// check` validates the output against the real schema.
export type Inline = string | { em: Inline[] } | { strong: Inline[] };
export type Block =
  | { type: "h"; level: 2 | 3 | 4; text: Inline[] }
  | { type: "p"; text: Inline[] }
  | { type: "ul" | "ol"; items: Block[][] }
  | { type: "table"; caption?: string; rows: { header?: boolean; text: Inline[] }[][] }
  | { type: "img"; file: string; alt?: string };
export interface Passage {
  title?: string;
  by?: string;
  blocks: Block[];
  source: string;
  disclaimer?: string;
}
export interface Subject {
  title: string;
  kind?: string;
  jurisdiction?: string;
  election?: string;
}
export interface Signer {
  name: string;
  title?: string;
  organization?: string;
}
export interface Argument {
  side: string;
  rebuttal: boolean;
  title?: string;
  blocks: Block[];
  signers: Signer[];
  footnote?: string;
  paid?: boolean;
  funding?: string;
  source: string;
  disclaimer?: string;
}
export interface GuideDocument {
  title: string;
  file?: string;
  source: string;
  mediaType: string;
  page?: number;
  sha256?: string;
}
export interface Item {
  v: 1;
  subject: Subject;
  retrieved_at: string;
  about?: Passage;
  candidates?: {
    choice: string;
    photo?: { file: string; alt?: string; source: string; credit?: string };
    statement?: Passage;
    contact?: string[];
  }[];
  means?: Record<string, Passage>;
  summary?: Passage;
  analysis?: Passage;
  arguments?: Argument[];
  fullText?: Passage;
  documents?: GuideDocument[];
}

export const ELECTION = "2026-11-03";

/** Now, as RFC 3339 in UTC to the second. */
export function now(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export async function fetchOk(
  url: string,
  userAgent = "openslate-ballot-scraper",
): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(url, { headers: { "user-agent": userAgent } });
    if (response.ok) return response;
    if (attempt >= 3 || response.status < 500) throw new Error(`${url}: HTTP ${response.status}`);
    await Bun.sleep(1000 * attempt);
  }
}

/** Lowercase hex SHA-256. */
export function sha256Hex(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

// ---------------------------------------------------------------- the ballot source's subjects

export interface BallotRace {
  subject: Subject;
  choices: string[];
}

/**
 * Races (by title) from a ballot source's positions.json in the public endorsements catalog, or
 * from a local copy (a path), e.g. a ballot source not yet published.
 */
export async function loadRaces(url: string): Promise<Map<string, BallotRace>> {
  const source = (
    /^https?:/.test(url) ? await (await fetchOk(url)).json() : await Bun.file(url).json()
  ) as {
    positions: { subject: Subject; choice?: string }[];
  };
  const races = new Map<string, BallotRace>();
  for (const position of source.positions) {
    const race = races.get(position.subject.title) ?? { subject: position.subject, choices: [] };
    if (position.choice && !race.choices.includes(position.choice))
      race.choices.push(position.choice);
    races.set(position.subject.title, race);
  }
  return races;
}

/** The catalog's ballot source for an election authority, by its directory name. */
export function ballotSourceUrl(org: string): string {
  return `https://cinderblock.github.io/openslate-public-endorsements/orgs/${org}/${ELECTION}/positions.json`;
}

export function normName(name: string): string {
  return (
    name
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[.,"“”]/g, "")
      // "O’DONNELL" and "O'Donnell" are one name.
      .replace(/[‘’]/g, "'")
      // "Bove-LaMonica" and "Bove LaMonica" are one name.
      .replace(/-/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

const SUFFIX = /^(jr|sr|ii|iii|iv)$/;
/**
 * Honorifics and credentials printed around a name ("DR. JUDY PATACSIL", "LINDA C GREER RN",
 * "TARA BOYCE MBA"), and a nickname in parentheses ("CHARANDEEP SINGH TATLAH (VICK)").
 */
const TITLE = /^(dr|mr|mrs|ms|rn|md|phd|edd|jd|mba|esq|cpa|dds)$|^\(.*\)$/;

/**
 * The ballot's spelling of a name printed in a guide: exact, else first and last name, else
 * (for a guide that prints a nickname or a middle name the ballot leaves out) the one choice
 * with that last name.
 */
export function matchChoice(name: string, choices: string[]): string | undefined {
  const want = normName(name);
  const exact = choices.find((c) => normName(c) === want);
  if (exact) return exact;
  const parts = (n: string) => n.split(" ").filter((p) => !SUFFIX.test(p) && !TITLE.test(p));
  const ends = (n: string) => {
    const p = parts(n);
    return `${p[0]} ${p.at(-1)}`;
  };
  const loose = choices.filter((c) => ends(normName(c)) === ends(want));
  if (loose.length === 1) return loose[0];
  const last = parts(want).at(-1);
  const byLast = choices.filter((c) => parts(normName(c)).at(-1) === last);
  if (byLast.length === 1) return byLast[0];
  // A surname printed in two words ("MATTHEW MC KELL" for "Matthew C. McKell").
  const joined = parts(want).slice(-2).join("");
  const byJoined = choices.filter((c) => parts(normName(c)).at(-1) === joined);
  if (byJoined.length === 1) return byJoined[0];
  // Credentials after a comma ("MARY GWIN, PH. D.", "KATHLEEN COATES HEDBERG, PE, MPH").
  const comma = name.indexOf(",");
  return comma > 0 ? matchChoice(name.slice(0, comma), choices) : undefined;
}

export function slug(text: string): string {
  return normName(text)
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
