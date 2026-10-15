export function readStdin(): string;
export function log(entry: unknown): void;
export function argValue(argv: string[], flag: string): string | undefined;
export function criteriaFrom(prompt: string): string[];
export function outputFor(schema: unknown, prompt: string): Record<string, unknown>;
export function sleep(ms: number): Promise<void>;
