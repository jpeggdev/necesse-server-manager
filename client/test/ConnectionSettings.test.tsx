import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConnectionSettings } from "../src/ConnectionSettings";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const ok = () =>
  Promise.resolve({ ok: true, status: 200, statusText: "OK", json: () => Promise.resolve({}) });

describe("ConnectionSettings", () => {
  it("saves the entered host, port and token", async () => {
    const onSave = vi.fn();
    render(<ConnectionSettings initial={null} onSave={onSave} onCancel={() => {}} />);
    await userEvent.type(screen.getByLabelText(/host/i), "192.168.1.106");
    await userEvent.clear(screen.getByLabelText(/port/i));
    await userEvent.type(screen.getByLabelText(/port/i), "8710");
    await userEvent.type(screen.getByLabelText(/token/i), "s3cret");
    await userEvent.click(screen.getByRole("button", { name: /^(connect|save)$/i }));
    expect(onSave).toHaveBeenCalledWith({ host: "192.168.1.106", port: 8710, token: "s3cret" });
  });

  it("refuses to save an empty host", async () => {
    const onSave = vi.fn();
    render(<ConnectionSettings initial={null} onSave={onSave} onCancel={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: /^(connect|save)$/i }));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/host/i);
  });

  it("reports a successful test connection", async () => {
    fetchMock.mockImplementation(ok);
    render(
      <ConnectionSettings
        initial={{ host: "h", port: 8710, token: "" }}
        onSave={() => {}}
        onCancel={() => {}}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /^test/i }));
    expect(await screen.findByRole("status")).toHaveTextContent(/connected/i);
  });

  // The mocked daemon message deliberately says nothing about tokens, so this
  // only passes if the component's own 401 handling supplies that word - a
  // daemon message that happened to mention "token" itself would let this
  // pass with no such branch at all (see task-9-report.md, Finding B).
  it("distinguishes a rejected token from an unreachable daemon", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      json: () => Promise.resolve({ error: "Access denied." }),
    });
    render(
      <ConnectionSettings
        initial={{ host: "h", port: 8710, token: "bad" }}
        onSave={() => {}}
        onCancel={() => {}}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /^test/i }));
    expect(await screen.findByRole("status")).toHaveTextContent(/rejected the token/i);
  });

  it("reports an unreachable daemon distinctly", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    render(
      <ConnectionSettings
        initial={{ host: "h", port: 8710, token: "" }}
        onSave={() => {}}
        onCancel={() => {}}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /^test/i }));
    expect(await screen.findByRole("status")).toHaveTextContent(/could not reach/i);
  });

  // The fourth outcome: reached, but refused for a reason that has nothing to
  // do with the token (a 500, a misconfigured daemon, whatever). This must
  // show the daemon's own message plainly - never the 401 "rejected the
  // token" wording, which would misdirect the fix.
  it("shows the daemon's own message for a non-401 failure", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      json: () => Promise.resolve({ error: "boom" }),
    });
    render(
      <ConnectionSettings
        initial={{ host: "h", port: 8710, token: "" }}
        onSave={() => {}}
        onCancel={() => {}}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /^test/i }));
    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("boom");
    expect(status).not.toHaveTextContent(/rejected the token/i);
  });

  it("pastes a connection blob into the fields", async () => {
    const onSave = vi.fn();
    render(<ConnectionSettings initial={null} onSave={onSave} onCancel={() => {}} />);
    const blob = JSON.stringify({ host: "pasted", port: 9000, token: "tok" });
    await userEvent.click(screen.getByLabelText(/paste/i));
    await userEvent.paste(blob);
    await userEvent.click(screen.getByRole("button", { name: /apply pasted/i }));
    expect(screen.getByLabelText(/host/i)).toHaveValue("pasted");
    expect(screen.getByLabelText(/port/i)).toHaveValue(9000);
  });

  it("validates the same way Test connection would as Connect, rather than testing a nonsense URL", async () => {
    render(
      <ConnectionSettings
        initial={{ host: "h", port: 8710, token: "" }}
        onSave={() => {}}
        onCancel={() => {}}
      />,
    );
    await userEvent.clear(screen.getByLabelText(/port/i));
    await userEvent.click(screen.getByRole("button", { name: /^test/i }));
    expect(await screen.findByRole("status")).toHaveTextContent(/port/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports through the status line when the clipboard is unavailable", async () => {
    render(<ConnectionSettings initial={null} onSave={() => {}} onCancel={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: /^copy$/i }));
    expect(await screen.findByRole("status")).toHaveTextContent(/clipboard/i);
  });
});
