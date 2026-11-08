// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import App from "./App";
import { api } from "./api";

vi.mock("./api", () => ({
  desktopAvailable: () => true,
  errorText: String,
  api: {
    status: vi.fn(),
    rooms: vi.fn(),
    messages: vi.fn(),
    send: vi.fn(),
    logout: vi.fn(),
  },
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("keeps the draft and transaction ID when sign-out fails after an uncertain send", async () => {
  vi.mocked(api.status).mockResolvedValue({
    authenticated: true,
    syncing: true,
    userId: "@test:example.org",
  });
  vi.mocked(api.rooms).mockResolvedValue([
    {
      id: "!room:example.org",
      name: "Test room",
      joined: true,
      encrypted: false,
      encryptionKnown: true,
    },
  ]);
  vi.mocked(api.messages).mockResolvedValue([]);
  vi.mocked(api.send).mockRejectedValue("Connection lost");
  vi.mocked(api.logout).mockRejectedValue("Server unavailable");
  render(<App />);
  const composer = await screen.findByRole("textbox", { name: "Message" });
  fireEvent.change(composer, { target: { value: "Keep this draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await screen.findByText(/Connection lost/);
  const firstTransaction = vi.mocked(api.send).mock.calls[0][2];
  fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
  const restored = await screen.findByRole("textbox", { name: "Message" });
  expect((restored as HTMLTextAreaElement).value).toBe("Keep this draft");
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(api.send).toHaveBeenCalledTimes(2));
  expect(vi.mocked(api.send).mock.calls[1][2]).toBe(firstTransaction);
});
