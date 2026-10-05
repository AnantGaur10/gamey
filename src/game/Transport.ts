// Multiplayer-client seam (stub only; no netcode in v1).
// Pure command envelope; LocalTransport routes AI as the remote peer.
// Later CrazyRoomTransport maps CG Update Room / isJoinable / inviteParams /
// Invite Link / InstantMultiplayer onto the same cmds.
export type DuelCmd =
  | { type: "FocusTap"; tick: number; pad: string }
  | { type: "Draw" }
  | { type: "Fire"; tick: number; pos: [number, number, number]; dir: [number, number, number]; gunId: string }
  | { type: "Hit"; tick: number; head: boolean; damage: number };

export interface Transport {
  send(cmd: DuelCmd): void;
  onCmd(cb: (cmd: DuelCmd) => void): void;
}

export class LocalTransport implements Transport {
  private cbs: Array<(cmd: DuelCmd) => void> = [];
  send(cmd: DuelCmd): void {
    for (const cb of this.cbs) cb(cmd);
  }
  onCmd(cb: (cmd: DuelCmd) => void): void {
    this.cbs.push(cb);
  }
}
