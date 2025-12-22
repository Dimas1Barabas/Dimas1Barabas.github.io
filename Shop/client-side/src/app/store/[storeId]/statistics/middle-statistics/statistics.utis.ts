import {Album, DollarSign, FolderKanban, type LucideIcon, Star} from 'lucide-react';

export function getIcon(id: number): LucideIcon {
  switch (id) {
    case 1:
    default:
      return DollarSign
    case 2:
      return FolderKanban
    case 3:
      return Album
    case 4:
      return Star
  }
}