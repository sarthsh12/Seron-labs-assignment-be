// Escapes LIKE wildcards so a search for "50%" matches the literal text.
export const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => '\\' + c);
