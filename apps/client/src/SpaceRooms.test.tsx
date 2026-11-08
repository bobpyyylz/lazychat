// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { SpaceRooms } from "./SpaceRooms";
import { api } from "./api";

vi.mock("./api", () => ({
  api: { spaceRooms: vi.fn(), join: vi.fn() },
  errorText: String,
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const room = { id: "!child:test", name: "Child room", joined: false };

it("opens a room after joining without reopening the space", async () => {
  vi.mocked(api.spaceRooms).mockResolvedValue({
    rooms: [room],
    nextBatch: null,
  });
  vi.mocked(api.join).mockResolvedValue(room.id);
  const onOpen = vi.fn();
  render(<SpaceRooms id="!space:test" onOpen={onOpen} onJoined={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Join" }));
  const open = await screen.findByRole("button", { name: "Open" });
  await waitFor(() => expect((open as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(open);
  expect(onOpen).toHaveBeenCalledWith(room.id);
});

it("does not report a completed join to an unmounted account view", async () => {
  vi.mocked(api.spaceRooms).mockResolvedValue({
    rooms: [room],
    nextBatch: null,
  });
  let finish!: (value: unknown) => void;
  vi.mocked(api.join).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const onJoined = vi.fn();
  const view = render(
    <SpaceRooms id="!space:test" onOpen={vi.fn()} onJoined={onJoined} />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Join" }));
  view.unmount();
  await act(async () => {
    finish(room.id);
  });
  expect(onJoined).not.toHaveBeenCalled();
});

it("ignores a hierarchy response from the previously selected space", async () => {
  let finish!: (value: { rooms: (typeof room)[]; nextBatch: null }) => void;
  vi.mocked(api.spaceRooms)
    .mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    )
    .mockResolvedValueOnce({
      rooms: [{ ...room, name: "Current room" }],
      nextBatch: null,
    });
  const view = render(
    <SpaceRooms id="!old:test" onOpen={vi.fn()} onJoined={vi.fn()} />,
  );
  view.rerender(
    <SpaceRooms id="!new:test" onOpen={vi.fn()} onJoined={vi.fn()} />,
  );
  await screen.findByText("Current room");
  await act(async () => {
    finish({ rooms: [room], nextBatch: null });
  });
  expect(screen.queryByText("Child room")).toBeNull();
});
