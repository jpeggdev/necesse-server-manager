import { useState, type FormEvent } from "react";
import { baseUrl, decodeConnection, encodeConnection, type Connection } from "./settings";
import { DaemonError, UNAUTHORIZED_STATUS, makeApi } from "./api";

export interface ConnectionSettingsProps {
  /** null on first run, when there is nothing saved yet to edit or cancel back to. */
  initial: Connection | null;
  /**
   * Why the app sent the user here, when it was not the user's own doing.
   * Without it, a rejected token drops the connected app and lands on this
   * screen looking exactly like a voluntary visit - and the only way to learn
   * what happened is to guess that "Test connection" would say.
   */
  notice?: string | null;
  onSave: (c: Connection) => void;
  onCancel: () => void;
}

const DEFAULT_PORT = "8710";

/**
 * Host and port validity, shared by Connect and Test so the two can never
 * disagree about what counts as a usable address - Test used to run the raw,
 * untrimmed, unchecked fields, so a host with stray spaces or an empty port
 * could test a different (and nonsensical) URL than Connect would ever save.
 */
function validateConnection(host: string, portText: string): string | null {
  if (host.trim().length === 0) return "Host is required.";
  const p = Number(portText);
  if (!Number.isInteger(p) || p < 1 || p > 65535) {
    return "Port must be a whole number between 1 and 65535.";
  }
  return null;
}

/**
 * Where the app is told which daemon to talk to, replacing every compiled-in
 * address. Shown full-screen in place of the app (first run, or no saved
 * connection) or over it (re-editing after a rejected token).
 */
export function ConnectionSettings({
  initial,
  notice = null,
  onSave,
  onCancel,
}: ConnectionSettingsProps) {
  const [host, setHost] = useState(initial?.host ?? "");
  const [port, setPort] = useState(initial ? String(initial.port) : DEFAULT_PORT);
  // An empty token is a valid, supported configuration - it means the daemon
  // was set up with authentication disabled - so it is never treated as an
  // incomplete field the way an empty host is.
  const [token, setToken] = useState(initial?.token ?? "");
  const [showToken, setShowToken] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [pasteText, setPasteText] = useState("");
  const [pasteError, setPasteError] = useState<string | null>(null);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const err = validateConnection(host, port);
    if (err !== null) {
      setFormError(err);
      return;
    }
    setFormError(null);
    onSave({ host: host.trim(), port: Number(port), token });
  };

  /**
   * Runs the exact request the app itself would make once connected, so a
   * closed port, a wrong host and a rejected token each fail here the same way
   * they would after Connect - rather than a ping that could pass while the
   * real API call still fails. DaemonError vs. everything else is what tells a
   * reached-but-rejected daemon apart from one that could not be reached at
   * all; those need completely different fixes from the operator.
   *
   * Validated with the same rule Connect uses, and BEFORE attempting anything:
   * an empty port coerces to 0, which would silently test `http://h:0` and
   * report "could not reach" for a problem that is actually "you left the
   * port blank" - a different fix entirely.
   */
  const onTest = async () => {
    const err = validateConnection(host, port);
    if (err !== null) {
      setTestResult(err);
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const api = makeApi(baseUrl({ host: host.trim(), port: Number(port), token }), token);
      await api.status();
      setTestResult("Connected.");
    } catch (e) {
      if (e instanceof DaemonError && e.status === UNAUTHORIZED_STATUS) {
        setTestResult(`This daemon rejected the token: ${e.message}`);
      } else {
        setTestResult((e as Error).message);
      }
    } finally {
      setTesting(false);
    }
  };

  // Reported through the same status line Test uses, rather than left silent,
  // so a browser/window with no clipboard access says so instead of leaving
  // the operator wondering whether Copy did anything at all.
  const onCopy = () => {
    if (!navigator.clipboard) {
      setTestResult("Clipboard access is not available in this window.");
      return;
    }
    navigator.clipboard
      .writeText(encodeConnection({ host: host.trim(), port: Number(port) || 0, token }))
      .then(() => setTestResult("Copied to clipboard."))
      .catch((e: Error) => setTestResult(`Could not copy to clipboard: ${e.message}`));
  };

  const onApplyPasted = () => {
    const decoded = decodeConnection(pasteText);
    if (decoded === null) {
      setPasteError("That doesn't look like a connection - paste the text produced by Copy.");
      return;
    }
    setPasteError(null);
    setHost(decoded.host);
    setPort(String(decoded.port));
    setToken(decoded.token);
  };

  return (
    <div className="connection-settings">
      <h1>Connect to a daemon</h1>
      {notice !== null && (
        <p role="alert" className="hint hint-bad">
          {notice}
        </p>
      )}
      <form onSubmit={onSubmit}>
        <label htmlFor="conn-host">Host</label>
        <input id="conn-host" type="text" value={host} onChange={(e) => setHost(e.target.value)} />

        <label htmlFor="conn-port">Port</label>
        <input id="conn-port" type="number" value={port} onChange={(e) => setPort(e.target.value)} />

        <label htmlFor="conn-token">Access token</label>
        <div className="conn-token-row">
          <input
            id="conn-token"
            type={showToken ? "text" : "password"}
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
          <button type="button" onClick={() => setShowToken((s) => !s)}>
            {showToken ? "Hide" : "Show"}
          </button>
        </div>

        {formError !== null && (
          <p role="alert" className="hint hint-bad">
            {formError}
          </p>
        )}

        <div className="conn-actions">
          <button type="submit">{initial === null ? "Connect" : "Save"}</button>
          <button type="button" onClick={() => void onTest()} disabled={testing}>
            {testing ? "Testing…" : "Test connection"}
          </button>
          {initial !== null && (
            <button type="button" onClick={onCancel}>
              Cancel
            </button>
          )}
        </div>

        {testResult !== null && (
          <p role="status" className="hint">
            {testResult}
          </p>
        )}
      </form>

      <div className="conn-share">
        <button type="button" onClick={onCopy}>
          Copy
        </button>
        <label htmlFor="conn-paste">Paste connection details</label>
        <textarea
          id="conn-paste"
          value={pasteText}
          onChange={(e) => setPasteText(e.target.value)}
        />
        <button type="button" onClick={onApplyPasted}>
          Apply pasted
        </button>
        {pasteError !== null && (
          <p role="alert" className="hint hint-bad">
            {pasteError}
          </p>
        )}
      </div>
    </div>
  );
}
