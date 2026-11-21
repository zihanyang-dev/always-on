export type PageCursor = { time: string; id: string };
export type PageRequest = { limit: number; cursor?: PageCursor | undefined };
export type Page<T> = { items: T[]; nextCursor: string | null };

export function makePage<T>(
  rows: T[],
  limit: number,
  key: (row: T) => { time: Date; id: string },
): Page<T> {
  if (rows.length <= limit) return { items: rows, nextCursor: null };

  const items = rows.slice(0, limit);
  const last = items.at(-1);
  if (!last) throw new Error('Page limit must be positive');

  const { time, id } = key(last);
  const nextCursor = Buffer.from(JSON.stringify({ time: time.toISOString(), id })).toString(
    'base64url',
  );
  return { items, nextCursor };
}
