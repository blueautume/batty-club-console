export function playerGenderLabel(gender: string | undefined): string {
  return gender === '男' ? '男' : gender === '女' ? '女' : '未注明';
}

export function playerGenderSymbol(gender: string | undefined): string {
  return gender === '男' ? '♂' : gender === '女' ? '♀' : '';
}

export function playerSelectionLabel(player: { name: string; gender?: string }): string {
  return `${player.name} · ${playerGenderSymbol(player.gender)}${playerGenderLabel(player.gender)}`;
}
