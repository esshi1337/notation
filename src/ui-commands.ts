import type { CommandId } from './shortcuts';

export type CommandItem = {
  id: CommandId; label: string; group: string; shortcut: string;
  disabled?: boolean; checked?: boolean;
};
