// ═══════════════════════════════════════════════════════════════════════════
//
//   Bumper Cars — Player List
//
//   Shows active players in the arena with their color dot and name.
//
//   Ported from vendor/loro-extended/examples/bumper-cars/src/client/components/player-list.tsx
//   with vendor PeerID type replaced by plain string.
//
// ═══════════════════════════════════════════════════════════════════════════

type Player = {
  peerId: string
  name: string
  color: string
}

type PlayerListProps = {
  players: Player[]
  myPeerId: string
}

export function PlayerList({ players, myPeerId }: PlayerListProps) {
  if (players.length === 0) {
    return null
  }

  return (
    <div className="player-list">
      <div className="player-list-title">Active Players</div>
      {players.map(player => (
        <div key={player.peerId} className="player-list-item">
          <div
            className="player-color-dot"
            style={{ backgroundColor: player.color }}
          />
          <span>
            {player.name}
            {player.peerId === myPeerId && " (you)"}
          </span>
        </div>
      ))}
    </div>
  )
}