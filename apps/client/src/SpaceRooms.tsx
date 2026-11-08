import { useEffect, useRef, useState } from "react";
import { api, errorText } from "./api";

interface ChildRoom {
  id: string;
  name: string;
  joined: boolean;
}
interface Props {
  id: string;
  onOpen: (id: string) => void;
  onJoined: () => void;
}

export function SpaceRooms({ id, onOpen, onJoined }: Props) {
  const [rooms, setRooms] = useState<ChildRoom[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const generation = useRef(0);

  useEffect(() => {
    const epoch = ++generation.current;
    setRooms([]);
    setNext(null);
    setBusy(true);
    setError("");
    setNotice("");
    api
      .spaceRooms(id)
      .then((page) => {
        if (epoch !== generation.current) return;
        setRooms(page.rooms);
        setNext(page.nextBatch);
      })
      .catch((failure) => {
        if (epoch === generation.current) setError(errorText(failure));
      })
      .finally(() => {
        if (epoch === generation.current) setBusy(false);
      });
    return () => {
      generation.current++;
    };
  }, [id]);

  async function more() {
    if (busy) return;
    const epoch = generation.current;
    setBusy(true);
    setError("");
    try {
      const page = await api.spaceRooms(id, next);
      if (epoch !== generation.current) return;
      setRooms((old) => [
        ...new Map(
          [...old, ...page.rooms].map((room) => [room.id, room]),
        ).values(),
      ]);
      setNext(page.nextBatch);
    } catch (failure) {
      if (epoch === generation.current) setError(errorText(failure));
    } finally {
      if (epoch === generation.current) setBusy(false);
    }
  }

  async function join(roomId: string) {
    if (busy) return;
    const epoch = generation.current;
    setBusy(true);
    setError("");
    try {
      await api.join(roomId);
      if (epoch !== generation.current) return;
      setRooms((old) =>
        old.map((room) =>
          room.id === roomId ? { ...room, joined: true } : room,
        ),
      );
      setNotice("Joined. You can now open this room.");
      onJoined();
    } catch (failure) {
      if (epoch === generation.current) setError(errorText(failure));
    } finally {
      if (epoch === generation.current) setBusy(false);
    }
  }

  return (
    <div className="space-rooms">
      <h2>Rooms in this space</h2>
      <p className="muted">
        Choose a room to chat. Joining a space does not automatically join its
        rooms.
      </p>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {rooms.map((room) => (
        <div className="space-room" key={room.id}>
          <div>
            <strong>{room.name}</strong>
            <p className="room-id">{room.id}</p>
          </div>
          <button
            disabled={busy}
            onClick={() => (room.joined ? onOpen(room.id) : void join(room.id))}
          >
            {room.joined ? "Open" : "Join"}
          </button>
        </div>
      ))}
      {busy && <p role="status">Loading…</p>}
      {!busy && !rooms.length && !error && (
        <p>
          No rooms are visible to this account. A private room may need a
          separate invitation.
        </p>
      )}
      {!busy && (next || error) && (
        <button className="secondary" onClick={() => void more()}>
          {next ? "Load more" : "Retry"}
        </button>
      )}
    </div>
  );
}
