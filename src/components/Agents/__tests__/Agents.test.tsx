// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
const mocks = vi.hoisted(() => ({
  token: "account-a", catalog: vi.fn(), conversation: vi.fn(), submit: vi.fn(), result: vi.fn(), upload: vi.fn(),
}));
vi.mock("../../../context/CredentialContext", () => ({ useCredential: () => ({ credential: { kind: "oauth", token: mocks.token }, getCredential: vi.fn(), refreshCredential: vi.fn() }) }));
vi.mock("@api/agents/client", async original => ({ ...await original<typeof import("@api/agents/client")>(), createAgentsClient: () => mocks }));
vi.mock("../canvasBridge", () => ({ requestCanvas: vi.fn(async () => ({ editor: "figjam" })) }));
import Agents from "../Agents";
const catalog = [{ id: "aura", name: "Aura", role: "Creative director", description: "Ideas" }, { id: "style-remix", name: "Mila", role: "Art director", description: "Styles" }];

describe("Agents conversations", () => {
  beforeEach(() => {
    vi.clearAllMocks(); mocks.token = "account-a";
    mocks.catalog.mockResolvedValue(catalog);
    mocks.conversation.mockImplementation(async (id: string) => `conversation-${id}`);
    mocks.submit.mockResolvedValue("task-a");
    mocks.result.mockResolvedValue({ messages: ["A creative idea"], assets: [], plans: [], questions: [] });
  });
  afterEach(cleanup);
  const enter = async (text: string) => {
    const prompt = await screen.findByRole("textbox", { name: "Message Aura" });
    fireEvent.change(prompt, { target: { value: text } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  };
  const choose = async (name: string) => {
    fireEvent.click(screen.getByRole("button", { name: "Change agent" }));
    fireEvent.click(screen.getByRole("button", { name: new RegExp(name + ".*director") }));
  };
  it("keeps each agent's conversation and draft separate", async () => {
    render(<Agents onSignIn={vi.fn()} />);
    await enter("A campaign direction");
    await screen.findByText("A creative idea");
    expect(mocks.submit).toHaveBeenCalledWith("conversation-aura", "A campaign direction", [], expect.anything());
    await choose("Mila");
    expect(screen.queryByText("A creative idea")).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "Message Mila" }), { target: { value: "Mila's draft" } });
    await choose("Aura");
    expect(screen.getByText("A creative idea")).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Message Aura" }) as HTMLTextAreaElement).value).toBe("");
    await choose("Mila");
    expect((screen.getByRole("textbox", { name: "Message Mila" }) as HTMLTextAreaElement).value).toBe("Mila's draft");
  });
  it("clears chat state when the signed-in account changes", async () => {
    const view = render(<Agents onSignIn={vi.fn()} />);
    await enter("Private account A prompt");
    await screen.findByText("A creative idea");
    mocks.token = "account-b";
    view.rerender(<Agents onSignIn={vi.fn()} />);
    await screen.findByRole("textbox", { name: "Message Aura" });
    expect(screen.queryByText("Private account A prompt")).toBeNull();
  });
  it("locks an uncertain submission until the user acknowledges checking Picsart", async () => {
    mocks.submit.mockRejectedValueOnce(new Error("Network timeout"));
    render(<Agents onSignIn={vi.fn()} />);
    await enter("Generate an image");
    await screen.findByText(/Submission not confirmed/);
    expect((screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement).disabled).toBe(true);
    expect(mocks.submit).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "I've checked Picsart — start a new chat" }));
    expect((screen.getByRole("textbox", { name: "Message Aura" }) as HTMLTextAreaElement).disabled).toBe(false);
  });
  it("resumes polling the existing task after a poll failure", async () => {
    mocks.result.mockRejectedValueOnce(new Error("Temporary disconnect"));
    render(<Agents onSignIn={vi.fn()} />);
    await enter("Hello");
    fireEvent.click(await screen.findByRole("button", { name: "Check result" }));
    await screen.findByText("A creative idea");
    expect(mocks.submit).toHaveBeenCalledOnce();
    await waitFor(() => expect(mocks.result).toHaveBeenCalledTimes(2));
    expect(mocks.result.mock.calls.map(call => call[0])).toEqual(["task-a", "task-a"]);
  });
});
