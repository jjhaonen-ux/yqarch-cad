/** Registers every engine command. */
import { DRAW_COMMANDS } from './draw';
import { ANNOTATE_COMMANDS } from './annotate';
import { MODIFY_COMMANDS } from './modify';
import { MODIFY_3B_COMMANDS } from './modify3b';
import { SYSTEM_COMMANDS } from './system';
import { YQ_COMMANDS } from './yq';
import type { CommandDef, CommandEngine } from './engine';

export const ALL_COMMANDS: CommandDef[] = [...DRAW_COMMANDS, ...ANNOTATE_COMMANDS, ...MODIFY_COMMANDS, ...MODIFY_3B_COMMANDS, ...SYSTEM_COMMANDS, ...YQ_COMMANDS];
export function registerAll(c: CommandEngine) { c.register(...ALL_COMMANDS); return c; }
export * from './engine';
export { AliasResolver, BUILTIN_ALIASES } from './aliases';
