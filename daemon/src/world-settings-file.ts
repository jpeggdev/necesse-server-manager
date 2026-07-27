/**
 * Reader/writer for `<World>/worldSettings.cfg`, the settings file inside a
 * world zip.
 *
 * The file is edited textually, in place: every line is kept exactly as it was
 * read, and an edit rewrites only the character span the value occupies on its
 * own line. That is the whole design, and it is deliberate.
 *
 * A world's settings file carries keys this daemon knows nothing about - the
 * trailing `rpgskills*` entries in a modded world are written by the RPG Skills
 * mod - alongside `//` comments, tab indentation and trailing commas. A
 * serializer that re-emitted the file from a parsed model would have to
 * reproduce all of that byte for byte or silently destroy someone's mod state
 * the first time they touched a form. Splicing a substring cannot lose what it
 * never rewrites, so unknown keys, comments, ordering and whitespace survive by
 * construction rather than by care.
 *
 * For the same reason this type can only ever change the value of a key that is
 * already in the file. It cannot add one. A world whose file has no
 * `maxSettlersPerSettlement` line must not gain one: the game wrote that file,
 * and introducing a field it chose to omit is a change to how the world behaves
 * that nobody asked for.
 */

/** Opens the settings block. Anything before it is preamble and is not parsed. */
const HEADER = /^\s*WORLDSETTINGS\s*=\s*\{\s*$/;
/** Closes it. Anything after it is trailer and is not parsed. */
const CLOSE = /^\s*\}\s*$/;
/** `<indent>key<spaces>=<spaces>`; the value is whatever follows. */
const ASSIGNMENT = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)\s*=\s*/;

/** Where one key's value sits: which line, and which span of that line. */
interface Span {
  key: string;
  line: number;
  start: number;
  end: number;
}

/**
 * Locates the value on one line of the settings block, or null if the line
 * holds no assignment at all (a blank line, a whole-line comment).
 *
 * The value ends before any trailing comma, trailing whitespace, and any `//`
 * comment. The format has no string literals, so the first `//` on a line is
 * always the comment - the game's own parser treats it the same way.
 */
function valueSpan(body: string): Span | null {
  const commentAt = body.indexOf("//");
  const code = commentAt === -1 ? body : body.slice(0, commentAt);
  const m = ASSIGNMENT.exec(code);
  if (m === null) return null;
  const start = m[0].length;
  let end = code.length;
  while (end > start && /\s/.test(code[end - 1])) end--;
  if (end > start && code[end - 1] === ",") end--;
  while (end > start && /\s/.test(code[end - 1])) end--;
  // `key = ,` or `key =` - an assignment with nothing assigned. Left as an
  // uninterpreted line rather than recorded as a key with an empty value,
  // which nothing downstream could do anything sensible with.
  if (end === start) return null;
  return { key: m[2], line: -1, start, end };
}

export class WorldSettingsFile {
  private constructor(
    /** Every source line, each still carrying its own line ending. */
    private readonly lines: string[],
    /** Key -> where its value lives. Insertion order is file order. */
    private readonly spans: Map<string, Span>,
  ) {}

  static parse(text: string): WorldSettingsFile {
    // Split *after* each newline so every element keeps its own terminator and
    // joining them back is the identity. This is what makes CRLF, LF, a
    // missing final newline and a BOM all round-trip without special cases.
    const lines = text.split(/(?<=\n)/);
    const spans = new Map<string, Span>();
    let sawHeader = false;
    let inBlock = false;
    for (let i = 0; i < lines.length; i++) {
      const body = lines[i].replace(/\r?\n$/, "");
      if (!inBlock) {
        if (HEADER.test(body)) {
          sawHeader = true;
          inBlock = true;
        }
        continue;
      }
      if (CLOSE.test(body)) {
        inBlock = false;
        continue;
      }
      const span = valueSpan(body);
      if (span === null) continue;
      if (spans.has(span.key)) {
        // Which one the game reads is not something this daemon can know, so
        // it refuses to guess. Refusing to edit is recoverable; editing the
        // wrong one of two lines is not.
        throw new Error(
          `worldSettings.cfg declares "${span.key}" more than once (lines ` +
            `${(spans.get(span.key) as Span).line + 1} and ${i + 1}). Refusing to guess which ` +
            `one the game reads.`,
        );
      }
      span.line = i;
      spans.set(span.key, span);
    }
    if (!sawHeader) {
      throw new Error(
        `worldSettings.cfg has no "WORLDSETTINGS = {" line, so it is not a world settings ` +
          `file this daemon recognises. Refusing to edit it.`,
      );
    }
    return new WorldSettingsFile(lines, spans);
  }

  /** The file's exact current text. With no edits applied, the input verbatim. */
  text(): string {
    return this.lines.join("");
  }

  /** Every key in the block, in the order the file declares them. */
  keys(): string[] {
    return [...this.spans.keys()];
  }

  /** Every key with its raw value text, in file order. */
  entries(): { key: string; value: string }[] {
    return [...this.spans.values()].map((s) => ({
      key: s.key,
      value: this.lines[s.line].slice(s.start, s.end),
    }));
  }

  has(key: string): boolean {
    return this.spans.has(key);
  }

  /** The raw value text exactly as the file spells it, or undefined if absent. */
  get(key: string): string | undefined {
    const s = this.spans.get(key);
    return s === undefined ? undefined : this.lines[s.line].slice(s.start, s.end);
  }

  /**
   * Replaces one existing key's value and nothing else on its line. Throws
   * rather than appending when the key is absent - see the file header for why
   * adding a key is not something this type is allowed to do.
   */
  set(key: string, value: string): void {
    const s = this.spans.get(key);
    if (s === undefined) {
      throw new Error(
        `worldSettings.cfg has no "${key}" line. This daemon only ever changes a value that ` +
          `is already there; it never adds a field the game left out.`,
      );
    }
    // A value carrying a newline, a comma or a comment marker would not change
    // one value - it would restructure the block. Callers pass values built by
    // the schema, so this is defence in depth rather than a live path, but it
    // is the last point where the damage is still preventable.
    if (/[\r\n]/.test(value) || value.includes(",") || value.includes("//")) {
      throw new Error(`Refusing to write "${key}": a value may not contain a newline, a comma, or "//".`);
    }
    const line = this.lines[s.line];
    this.lines[s.line] = line.slice(0, s.start) + value + line.slice(s.end);
    // Only this key's own line moved, and no two keys share a line, so no
    // other span needs adjusting.
    s.end = s.start + value.length;
  }
}
