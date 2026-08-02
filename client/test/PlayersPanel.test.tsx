import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PlayersPanel } from "../src/PlayersPanel";
import type { PlayerEntry } from "../src/types";

const jeff: PlayerEntry = {
  auth: "76561198048435182",
  name: "Jeff",
  slot: 1,
  latency: 42,
  level: "surface",
  joinedAt: new Date(Date.now() - 3_600_000).toISOString(),
};

describe("PlayersPanel", () => {
  it("lists who is on, with their slot and latency", () => {
    render(<PlayersPanel players={[jeff]} running={true} onRefresh={vi.fn()} />);
    expect(screen.getByText("Jeff")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.getByText("42 ms")).toBeInTheDocument();
    expect(screen.getByText("surface")).toBeInTheDocument();
  });

  it("counts the players in the heading", () => {
    render(<PlayersPanel players={[jeff]} running={true} onRefresh={vi.fn()} />);
    expect(screen.getByRole("heading", { name: /players \(1\)/i })).toBeInTheDocument();
  });

  it("says nobody is on rather than showing an empty table", () => {
    render(<PlayersPanel players={[]} running={true} onRefresh={vi.fn()} />);
    expect(screen.getByText(/no players online/i)).toBeInTheDocument();
  });

  // Two different facts that would otherwise look identical, because the daemon
  // empties the roster when the server exits.
  it("says the server is stopped, which is not the same as nobody being on", () => {
    render(<PlayersPanel players={[]} running={false} onRefresh={vi.fn()} />);
    expect(screen.getByText(/server is stopped/i)).toBeInTheDocument();
    expect(screen.queryByText(/no players online/i)).not.toBeInTheDocument();
  });

  it("shows a session length when the daemon saw the join", () => {
    render(<PlayersPanel players={[jeff]} running={true} onRefresh={vi.fn()} />);
    expect(screen.getByText("1h 0m")).toBeInTheDocument();
  });

  // The honest gap: a player discovered by a /players reconcile has no known
  // join time, and dating one from daemon start would read as playtime.
  it("shows a dash rather than inventing a session length", () => {
    render(<PlayersPanel players={[{ ...jeff, joinedAt: null }]} running={true} onRefresh={vi.fn()} />);
    expect(screen.getByText("-")).toBeInTheDocument();
    expect(screen.queryByText(/0m$/)).not.toBeInTheDocument();
  });

  it("shows a dash for a latency it has not been told", () => {
    render(<PlayersPanel players={[{ ...jeff, latency: null }]} running={true} onRefresh={vi.fn()} />);
    expect(screen.queryByText(/ms/)).not.toBeInTheDocument();
  });

  it("falls back to the auth when the name is not known yet", () => {
    render(<PlayersPanel players={[{ ...jeff, name: "" }]} running={true} onRefresh={vi.fn()} />);
    expect(screen.getByText("76561198048435182")).toBeInTheDocument();
  });

  it("refreshes on request", async () => {
    const onRefresh = vi.fn();
    render(<PlayersPanel players={[jeff]} running={true} onRefresh={onRefresh} />);
    await userEvent.click(screen.getByRole("button", { name: /refresh/i }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("cannot ask a stopped server who is online", () => {
    render(<PlayersPanel players={[]} running={false} onRefresh={vi.fn()} />);
    expect(screen.getByRole("button", { name: /refresh/i })).toBeDisabled();
  });
});
